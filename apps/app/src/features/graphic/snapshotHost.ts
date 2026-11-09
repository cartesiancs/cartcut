/**
 * The snapshot host: HTML graphics in every browser html-in-canvas does not
 * draw in, which is Safari, Firefox and every Chrome before 157 the editor
 * runs on (85 and later).
 *
 * The tree, its state and its settle are `graphicDom.ts`'s, shared with the
 * html-in-canvas host, so the live mount here is the same graphic at the same
 * moment. It is drawn by writing it out as an SVG image of itself and letting
 * the browser's own engine paint that image, which keeps every filter, mask,
 * blend and 3D transform the engine has. Every rule below is a measurement
 * from `tests/spikes/snapshot/` (`tests/e2e/FINDINGS.md` section 11):
 *
 *  - **Hidden with `opacity: 0` under an ordinary `div`.** Nothing here is
 *    painted from the page, so the canvas host's reasons do not apply; under a
 *    canvas the tree would be fallback content and might not lay out at all.
 *  - **Time is carried, not copied.** Every animation is written paused with
 *    its delay shifted by `-t`, every SMIL `begin` likewise
 *    (`snapshot/snapshotTime.ts`), and the image evaluates them itself.
 *  - **A `data:` URL**, so the canvas stays readable (`snapshotDocument.ts`).
 *  - **Drawn inside `settle`, onto a scratch canvas**, and only copied by
 *    `rasterize`: Firefox rasterises an SVG image at `drawImage` (69 ms for a
 *    heavy 1080p frame), and `rasterize` is synchronous. The copy is what keeps
 *    `rasterize` the only writer of the canvas the preview may be showing.
 *  - **The engine's known faults are worked around only where its probe drew
 *    them** (`snapshotSupport`), never by user agent.
 */

import type { HtmlRasterPort } from "./htmlRasterPort";
import {
  BASE_CSS,
  computedFaces,
  LiveGraphicHost,
  LOAD_TIMEOUT_MS,
  withTimeout,
  type LiveMount,
} from "./graphicDom";
import { NO_QUIRKS, type SnapshotQuirks } from "./graphicBackend";
import {
  cssUrls,
  negateShadowsInStyle,
  negateShadowsInStylesheet,
  rewriteCssUrls,
  scopeStylesheet,
} from "./snapshot/snapshotCss";
import { serializeNode, SVG_NS, type NodeLike } from "./snapshot/snapshotMarkup";
import { insetOnly, parseComputedShadows, shadowFilter } from "./snapshot/snapshotShadows";
import {
  appendStyle,
  clearBox,
  cornerOf,
  degrees,
  integerProperties,
  localUrls,
  maskRules,
  roundedInteger,
  STRONG,
} from "./snapshot/snapshotStyle";
import { expandInsetInStylesheet, needsInsetLonghands } from "./cssCompat";
import { shiftedDelays, shiftSmilBegin } from "./snapshot/snapshotTime";
import { snapshotSvg, svgDataUrl } from "./snapshot/snapshotDocument";
import { fontFaceCss } from "./snapshot/snapshotFonts";
import { harvestCodepoints } from "../font/fontPlan";
import type { MountSpec } from "./htmlRasterPort";

type SnapshotState = {
  /** What `rasterize` hands out: the mount's own canvas, redrawn in place. */
  output: HTMLCanvasElement;
  /** Where `settle` draws the decoded image. */
  scratch: HTMLCanvasElement | null;
  /** Whether `scratch` holds this settle's picture. */
  ready: boolean;
};

const SMIL = new Set(["animate", "set", "animateTransform", "animateMotion"]);
const PSEUDOS = ["::before", "::after"];
/** Stands in for a URL in a captured attribute until its `data:` form is in hand. */
const URL_TOKEN = /cc-url-\d+/g;

/** One element whose text Gecko will not clip a background to, and the image that masks it instead. */
type TextMask = {
  token: string;
  mark: string;
  /** The whole graphic again, everything hidden but this element's text. */
  body: string;
  crop: { x: number; y: number; width: number; height: number };
};

/** What the live mount says about one frame, read in one synchronous pass. */
type Capture = {
  body: string;
  pseudoRules: string[];
  /** Token to absolute URL. */
  urls: Map<string, string>;
  masks: TextMask[];
  families: string[];
  texts: string[];
  lang: string;
  dir: string;
};

const MASK_TOKEN = /cc-mask-\d+/g;

/** An element's own 3D transform from computed style: `rotate`, then `transform`. */
function ownMatrix(style: CSSStyleDeclaration): DOMMatrix {
  let matrix = new DOMMatrix();
  const rotate = (style as CSSStyleDeclaration & { rotate?: string }).rotate ?? "none";
  if (rotate !== "none" && rotate !== "") {
    const parts = rotate.trim().split(/\s+/);
    const angle = degrees(parts[parts.length - 1]);
    if (parts.length === 1) {
      matrix = matrix.rotateAxisAngle(0, 0, 1, angle);
    } else if (parts.length === 2) {
      const axis = parts[0];
      matrix = matrix.rotateAxisAngle(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0, angle);
    } else if (parts.length === 4) {
      matrix = matrix.rotateAxisAngle(Number(parts[0]), Number(parts[1]), Number(parts[2]), angle);
    }
  }
  if (style.transform !== "" && style.transform !== "none") {
    try {
      matrix = matrix.multiply(new DOMMatrix(style.transform));
    } catch {
      // A transform DOMMatrix cannot read draws as it is.
    }
  }
  return matrix;
}

/**
 * Whether an element is turned away from the viewer: its transform, composed
 * with every ancestor's while they keep a 3D context, puts its front face's
 * normal pointing away (`m33 < 0`). For engines that draw back faces anyway.
 */
function facingAway(element: Element): boolean {
  let matrix = ownMatrix(getComputedStyle(element));
  let parent = element.parentElement;
  while (parent != null) {
    const style = getComputedStyle(parent);
    if (style.transformStyle !== "preserve-3d") {
      break;
    }
    matrix = ownMatrix(style).multiply(matrix);
    parent = parent.parentElement;
  }
  return matrix.m33 < 0;
}


const fetched = new Map<string, Promise<string | null>>();

/** A URL's bytes as a `data:` URL, once per URL. */
function dataUrlOf(url: string): Promise<string | null> {
  if (/^data:/i.test(url)) {
    return Promise.resolve(url);
  }
  let hit = fetched.get(url);
  if (hit == null) {
    hit = fetch(url)
      .then((response) => (response.ok ? response.blob() : null))
      .then(
        (blob) =>
          blob == null
            ? null
            : new Promise<string | null>((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
              }),
      )
      .catch(() => null);
    fetched.set(url, hit);
  }
  return hit;
}

function absolute(url: string): string | null {
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return null;
  }
}

const programSheets = new Map<string, Promise<string>>();

/** A program's sheet with the base sheet, scoped and with every `url()` carried. Once per program. */
function programCss(spec: MountSpec, flipShadows: boolean): Promise<string> {
  const key = spec.programKey + (flipShadows ? "|flip" : "");
  let hit = programSheets.get(key);
  if (hit == null) {
    hit = (async () => {
      const program = needsInsetLonghands() ? expandInsetInStylesheet(spec.css) : spec.css;
      let css = scopeStylesheet(BASE_CSS) + "\n" + scopeStylesheet(program);
      if (flipShadows) {
        css = negateShadowsInStylesheet(css);
      }
      const answers = new Map<string, string | null>();
      await Promise.all(
        cssUrls(css).map(async (raw) => {
          const url = absolute(raw);
          answers.set(raw, url == null ? null : await dataUrlOf(url));
        }),
      );
      return rewriteCssUrls(css, (raw) => answers.get(raw) ?? null);
    })();
    programSheets.set(key, hit);
  }
  return hit;
}

function decode(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("the snapshot did not decode"));
    image.src = url;
  }).then(async (img) => {
    // `onload` can come before the image is ready to draw; `decode` cannot.
    if (typeof img.decode === "function") {
      await img.decode().catch(() => undefined);
    }
    return img;
  });
  return withTimeout(loaded, LOAD_TIMEOUT_MS).then((img) => {
    if (img == null) {
      throw new Error("the snapshot took too long to decode");
    }
    return img;
  });
}

function yieldFrame(): Promise<void> {
  // A message, not a timer: a background tab clamps timers to a second.
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

/** A small, cheap fingerprint of what a canvas shows, to tell two draws apart. */
function fingerprint(source: CanvasImageSource, width: number, height: number): string {
  const probe = document.createElement("canvas");
  probe.width = 32;
  probe.height = 32;
  const ctx = probe.getContext("2d");
  if (ctx == null) {
    return "";
  }
  ctx.drawImage(source, 0, 0, width, height, 0, 0, 32, 32);
  const data = ctx.getImageData(0, 0, 32, 32).data;
  let hash = 0;
  for (let i = 0; i < data.length; i += 1) {
    hash = (hash * 31 + data[i]) | 0;
  }
  return String(hash);
}

export class SnapshotHost extends LiveGraphicHost<SnapshotState> implements HtmlRasterPort {
  private reported = new Set<string>();

  constructor(private readonly quirks: SnapshotQuirks = NO_QUIRKS) {
    super();
  }

  supported(): boolean {
    return true;
  }

  protected createHost(instanceId: string): {
    host: HTMLElement;
    outer: HTMLDivElement;
    x: SnapshotState;
  } {
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.dataset.graphicHost = instanceId;
    host.style.cssText =
      "position:fixed;left:0;top:0;opacity:0;pointer-events:none;z-index:-1;overflow:hidden;";
    const outer = document.createElement("div");
    host.appendChild(outer);
    return { host, outer, x: { output: document.createElement("canvas"), scratch: null, ready: false } };
  }

  protected sizeHost(mount: LiveMount<SnapshotState>, width: number, height: number): void {
    mount.host.style.width = width + "px";
    mount.host.style.height = height + "px";
  }

  private rasterOf(mount: LiveMount<SnapshotState>): { width: number; height: number } {
    if (mount.raster != null && mount.raster.width > 0 && mount.raster.height > 0) {
      return mount.raster;
    }
    return {
      width: Math.max(1, Math.ceil(mount.layoutBox.width + 2 * mount.bleed)),
      height: Math.max(1, Math.ceil(mount.layoutBox.height + 2 * mount.bleed)),
    };
  }

  /** Everything the frame needs from the live mount, read without awaiting anything. */
  private capture(mount: LiveMount<SnapshotState>): Capture {
    const t = mount.timeMs;
    const quirks = this.quirks;
    const pseudoRules: string[] = [];
    const urls = new Map<string, string>();
    const defs: string[] = [];
    const clipped: HTMLElement[] = [];
    let marks = 0;
    const token = (raw: string): string | null => {
      const url = absolute(raw);
      if (url == null) {
        return null;
      }
      const name = `cc-url-${urls.size}`;
      urls.set(name, url);
      return name;
    };

    /**
     * What every copy of the tree carries: animations held at t, URLs as
     * tokens, and the shadow flip. Returns the attributes and the element's
     * computed style, or `null` for a SMIL element already handled.
     */
    const base = (element: Element, attrs: Array<[string, string]>, extra: string) => {
      const out = attrs.slice();
      const own = getComputedStyle(element);
      let more = extra;
      if (own.animationName !== "" && own.animationName !== "none") {
        const delays = shiftedDelays(own.animationDelay, t);
        if (delays != null) {
          more += `animation-delay:${delays} !important;`;
        }
      }
      let mark: string | null = null;
      for (const pseudo of PSEUDOS) {
        const style = getComputedStyle(element, pseudo);
        if (style.animationName === "" || style.animationName === "none") {
          continue;
        }
        const delays = shiftedDelays(style.animationDelay, t);
        if (delays != null) {
          mark ??= String(marks++);
          pseudoRules.push(`[data-cc-i="${mark}"]${STRONG}${pseudo}{animation-delay:${delays} !important}`);
        }
      }
      if (mark != null) {
        out.push(["data-cc-i", mark]);
      }
      const at = out.findIndex(([name]) => name === "style");
      let style = at >= 0 ? out[at][1] : "";
      if (quirks.shadowYFlipped) {
        style = negateShadowsInStyle(style);
      }
      // The element's own URLs only: what is appended holds fragments and the
      // mask placeholders, which are not addresses to fetch.
      style = appendStyle(rewriteCssUrls(style, token), more);
      if (at >= 0) {
        out[at] = ["style", style];
      } else if (style !== "") {
        out.push(["style", style]);
      }
      // A picture named by an attribute (an `<img>`, an `feImage`).
      for (let i = 0; i < out.length; i += 1) {
        const [name, value] = out[i];
        if ((name === "src" || name === "href" || name === "xlink:href") && !value.startsWith("#") && value !== "") {
          const named = token(value);
          if (named != null) {
            out[i] = [name, named];
          }
        }
      }
      return { out, own };
    };

    const smil = (element: Element, attrs: Array<[string, string]>) => {
      const begin = element.getAttribute("begin");
      return [...attrs.filter(([name]) => name !== "begin"), ["begin", shiftSmilBegin(begin, t)]] as Array<[string, string]>;
    };

    const integers = integerProperties(mount.spec.propertyRules);

    /** The engine's faults this element needs worked around, as style to add. */
    const repairs = (element: Element, own: CSSStyleDeclaration): string => {
      let extra = "";
      for (const name of integers) {
        // Whole in Blink and Gecko already; pinned where the engine left a fraction.
        const rounded = roundedInteger(own.getPropertyValue(name));
        if (rounded != null) {
          extra += `${name}:${rounded} !important;`;
        }
      }
      const filters: string[] = [];
      if (quirks.textShadowLayersDropped && own.textShadow !== "none") {
        const layers = parseComputedShadows(own.textShadow);
        const inherited =
          element.parentElement != null &&
          getComputedStyle(element.parentElement).textShadow === own.textShadow;
        if (layers.length >= 2 && !inherited && clearBox(own)) {
          const id = `cc-ts-${defs.length}`;
          const filter = shadowFilter(id, "text", layers);
          if (filter != null) {
            defs.push(filter);
            filters.push(`url(#${id})`);
            extra += "text-shadow:none !important;";
          }
        }
      }
      if (quirks.boxShadowDropped && own.boxShadow !== "none" && element instanceof HTMLElement) {
        const layers = parseComputedShadows(own.boxShadow);
        const outer = layers.filter((layer) => !layer.inset).length;
        if (outer >= 2 || (outer === 1 && clearBox(own))) {
          const width = element.offsetWidth;
          const height = element.offsetHeight;
          const id = `cc-bs-${defs.length}`;
          const filter = shadowFilter(id, "box", layers, {
            width,
            height,
            radii: [
              cornerOf(own.borderTopLeftRadius, width, height),
              cornerOf(own.borderTopRightRadius, width, height),
              cornerOf(own.borderBottomRightRadius, width, height),
              cornerOf(own.borderBottomLeftRadius, width, height),
            ],
          });
          if (filter != null) {
            defs.push(filter);
            filters.push(`url(#${id})`);
            extra += `box-shadow:${insetOnly(layers)} !important;`;
          }
        }
      }
      if (filters.length > 0) {
        const after = own.filter !== "" && own.filter !== "none" ? " " + localUrls(own.filter) : "";
        extra += `filter:${filters.join(" ")}${after} !important;`;
      }
      if (quirks.backfaceIgnored && own.backfaceVisibility === "hidden" && facingAway(element)) {
        extra += "visibility:hidden !important;";
      }
      if (
        quirks.clipTextMissing &&
        element instanceof HTMLElement &&
        (own.backgroundClip.includes("text") ||
          ((own as CSSStyleDeclaration & { webkitBackgroundClip?: string }).webkitBackgroundClip ?? "").includes("text")) &&
        own.maskImage === "none"
      ) {
        const mark = String(clipped.length);
        clipped.push(element);
        extra +=
          "-webkit-background-clip:border-box !important;background-clip:border-box !important;" +
          `mask-image:url("cc-mask-${mark}") !important;mask-size:100% 100% !important;` +
          "mask-repeat:no-repeat !important;mask-position:0 0 !important;mask-origin:border-box !important;";
      }
      return extra;
    };

    const rootMarkup = serializeNode(mount.root as unknown as NodeLike, (node, attrs) => {
      const element = node as unknown as Element;
      if (element.namespaceURI === SVG_NS && SMIL.has(element.localName)) {
        return smil(element, attrs);
      }
      const own = getComputedStyle(element);
      const { out } = base(element, attrs, repairs(element, own));
      const index = clipped.indexOf(element as HTMLElement);
      if (index >= 0) {
        out.push(["data-cc-m", String(index)]);
      }
      return out;
    });
    const defsMarkup =
      defs.length === 0
        ? ""
        : `<svg xmlns="${SVG_NS}" aria-hidden="true" style="position:absolute !important;left:0 !important;top:0 !important;` +
          `width:0 !important;height:0 !important;overflow:hidden !important;display:block !important">${defs.join("")}</svg>`;

    // Each clipped element's mask: the whole tree again, marked so only that
    // element's text shows, in its own untransformed box.
    const masks: TextMask[] = clipped.map((element, index) => {
      const ancestors = new Set<Element>();
      for (let up = element.parentElement; up != null && up !== mount.root.parentElement; up = up.parentElement) {
        ancestors.add(up);
      }
      const body = serializeNode(mount.root as unknown as NodeLike, (node, attrs) => {
        const el = node as unknown as Element;
        if (el.namespaceURI === SVG_NS && SMIL.has(el.localName)) {
          return smil(el, attrs);
        }
        const { out } = base(el, attrs, "");
        if (el === element) {
          out.push(["data-cc-m", String(index)]);
        } else if (ancestors.has(el)) {
          out.push(["data-cc-a", ""]);
        }
        return out;
      });
      let x = 0;
      let y = 0;
      let at: HTMLElement | null = element;
      while (at != null && at !== mount.outer) {
        x += at.offsetLeft;
        y += at.offsetTop;
        const parent = at.offsetParent as HTMLElement | null;
        if (parent == null || parent === mount.outer) {
          break;
        }
        at = parent;
      }
      return {
        token: `cc-mask-${index}`,
        mark: String(index),
        body,
        crop: { x, y, width: Math.max(1, element.offsetWidth), height: Math.max(1, element.offsetHeight) },
      };
    });

    const families: string[] = [];
    const texts: string[] = [];
    for (const face of computedFaces(mount.root).values()) {
      families.push(face.family);
      texts.push(face.text);
    }
    const lang =
      mount.host.closest("[lang]")?.getAttribute("lang") ?? document.documentElement.lang ?? "";
    return {
      body: defsMarkup + rootMarkup,
      pseudoRules,
      urls,
      masks,
      families,
      texts,
      lang,
      dir: getComputedStyle(mount.root).direction,
    };
  }

  private async assemble(mount: LiveMount<SnapshotState>, capture: Capture): Promise<string> {
    const [css, fonts, carried] = await Promise.all([
      programCss(mount.spec, this.quirks.shadowYFlipped),
      fontFaceCss(capture.families, harvestCodepoints(capture.texts, capture.lang)),
      Promise.all(
        [...capture.urls].map(async ([name, url]) => [name, await dataUrlOf(url)] as const),
      ),
    ]);
    const answers = new Map(carried);
    const carry = (markup: string) => markup.replace(URL_TOKEN, (name) => answers.get(name) ?? "data:,");
    const outerWidth = mount.layoutBox.width + 2 * mount.bleed;
    const outerHeight = mount.layoutBox.height + 2 * mount.bleed;
    const shared = [mount.spec.propertyRules, fonts, css, capture.pseudoRules.join("\n")].join("\n");
    const maskUrls = new Map<string, string>();
    for (const mask of capture.masks) {
      const nested = snapshotSvg({
        rasterWidth: outerWidth,
        rasterHeight: outerHeight,
        outerWidth,
        outerHeight,
        lang: capture.lang,
        dir: capture.dir,
        css: shared + "\n" + maskRules(mask.mark),
        body: carry(mask.body),
        crop: mask.crop,
      });
      maskUrls.set(mask.token, svgDataUrl(nested));
    }
    const body = carry(capture.body).replace(MASK_TOKEN, (name) => maskUrls.get(name) ?? "data:,");
    const raster = this.rasterOf(mount);
    return snapshotSvg({
      rasterWidth: raster.width,
      rasterHeight: raster.height,
      outerWidth,
      outerHeight,
      lang: capture.lang,
      dir: capture.dir,
      css: shared,
      body,
    });
  }

  /** Draw a decoded snapshot onto the mount's scratch canvas, at the raster size. */
  private async draw(mount: LiveMount<SnapshotState>, image: HTMLImageElement): Promise<void> {
    const { width, height } = this.rasterOf(mount);
    const scratch = mount.x.scratch ?? (mount.x.scratch = document.createElement("canvas"));
    if (scratch.width !== width || scratch.height !== height) {
      scratch.width = width;
      scratch.height = height;
    }
    const ctx = scratch.getContext("2d");
    if (ctx == null) {
      throw new Error("no 2D context for the snapshot");
    }
    const paint = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
    };
    paint();
    if (!this.quirks.lateResources) {
      return;
    }
    // An engine that drew before an embedded face was ready: draw again until
    // two draws agree, a bounded number of times.
    let last = fingerprint(scratch, width, height);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await yieldFrame();
      paint();
      const now = fingerprint(scratch, width, height);
      if (now === last) {
        return;
      }
      last = now;
    }
  }

  async settle(): Promise<boolean> {
    const touched = (await this.settleLive()).filter((mount) => mount.host.isConnected);
    // Every read of every mount before anything is awaited, so nothing the
    // live tree does meanwhile reaches a snapshot.
    const captured = touched.map((mount) => {
      mount.x.ready = false;
      try {
        return { mount, capture: this.capture(mount) };
      } catch (error) {
        this.warnOnce(mount, error);
        return { mount, capture: null };
      }
    });
    await Promise.all(
      captured.map(async ({ mount, capture }) => {
        if (capture == null) {
          return;
        }
        try {
          const image = await decode(svgDataUrl(await this.assemble(mount, capture)));
          await this.draw(mount, image);
          mount.x.ready = true;
        } catch (error) {
          this.warnOnce(mount, error);
        }
      }),
    );
    // The snapshot needs no paint, so a frame is never "not painted"; a mount
    // that failed answers `null` from `rasterize`, which `prepare.ts` reports.
    return true;
  }

  rasterize(instanceId: string, width: number, height: number): CanvasImageSource | null {
    const mount = this.mounts.get(instanceId);
    if (mount == null || !mount.x.ready || mount.x.scratch == null) {
      return null;
    }
    const output = mount.x.output;
    if (output.width !== width || output.height !== height) {
      output.width = width;
      output.height = height;
    }
    const ctx = output.getContext("2d");
    if (ctx == null) {
      return null;
    }
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(mount.x.scratch, 0, 0, width, height);
    mount.x.ready = false;
    return output;
  }

  private warnOnce(mount: LiveMount<SnapshotState>, error: unknown): void {
    if (!this.reported.has(mount.programKey)) {
      this.reported.add(mount.programKey);
      console.warn("graphic: could not draw a snapshot of " + mount.programKey, error);
    }
  }
}

// ---------------------------------------------------------------------------
// The probe.

const PROBE_W = 160;
const PROBE_H = 100;

/**
 * One small snapshot with a region per question, each answered by colour:
 *
 *  - drawn at all: a red square at the corner;
 *  - shadow direction: a blue box at y 40 with a red shadow 30px below it,
 *    which lands at y 70, or at y 10 where the engine flips it;
 *  - `background-clip: text`: green clipped to an "H";
 *  - back faces: a red square turned 180 degrees with its back face hidden;
 *  - text shadow layers: an "H" with a cyan shadow to its right and a yellow
 *    one to its left (sideways, so a flip cannot move them);
 *  - box shadow layers: a blue box with an orange shadow below it and a
 *    purple one above it. Vertical on purpose: WebKit keeps a list's layers
 *    with no vertical offset and drops every one that has one.
 */
const PROBE_BODY =
  '<div style="position:absolute;left:0;top:0;width:10px;height:10px;background:#ff0000"></div>' +
  '<div style="position:absolute;left:20px;top:40px;width:10px;height:10px;background:#0000ff;box-shadow:0 30px 0 #ff0000"></div>' +
  '<div style="position:absolute;left:40px;top:0;width:60px;height:60px;font:bold 48px sans-serif;line-height:60px;' +
  "background:linear-gradient(#00ff00,#00ff00);-webkit-background-clip:text;background-clip:text;" +
  'color:transparent;-webkit-text-fill-color:transparent">H</div>' +
  '<div style="position:absolute;left:110px;top:0;width:20px;height:20px;transform-style:preserve-3d">' +
  '<div style="position:absolute;left:0;top:0;width:20px;height:20px;background:#ff0000;transform:rotateY(180deg);backface-visibility:hidden"></div></div>' +
  '<div style="position:absolute;left:122px;top:40px;font:bold 20px sans-serif;line-height:20px;color:#0000ff;' +
  'text-shadow:14px 0 0 #00ffff, -14px 0 0 #ffff00">H</div>' +
  '<div style="position:absolute;left:62px;top:70px;width:10px;height:10px;background:#0000ff;' +
  'box-shadow:0 14px 0 #ff8000, 0 -14px 0 #8000ff"></div>';

type Pixel = [number, number, number, number];

function near(p: Pixel, r: number, g: number, b: number): boolean {
  return Math.abs(p[0] - r) < 60 && Math.abs(p[1] - g) < 60 && Math.abs(p[2] - b) < 60 && p[3] > 150;
}

/**
 * Whether the snapshot host can draw here, and which of the engine's known
 * faults it must work around, by drawing one small snapshot and reading it
 * back. `null` when it draws nothing, or the canvas is tainted after it.
 */
export async function snapshotSupport(): Promise<SnapshotQuirks | null> {
  if (typeof document === "undefined") {
    return null;
  }
  try {
    const svg = snapshotSvg({
      rasterWidth: PROBE_W,
      rasterHeight: PROBE_H,
      outerWidth: PROBE_W,
      outerHeight: PROBE_H,
      lang: "",
      dir: "",
      css: "",
      body: PROBE_BODY,
    });
    const image = await decode(svgDataUrl(svg));
    const canvas = document.createElement("canvas");
    canvas.width = PROBE_W;
    canvas.height = PROBE_H;
    const ctx = canvas.getContext("2d");
    if (ctx == null) {
      return null;
    }
    ctx.drawImage(image, 0, 0);
    // Throws on a tainted canvas, which is an answer: the snapshot cannot be used.
    const data = ctx.getImageData(0, 0, PROBE_W, PROBE_H).data;
    const at = (x: number, y: number): Pixel => {
      const i = (y * PROBE_W + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };
    const count = (x0: number, y0: number, x1: number, y1: number, test: (p: Pixel) => boolean) => {
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (test(at(x, y))) n += 1;
        }
      }
      return n;
    };
    if (!near(at(5, 5), 255, 0, 0)) {
      return null;
    }
    return {
      shadowYFlipped: near(at(25, 15), 255, 0, 0) && !near(at(25, 75), 255, 0, 0),
      textShadowLayersDropped:
        count(130, 35, 160, 65, (p) => near(p, 0, 255, 255)) > 10 &&
        count(100, 35, 125, 65, (p) => near(p, 255, 255, 0)) === 0,
      // Either colour, above or below the box: a flip may swap them.
      boxShadowDropped:
        count(58, 50, 78, 100, (p) => near(p, 255, 128, 0)) === 0 ||
        count(58, 50, 78, 100, (p) => near(p, 128, 0, 255)) === 0,
      clipTextMissing: count(40, 0, 100, 60, (p) => near(p, 0, 255, 0)) < 20,
      lateResources: false,
      backfaceIgnored: near(at(120, 10), 255, 0, 0),
    };
  } catch {
    return null;
  }
}
