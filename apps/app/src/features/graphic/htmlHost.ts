/**
 * The HTML host: the one file that calls html-in-canvas.
 *
 * Every rule here is a measurement from `tests/spikes/html-in-canvas/`
 * (`tests/e2e/FINDINGS.md` section 10), and each one prevents a specific
 * failure:
 *
 *  - **One `<canvas layoutsubtree>` per graphic, its only child the graphic's
 *    root.** Direct children are what get painted; one canvas each keeps every
 *    root at the canvas origin, where nothing culls it.
 *  - **Hidden with `clip-path: inset(50%)`.** `opacity: 0` on the canvas paints
 *    every child transparent, a canvas far off screen is culled to nothing, and
 *    `visibility: hidden` leaves no paint record to draw at all.
 *  - **A closed shadow root, never an iframe.** An iframe under a
 *    `layoutsubtree` canvas crashes the renderer outright.
 *  - **`@property` rules go to the document.** Inside a shadow root they are
 *    ignored; `mountSpec.ts` has already renamed them per program.
 *  - **Bleed is padding on the root.** What a child paints outside its border
 *    box is clipped, so a glow past the box needs the box to be bigger.
 *  - **A change is drawable only after the next `paint` event.** So `apply`
 *    mutates, `settle` waits for the paint, and `rasterize` draws afterwards.
 *  - **A seek goes through every animation the mount has had**, not through
 *    `getAnimations()` alone, which stops listing an animation that finished
 *    with no fill. Seeked past its end once, it could never be seeked back, and
 *    whatever it showed stayed hidden on every replay (`seekAnimations.ts`).
 *
 * Nothing from the program runs here. The DOM is built node by node from the
 * sanitiser's tree with `createElementNS` and `setAttribute`, never from a
 * markup string, so nothing is parsed twice; and the stylesheet the browser
 * parses is checked again against the browser's own parse before it is used.
 */

import { ensureFontFace, cssQuoted, type FontEntry } from "../font/fontFaces";
import type { ApplyState, HtmlRasterPort, MountSpec } from "./htmlRasterPort";
import type { SafeNode } from "./sanitizeHtml";
import { fillTextSlots, parseSplit, splitTree, wantsLines } from "./split";
import { fitMaxOf, fitModeOf, fitScale } from "./fit";
import { seekAnimations } from "./seekAnimations";

const SVG_NS = "http://www.w3.org/2000/svg";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Most graphics mounted at once. Past it the least recently used is released. */
export const MAX_MOUNTS = 32;

/** How long a paint may take before `settle` gives up on it. */
const PAINT_TIMEOUT_MS = 500;

/** How long fonts and images may take to arrive. */
const LOAD_TIMEOUT_MS = 3000;

const BASE_CSS = `
:host { all: initial; display: block; position: relative; overflow: hidden; }
*, *::before, *::after { transition: none !important; animation-play-state: paused !important; }
.graphic-root {
  position: absolute; box-sizing: border-box; container-type: size;
  font-family: "notosanskr", sans-serif; color: #fff;
}
[data-param] { white-space: pre-line; }
.word { display: inline-block; white-space: nowrap; }
.char { display: inline-block; }
.graphic-fitting, .graphic-fitting *, .graphic-fitting *::before, .graphic-fitting *::after {
  animation: none !important; transform: none !important; translate: none !important;
  rotate: none !important; scale: none !important;
}
`;

type Mount = {
  programKey: string;
  spec: MountSpec;
  canvas: HTMLCanvasElement;
  outer: HTMLDivElement;
  shadow: ShadowRoot;
  root: HTMLDivElement;
  texts: string;
  seed: number;
  lines: boolean;
  timeMs: number;
  used: number;
  /** What the last `data-fit` answer was measured for; a change refits. */
  fitKey: string;
  /**
   * Every animation this mount has had, so a seek back reaches the ones
   * `getAnimations()` stopped listing when they finished (`seekAnimations.ts`).
   */
  animations: Set<Animation>;
  pendingFitKey: string;
};

let baseSheet: CSSStyleSheet | null = null;
const hoisted = new Set<string>();

function supportedHere(): boolean {
  try {
    return (
      typeof (CanvasRenderingContext2D.prototype as any).drawElementImage === "function" &&
      typeof (HTMLCanvasElement.prototype as any).requestPaint === "function" &&
      "layoutSubtree" in HTMLCanvasElement.prototype
    );
  } catch {
    return false;
  }
}

/** The browser's own parse of a stylesheet, second-checked rule by rule. */
function checkedSheet(css: string): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return sheet;
  }
  const allowedUrl = /url\(\s*["']?(#|file:)/i;
  const prune = (list: CSSRuleList, remove: (index: number) => void) => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const rule = list[i];
      const text = rule.cssText;
      const kind = rule.constructor?.name ?? "";
      const bannedKind =
        kind === "CSSImportRule" || kind === "CSSFontFaceRule" || kind === "CSSNamespaceRule";
      const urls = text.match(/url\(/gi)?.length ?? 0;
      const allowed = text.match(new RegExp(allowedUrl.source, "gi"))?.length ?? 0;
      if (bannedKind || urls !== allowed) {
        remove(i);
        continue;
      }
      const inner = (rule as CSSGroupingRule).cssRules;
      if (inner != null && typeof (rule as CSSGroupingRule).deleteRule === "function") {
        prune(inner, (index) => (rule as CSSGroupingRule).deleteRule(index));
      }
    }
  };
  prune(sheet.cssRules, (index) => sheet.deleteRule(index));
  return sheet;
}

function base(): CSSStyleSheet {
  if (baseSheet == null) {
    baseSheet = new CSSStyleSheet();
    baseSheet.replaceSync(BASE_CSS);
  }
  return baseSheet;
}

/** `@property` is document-wide, so a program's rules are registered there, once. */
function hoist(rules: string): void {
  const text = rules.trim();
  if (text === "" || hoisted.has(text)) {
    return;
  }
  hoisted.add(text);
  const sheet = checkedSheet(text);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

/**
 * A `style` attribute with the program's registered property names swapped for
 * their renamed forms, so an inline `--angle: 30deg` still reaches the
 * registered `--g1a2b3c4d-angle` the stylesheet animates.
 */
function renameInline(style: string, renames: Record<string, string>): string {
  let out = style;
  for (const [from, to] of Object.entries(renames)) {
    out = out.replace(new RegExp(from.replace(/[-]/g, "\\-") + "(?![\\w-])", "g"), to);
  }
  return out;
}

function build(node: SafeNode, spec: MountSpec): Node {
  if (node.kind === "text") {
    return document.createTextNode(node.text);
  }
  const element = document.createElementNS(node.ns === "svg" ? SVG_NS : HTML_NS, node.tag);
  const names = Object.keys(spec.renames);
  for (const [name, raw] of node.attrs) {
    let value = raw;
    if (name === "src" && value.startsWith("asset:")) {
      const url = spec.assetUrls[value.slice(6)];
      if (url == null) {
        continue;
      }
      value = url;
    }
    if (name === "style" && names.length > 0) {
      value = renameInline(value, spec.renames);
    }
    try {
      if (name === "xlink:href") {
        element.setAttributeNS(XLINK_NS, "xlink:href", value);
      } else {
        element.setAttribute(name, value);
      }
    } catch {
      // An attribute name the DOM refuses; the sanitiser should not have let
      // one through, and dropping it is the safe answer either way.
    }
  }
  for (const child of node.children) {
    element.appendChild(build(child, spec));
  }
  return element;
}

/** Group words into lines by where they sit on the block axis. */
function measureLines(shadow: ShadowRoot): void {
  for (const root of Array.from(shadow.querySelectorAll<HTMLElement>("[data-split]"))) {
    if (parseSplit(root.getAttribute("data-split"))?.lines !== true) {
      continue;
    }
    const vertical = getComputedStyle(root).writingMode.startsWith("vertical");
    const words = Array.from(root.querySelectorAll<HTMLElement>(".word"));
    let line = -1;
    let last = Number.NaN;
    for (const word of words) {
      const rect = word.getBoundingClientRect();
      const at = vertical ? rect.left + rect.right : rect.top + rect.bottom;
      if (Number.isNaN(last) || Math.abs(at - last) > 2) {
        line += 1;
        last = at;
      }
      word.style.setProperty("--line-index", String(line));
    }
    root.style.setProperty("--line-count", String(line + 1));
  }
}

function waitPaint(canvas: HTMLCanvasElement): Promise<boolean> {
  // A mount released since it was applied is out of the document and never
  // paints; waiting for it held every other graphic in the prepare for the
  // whole timeout.
  if (!canvas.isConnected) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (!done) {
        done = true;
        canvas.removeEventListener("paint", onPaint);
        resolve(ok);
      }
    };
    const onPaint = () => finish(true);
    canvas.addEventListener("paint", onPaint);
    setTimeout(() => finish(false), PAINT_TIMEOUT_MS);
    try {
      (canvas as any).requestPaint();
    } catch {
      finish(false);
    }
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

export class HtmlHost implements HtmlRasterPort {
  private mounts = new Map<string, Mount>();
  private touched = new Set<string>();
  private pendingFonts = new Map<string, FontEntry>();
  /** Families `document.fonts` has confirmed, so a refit runs only when one arrives. */
  private usableFonts = new Set<string>();
  private reported = new Set<string>();
  private clock = 0;

  supported(): boolean {
    return supportedHere();
  }

  private create(instanceId: string, spec: MountSpec): Mount {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("layoutsubtree", "");
    canvas.setAttribute("aria-hidden", "true");
    canvas.dataset.graphicHost = instanceId;
    canvas.style.cssText =
      "position:fixed;left:0;top:0;clip-path:inset(50%);pointer-events:none;z-index:-1;";
    const outer = document.createElement("div");
    outer.style.cssText = "display:block;position:relative;overflow:hidden;";
    canvas.appendChild(outer);
    const shadow = outer.attachShadow({ mode: "closed" });
    shadow.adoptedStyleSheets = [base(), checkedSheet(spec.css)];
    const root = document.createElement("div");
    root.className = "graphic-root";
    shadow.appendChild(root);
    hoist(spec.propertyRules);
    document.body.appendChild(canvas);
    return {
      programKey: spec.programKey,
      spec,
      canvas,
      outer,
      shadow,
      root,
      texts: "",
      seed: Number.NaN,
      lines: wantsLines(spec.nodes),
      timeMs: 0,
      used: 0,
      fitKey: "",
      pendingFitKey: "",
      animations: new Set(),
    };
  }

  mount(instanceId: string, spec: MountSpec): void {
    const existing = this.mounts.get(instanceId);
    if (existing != null && existing.programKey === spec.programKey) {
      existing.used = ++this.clock;
      return;
    }
    if (existing != null) {
      existing.canvas.remove();
      this.mounts.delete(instanceId);
    }
    const mount = this.create(instanceId, spec);
    mount.used = ++this.clock;
    this.mounts.set(instanceId, mount);
    if (this.mounts.size > MAX_MOUNTS) {
      const oldest = [...this.mounts.entries()]
        .filter(([id]) => id !== instanceId && !this.touched.has(id))
        .sort((a, b) => a[1].used - b[1].used)[0];
      if (oldest != null) {
        oldest[1].canvas.remove();
        this.mounts.delete(oldest[0]);
      }
    }
  }

  apply(instanceId: string, state: ApplyState): void {
    const mount = this.mounts.get(instanceId);
    if (mount == null) {
      return;
    }
    mount.used = ++this.clock;
    const { layoutBox, bleed } = state;
    const outerW = layoutBox.width + 2 * bleed;
    const outerH = layoutBox.height + 2 * bleed;
    mount.canvas.style.width = outerW + "px";
    mount.canvas.style.height = outerH + "px";
    mount.outer.style.width = outerW + "px";
    mount.outer.style.height = outerH + "px";
    const root = mount.root;
    root.style.left = bleed + "px";
    root.style.top = bleed + "px";
    root.style.width = layoutBox.width + "px";
    root.style.height = layoutBox.height + "px";

    // The tree is rebuilt only when the words or the seed change: text slots
    // and the split are a function of both, and rebuilding also restarts every
    // CSS animation, which the seek below makes harmless.
    const texts = JSON.stringify(state.texts);
    if (texts !== mount.texts || state.seed !== mount.seed) {
      const nodes = splitTree(fillTextSlots(mount.spec.nodes, state.texts), {
        programHash: mount.spec.programHash,
        seed: state.seed,
      });
      root.replaceChildren(...nodes.map((node) => build(node, mount.spec)));
      mount.texts = texts;
      mount.seed = state.seed;
    }

    for (const [name, value] of Object.entries(state.vars)) {
      root.style.setProperty(name, value);
    }
    for (const font of state.fonts) {
      this.pendingFonts.set(font.name, font);
    }
    mount.timeMs = state.timeMs;
    // Everything a fitted size depends on except the time, which the fit
    // deliberately ignores: a title that resized itself as its letters moved
    // would pulse.
    const { "--t": _t, "--progress": _progress, ...still } = state.vars;
    mount.pendingFitKey = [texts, state.seed, outerW + "x" + outerH, JSON.stringify(still)].join("|");
    this.seek(mount);
    this.touched.add(instanceId);
  }

  /**
   * Set `--fit` on every `[data-fit]` element: the largest scale at which its
   * content stays inside it. Measured with every animation and transform
   * switched off, so the answer is the resting layout's and does not change
   * with the program time; the caller seeks again afterwards, because removing
   * the switch recreates the animations.
   */
  private fit(mount: Mount): void {
    const targets = Array.from(mount.shadow.querySelectorAll<HTMLElement>("[data-fit]"));
    if (targets.length === 0) {
      return;
    }
    mount.root.classList.add("graphic-fitting");
    try {
      for (const element of targets) {
        const mode = fitModeOf(element.getAttribute("data-fit"));
        if (mode == null) {
          continue;
        }
        const fits = (scale: number) => {
          element.style.setProperty("--fit", String(scale));
          return (
            element.scrollWidth <= element.clientWidth + 1 &&
            (mode === "width" || element.scrollHeight <= element.clientHeight + 1)
          );
        };
        const scale = fitScale(fits, fitMaxOf(element.getAttribute("data-fit-max")));
        element.style.setProperty("--fit", String(scale));
      }
    } finally {
      mount.root.classList.remove("graphic-fitting");
    }
  }

  /** Every CSS animation and SMIL clock in the graphic, set to its time. */
  private seek(mount: Mount): void {
    try {
      seekAnimations(mount.animations, mount.shadow.getAnimations(), mount.timeMs);
    } catch {
      // A detached root has no animations to seek.
    }
    for (const svg of Array.from(mount.shadow.querySelectorAll("svg"))) {
      if (svg.parentElement?.closest("svg") != null) {
        continue;
      }
      try {
        (svg as SVGSVGElement).pauseAnimations();
        (svg as SVGSVGElement).setCurrentTime(mount.timeMs / 1000);
      } catch {
        // An SVG with no timeline.
      }
    }
  }

  async settle(): Promise<boolean> {
    const fonts = [...this.pendingFonts.values()];
    this.pendingFonts.clear();
    // Faces that were not usable before this settle. Every apply lists its
    // fonts, so "any font listed" would refit every fitted graphic every frame.
    const fresh = fonts.filter((font) => !this.usableFonts.has(font.name));
    for (const font of fonts) {
      ensureFontFace(font);
    }
    // Only for a face not yet usable. `document.fonts.ready` waits for every
    // face loading anywhere in the editor, so waiting on it for faces already
    // in hand stalled every frame of a playing graphic while an unrelated font
    // loaded (a preset tile's, a text clip's), up to the timeout.
    if (fresh.length > 0) {
      await withTimeout(
        Promise.all(
          fresh.map((font) =>
            document.fonts.load(`16px ${cssQuoted(font.name)}`).catch(() => []),
          ),
        ),
        LOAD_TIMEOUT_MS,
      );
      await withTimeout(document.fonts.ready, LOAD_TIMEOUT_MS);
      for (const font of fresh) {
        try {
          if (document.fonts.check(`16px ${cssQuoted(font.name)}`)) {
            this.usableFonts.add(font.name);
          }
        } catch {
          // A family name the parser refuses is never usable.
        }
      }
    }

    const touched = [...this.touched]
      .map((id) => this.mounts.get(id))
      .filter((m): m is Mount => m != null);
    this.touched.clear();

    const images = touched.flatMap((mount) =>
      Array.from(mount.shadow.querySelectorAll("img")).filter((img) => !img.complete),
    );
    if (images.length > 0) {
      await withTimeout(
        Promise.all(images.map((img) => img.decode().catch(() => undefined))),
        LOAD_TIMEOUT_MS,
      );
    }

    for (const mount of touched) {
      // After the fonts, which decide how wide the words are, and before the
      // lines, which break where the fitted size puts them.
      if (fresh.length > 0 || mount.fitKey !== mount.pendingFitKey) {
        this.fit(mount);
        mount.fitKey = mount.pendingFitKey;
        if (!mount.lines) {
          this.seek(mount);
        }
      }
      if (mount.lines) {
        // After the fonts, which decide where the lines break. Then seek again:
        // a new `--line-index` can restyle, and a restyle can recreate an
        // animation that has not been seeked.
        measureLines(mount.shadow);
        this.seek(mount);
      }
    }

    const results = await Promise.all(touched.map((mount) => waitPaint(mount.canvas)));
    return results.every(Boolean);
  }

  rasterize(instanceId: string, width: number, height: number): CanvasImageSource | null {
    const mount = this.mounts.get(instanceId);
    if (mount == null) {
      return null;
    }
    const canvas = mount.canvas;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    if (ctx == null) {
      return null;
    }
    try {
      ctx.clearRect(0, 0, width, height);
      (ctx as any).drawElementImage(mount.outer, 0, 0, width, height);
      return canvas;
    } catch (error) {
      if (!this.reported.has(instanceId)) {
        this.reported.add(instanceId);
        console.warn("graphic: could not rasterise " + instanceId, error);
      }
      return null;
    }
  }

  release(live: ReadonlySet<string>): void {
    for (const [id, mount] of [...this.mounts]) {
      if (!live.has(id)) {
        mount.canvas.remove();
        this.mounts.delete(id);
      }
    }
  }

  unmount(instanceId: string): void {
    const mount = this.mounts.get(instanceId);
    if (mount != null) {
      mount.canvas.remove();
      this.mounts.delete(instanceId);
    }
  }

  /** How many graphics are mounted. For the perf counters and the tests. */
  get size(): number {
    return this.mounts.size;
  }
}

let preview: HtmlHost | null = null;

/**
 * The preview's host, made on first use so a project without graphics never
 * has one. Nothing else prepares on it: `rasterize` hands back the mount's own
 * canvas and the preview keeps drawing that canvas, so an export or a contact
 * sheet rasterising the same clip here redrew what the preview showed while
 * the preview's key still called it current. They each make a host of their
 * own (`graphicPipeline.ts#prepareScopeFrame`).
 */
export function previewHtmlHost(): HtmlHost {
  if (preview == null) {
    preview = new HtmlHost();
  }
  return preview;
}
