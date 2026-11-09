/**
 * The DOM half every HTML graphic host shares: a graphic's tree, built in a
 * closed shadow root under an element of the host's choosing, brought to one
 * frame's state, with its fonts, images, `data-fit`, lines and clock settled.
 *
 * Two hosts draw from it. `htmlHost.ts` hangs the tree under a canvas and
 * draws it with html-in-canvas; `snapshotHost.ts` hangs it under a hidden
 * `div` and draws an SVG image of it. Everything that decides what the
 * graphic looks like at a moment lives here, so the two cannot disagree about
 * it: the live tree is the truth for time t in both.
 *
 * Nothing from the program runs here. The DOM is built node by node from the
 * sanitiser's tree with `createElementNS` and `setAttribute`, never from a
 * markup string, so nothing is parsed twice; and the stylesheet the browser
 * parses is checked again against the browser's own parse before it is used.
 *
 * Rules carried over from the html-in-canvas spike (`tests/e2e/FINDINGS.md`
 * section 10), true of both hosts:
 *
 *  - **`@property` rules go to the document.** Inside a shadow root they are
 *    ignored; `mountSpec.ts` has already renamed them per program.
 *  - **Bleed is padding on the root.** What a child paints outside its border
 *    box is clipped, so a glow past the box needs the box to be bigger.
 *  - **A seek goes through every animation the mount has had**, not through
 *    `getAnimations()` alone, which stops listing an animation that finished
 *    with no fill (`seekAnimations.ts`), **and repeats until no new animation
 *    appears**, because a seek can create one (section 11).
 */

import { ensureFontFace, cssQuoted, type FontEntry } from "../font/fontFaces";
import type { ApplyState, MountSpec } from "./htmlRasterPort";
import type { SafeNode } from "./sanitizeHtml";
import { fillTextSlots, parseSplit, splitTree, wantsLines } from "./split";
import { fitMaxOf, fitModeOf, fitScale } from "./fit";
import { seekUntilSettled } from "./seekAnimations";
import { cssUrlsAdmitted } from "./fileUrl";
import { lineIndices } from "./lines";
import { expandInsetInStyle, expandInsetInStylesheet, needsInsetLonghands } from "./cssCompat";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const HTML_NS = "http://www.w3.org/1999/xhtml";
export const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Most graphics mounted at once. Past it the least recently used is released. */
export const MAX_MOUNTS = 32;

/** How long fonts and images may take to arrive. */
export const LOAD_TIMEOUT_MS = 3000;

export const BASE_CSS = `
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

export type LiveMount<X> = {
  programKey: string;
  spec: MountSpec;
  /** The element in the document: the host's canvas, or its hidden `div`. */
  host: HTMLElement;
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
  pendingFitKey: string;
  /** The fit key the families the tree computes were last loaded for. */
  familiesKey: string;
  /**
   * Every animation this mount has had, so a seek back reaches the ones
   * `getAnimations()` stopped listing when they finished (`seekAnimations.ts`).
   */
  animations: Set<Animation>;
  /** What the last apply said the raster would be, in pixels. */
  raster: { width: number; height: number } | null;
  bleed: number;
  layoutBox: { width: number; height: number };
  /** The host's own state for this mount. */
  x: X;
};

let baseSheet: CSSStyleSheet | null = null;
const hoisted = new Set<string>();

/**
 * Whether stylesheets can be constructed and adopted (Chrome 73, Firefox 101,
 * Safari 16.4). Where they cannot, a `<style>` element stands in.
 */
function constructableSheets(): boolean {
  try {
    return (
      typeof CSSStyleSheet === "function" &&
      typeof (CSSStyleSheet.prototype as { replaceSync?: unknown }).replaceSync === "function" &&
      typeof ShadowRoot !== "undefined" &&
      "adoptedStyleSheets" in ShadowRoot.prototype
    );
  } catch {
    return false;
  }
}

/** Remove what the program may not have, judged by the browser's own parse. */
function pruneRules(list: CSSRuleList, remove: (index: number) => void): void {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const rule = list[i];
    const text = rule.cssText;
    const kind = rule.constructor?.name ?? "";
    const bannedKind =
      kind === "CSSImportRule" || kind === "CSSFontFaceRule" || kind === "CSSNamespaceRule";
    if (bannedKind || !cssUrlsAdmitted(text)) {
      remove(i);
      continue;
    }
    const inner = (rule as CSSGroupingRule).cssRules;
    if (inner != null && typeof (rule as CSSGroupingRule).deleteRule === "function") {
      pruneRules(inner, (index) => (rule as CSSGroupingRule).deleteRule(index));
    }
  }
}

/** The browser's own parse of a stylesheet, second-checked rule by rule. */
export function checkedSheet(css: string): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return sheet;
  }
  pruneRules(sheet.cssRules, (index) => sheet.deleteRule(index));
  return sheet;
}

function base(): CSSStyleSheet {
  if (baseSheet == null) {
    baseSheet = new CSSStyleSheet();
    baseSheet.replaceSync(BASE_CSS);
  }
  return baseSheet;
}

/** A `<style>` holding `css`, pruned like `checkedSheet` once it is connected. */
function styleElement(css: string, into: Node): void {
  const style = document.createElement("style");
  style.textContent = css;
  into.appendChild(style);
  const sheet = style.sheet;
  if (sheet != null) {
    pruneRules(sheet.cssRules, (index) => sheet.deleteRule(index));
  }
}

/** The base sheet and the program's, on a connected shadow root. */
function adoptSheets(shadow: ShadowRoot, source: string): void {
  const css = needsInsetLonghands() ? expandInsetInStylesheet(source) : source;
  if (constructableSheets()) {
    shadow.adoptedStyleSheets = [base(), checkedSheet(css)];
    return;
  }
  styleElement(BASE_CSS, shadow);
  styleElement(css, shadow);
}

/** `@property` is document-wide, so a program's rules are registered there, once. */
export function hoist(rules: string): void {
  const text = rules.trim();
  if (text === "" || hoisted.has(text)) {
    return;
  }
  hoisted.add(text);
  if (constructableSheets() && "adoptedStyleSheets" in Document.prototype) {
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, checkedSheet(text)];
    return;
  }
  styleElement(text, document.head);
}

/**
 * A `style` attribute with the program's registered property names swapped for
 * their renamed forms, so an inline `--angle: 30deg` still reaches the
 * registered `--g1a2b3c4d-angle` the stylesheet animates.
 */
export function renameInline(style: string, renames: Record<string, string>): string {
  let out = style;
  for (const [from, to] of Object.entries(renames)) {
    out = out.replace(new RegExp(from.replace(/[-]/g, "\\-") + "(?![\\w-])", "g"), to);
  }
  return out;
}

export function build(node: SafeNode, spec: MountSpec): Node {
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
    if (name === "style" && needsInsetLonghands()) {
      value = expandInsetInStyle(value);
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
export function measureLines(scope: ParentNode): void {
  for (const root of Array.from(scope.querySelectorAll<HTMLElement>("[data-split]"))) {
    if (parseSplit(root.getAttribute("data-split"))?.lines !== true) {
      continue;
    }
    const vertical = getComputedStyle(root).writingMode.startsWith("vertical");
    const words = Array.from(root.querySelectorAll<HTMLElement>(".word"));
    const lines = lineIndices(
      words.map((word) => word.getBoundingClientRect()),
      vertical,
    );
    words.forEach((word, index) => word.style.setProperty("--line-index", String(lines[index])));
    const count = lines.length === 0 ? 0 : lines[lines.length - 1] + 1;
    root.style.setProperty("--line-count", String(count));
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/** Longest text sample handed to `document.fonts` per face. */
const SAMPLE_CHARS = 256;

export type ComputedFace = {
  /** The computed `font-family` list. */
  family: string;
  /** All the text drawn in it. */
  text: string;
};

/**
 * The faces a graphic's text actually asks for: one entry per `font`
 * shorthand (style, weight and family list) that has text, with that text.
 * Read from computed style, so the default face, a parameter's family and a
 * literal family in the program are all found the same way.
 */
export function computedFaces(root: HTMLElement): Map<string, ComputedFace> {
  const faces = new Map<string, ComputedFace>();
  const add = (style: CSSStyleDeclaration, text: string) => {
    if (text.trim() === "") {
      return;
    }
    const font = `${style.fontStyle} ${style.fontWeight} 16px ${style.fontFamily}`;
    const had = faces.get(font);
    faces.set(font, { family: style.fontFamily, text: (had?.text ?? "") + text });
  };
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
  for (const element of elements) {
    let own = "";
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 3) {
        own += child.nodeValue ?? "";
      }
    }
    if (own !== "") {
      add(getComputedStyle(element), own);
    }
    for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(element, pseudo);
      const content = style.content;
      if (content !== "" && content !== "none" && content !== "normal") {
        add(style, content.replace(/^["']|["']$/g, ""));
      }
    }
  }
  return faces;
}

/**
 * The tree, state and settle steps both hosts share. A host supplies the
 * element the graphic hangs under and how to size it; it adds its own way of
 * waiting and drawing on top of `settleLive`.
 */
export abstract class LiveGraphicHost<X> {
  protected readonly mounts = new Map<string, LiveMount<X>>();
  protected readonly touched = new Set<string>();
  private readonly pendingFonts = new Map<string, FontEntry>();
  /** Families `document.fonts` has confirmed, so a refit runs only when one arrives. */
  private readonly usableFonts = new Set<string>();
  private clock = 0;

  /**
   * The element that goes in the document and the `div` under it the graphic's
   * shadow root hangs off, not yet connected, plus the host's own state.
   */
  protected abstract createHost(instanceId: string): { host: HTMLElement; outer: HTMLDivElement; x: X };

  /** Size the host's element for an outer box of `width` x `height` CSS pixels. */
  protected abstract sizeHost(mount: LiveMount<X>, width: number, height: number): void;

  /** Let go of a mount's own state; its element is already out of the document. */
  protected disposeMount(_mount: LiveMount<X>): void {}

  private create(instanceId: string, spec: MountSpec): LiveMount<X> {
    const { host, outer, x } = this.createHost(instanceId);
    outer.style.cssText = "display:block;position:relative;overflow:hidden;";
    const shadow = outer.attachShadow({ mode: "closed" });
    document.body.appendChild(host);
    adoptSheets(shadow, spec.css);
    const root = document.createElement("div");
    root.className = "graphic-root";
    shadow.appendChild(root);
    hoist(spec.propertyRules);
    return {
      programKey: spec.programKey,
      spec,
      host,
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
      familiesKey: "",
      animations: new Set(),
      raster: null,
      bleed: 0,
      layoutBox: { width: 0, height: 0 },
      x,
    };
  }

  private drop(id: string, mount: LiveMount<X>): void {
    mount.host.remove();
    this.mounts.delete(id);
    this.disposeMount(mount);
  }

  mount(instanceId: string, spec: MountSpec): void {
    const existing = this.mounts.get(instanceId);
    if (existing != null && existing.programKey === spec.programKey) {
      existing.used = ++this.clock;
      return;
    }
    if (existing != null) {
      this.drop(instanceId, existing);
    }
    const mount = this.create(instanceId, spec);
    mount.used = ++this.clock;
    this.mounts.set(instanceId, mount);
    if (this.mounts.size > MAX_MOUNTS) {
      const oldest = [...this.mounts.entries()]
        .filter(([id]) => id !== instanceId && !this.touched.has(id))
        .sort((a, b) => a[1].used - b[1].used)[0];
      if (oldest != null) {
        this.drop(oldest[0], oldest[1]);
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
    this.sizeHost(mount, outerW, outerH);
    mount.outer.style.width = outerW + "px";
    mount.outer.style.height = outerH + "px";
    const root = mount.root;
    root.style.left = bleed + "px";
    root.style.top = bleed + "px";
    root.style.width = layoutBox.width + "px";
    root.style.height = layoutBox.height + "px";
    mount.bleed = bleed;
    mount.layoutBox = { width: layoutBox.width, height: layoutBox.height };
    mount.raster = state.raster ?? null;

    // The tree is rebuilt only when the words or the seed change: text slots
    // and the split are a function of both, and rebuilding also restarts every
    // CSS animation, which the seek below makes harmless.
    const texts = JSON.stringify(state.texts);
    if (texts !== mount.texts || state.seed !== mount.seed) {
      const nodes = splitTree(fillTextSlots(mount.spec.nodes, state.texts), {
        programHash: mount.spec.programHash,
        seed: state.seed,
      });
      // Not `replaceChildren`, which Chrome 85 (the oldest the editor runs
      // on) does not have.
      while (root.firstChild != null) {
        root.removeChild(root.firstChild);
      }
      for (const node of nodes) {
        root.appendChild(build(node, mount.spec));
      }
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
  private fit(mount: LiveMount<X>): void {
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
  protected seek(mount: LiveMount<X>): void {
    const shadow = mount.shadow as ShadowRoot & { getAnimations?: () => Animation[] };
    if (typeof shadow.getAnimations === "function") {
      try {
        seekUntilSettled(mount.animations, () => shadow.getAnimations!(), mount.timeMs);
      } catch {
        // A detached root has no animations to seek.
      }
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

  /**
   * Fonts, images, `data-fit`, lines and the clock for every mount applied
   * since the last settle. Returns those mounts for the host to draw, including
   * any released since (out of the document, so `host.isConnected` is false).
   */
  protected async settleLive(): Promise<LiveMount<X>[]> {
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

    const all = [...this.touched]
      .map((id) => this.mounts.get(id))
      .filter((m): m is LiveMount<X> => m != null);
    this.touched.clear();
    // A mount released since it was applied is out of the document: nothing in
    // it lays out, so it is left to the host to answer for.
    const touched = all.filter((mount) => mount.host.isConnected);

    // Every face the text computes, the default included, before anything is
    // measured: a parameter font's family list ends in the default face, which
    // is not a parameter, so it was never waited for, and `--fit` came out of a
    // fallback face the drawing never uses.
    const loads: Array<Promise<unknown>> = [];
    const arrived = new Set<LiveMount<X>>();
    for (const mount of touched) {
      if (mount.familiesKey === mount.pendingFitKey) {
        continue;
      }
      mount.familiesKey = mount.pendingFitKey;
      for (const [font, { text: all }] of computedFaces(mount.root)) {
        const text = all.slice(0, SAMPLE_CHARS);
        let ready = true;
        try {
          ready = document.fonts.check(font, text);
        } catch {
          continue;
        }
        if (!ready) {
          loads.push(document.fonts.load(font, text).catch(() => []));
          arrived.add(mount);
        }
      }
    }
    if (loads.length > 0) {
      await withTimeout(Promise.all(loads), LOAD_TIMEOUT_MS);
    }

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
      if (fresh.length > 0 || arrived.has(mount) || mount.fitKey !== mount.pendingFitKey) {
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
    return all;
  }

  release(live: ReadonlySet<string>): void {
    for (const [id, mount] of [...this.mounts]) {
      if (!live.has(id)) {
        this.drop(id, mount);
      }
    }
  }

  unmount(instanceId: string): void {
    const mount = this.mounts.get(instanceId);
    if (mount != null) {
      this.drop(instanceId, mount);
    }
  }

  /** How many graphics are mounted. For the perf counters and the tests. */
  get size(): number {
    return this.mounts.size;
  }
}
