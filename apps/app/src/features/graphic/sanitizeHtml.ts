/**
 * The markup of an HTML graphic, reduced to a tree that may be mounted.
 *
 * Parsed with parse5, which implements the same parsing algorithm the browser
 * does, so what this inspects is what Chromium would have built; and returned
 * as a tree, never as a string. The host builds the DOM from it with
 * `createElementNS`, `setAttribute` and `textContent` alone, so there is no
 * second parse in which serialised markup could come out as something else
 * (the mutation XSS family, where `<math>` and `<style>` disagree about where a
 * tag ends).
 *
 * An allowlist throughout: a tag or an attribute this file does not name is
 * not there. Four rules carry the rest.
 *
 *  - **A dangerous subtree goes whole.** `<script>`, `<style>` (stylesheets
 *    arrive through `cssFilter.ts`, not markup), embedding, forms, media,
 *    `<template>`, `<noscript>`, `foreignObject`, MathML. Unwrapping one would
 *    keep its children, which is the content it was dangerous for.
 *  - **No custom elements.** A graphic mounts in a shadow root that shares the
 *    editor document's custom element registry, so `<option-text>` would
 *    construct the app's own Lit component and run its constructor. Any tag
 *    with a hyphen goes whole. Any other unknown tag is unwrapped: its text
 *    still reads, and it can do nothing.
 *  - **References stay in the tree.** `href` only on the four SVG elements
 *    that point at something, and only at `#id` (or a declared asset for
 *    `feImage`); `url()` in an attribute only to `#id`; `img src` only to a
 *    declared `asset:<name>`.
 *  - **SMIL cannot rewrite those.** An `<animate>` or `<set>` whose target is
 *    `href`, `style` or an event handler would put back at play time what the
 *    attribute rules removed at load time.
 *
 * DOM-free, never throws, and runs under `environment: "node"`.
 */

import { parseFragment } from "parse5";
import type { Diagnostic } from "../fx/inlineProgram";
import { filterInlineStyle } from "./cssFilter";

export type SafeNode =
  | {
      kind: "element";
      tag: string;
      ns: "html" | "svg";
      attrs: [string, string][];
      children: SafeNode[];
    }
  | { kind: "text"; text: string };

export type SanitizeOptions = {
  /** Names `asset:<name>` may refer to. */
  assetNames: ReadonlySet<string>;
  /** File name for diagnostics, e.g. "index.html". */
  file?: string;
};

/** Bounds on what one program may make the host build. */
export const MAX_HTML_BYTES = 512 * 1024;
export const MAX_NODES = 20_000;
export const MAX_DEPTH = 64;

const NS_HTML = "http://www.w3.org/1999/xhtml";
const NS_SVG = "http://www.w3.org/2000/svg";

const HTML_ELEMENTS = new Set([
  "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b",
  "i", "u", "s", "small", "sub", "sup", "br", "hr", "ul", "ol", "li", "table",
  "thead", "tbody", "tr", "th", "td", "figure", "figcaption", "blockquote",
  "pre", "code", "img", "ruby", "rt", "rp", "mark", "abbr", "q", "cite", "time",
  "wbr", "bdi", "bdo", "del", "ins", "section", "article", "header", "footer",
]);

/** Exact camelCase, as parse5 adjusts SVG tag names. */
const SVG_ELEMENTS = new Set([
  "svg", "g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline",
  "polygon", "text", "tspan", "textPath", "linearGradient", "radialGradient",
  "stop", "clipPath", "mask", "pattern", "filter", "use", "symbol", "marker",
  "animate", "animateTransform", "animateMotion", "mpath", "set",
  "feGaussianBlur", "feOffset", "feBlend", "feColorMatrix", "feComposite",
  "feFlood", "feMerge", "feMergeNode", "feTurbulence", "feDisplacementMap",
  "feMorphology", "feComponentTransfer", "feFuncR", "feFuncG", "feFuncB",
  "feFuncA", "feConvolveMatrix", "feDropShadow", "feTile", "feImage",
  "feSpecularLighting", "feDiffuseLighting", "fePointLight", "feDistantLight",
  "feSpotLight",
]);

/** Removed with everything inside them, compared lowercased. */
const DROPPED_SUBTREES = new Set([
  "script", "style", "template", "iframe", "frame", "frameset", "object",
  "embed", "applet", "link", "meta", "base", "form", "input", "button",
  "textarea", "select", "option", "video", "audio", "source", "track",
  "canvas", "noscript", "noembed", "foreignobject", "math", "portal",
]);

const SMIL_ELEMENTS = new Set(["animate", "set", "animateTransform", "animateMotion"]);

/** The SVG elements that may point at something, and so carry `href`. */
const HREF_ELEMENTS = new Set(["use", "textPath", "mpath", "feImage"]);

const GLOBAL_ATTRS = new Set([
  "class", "id", "style", "title", "dir", "lang", "role", "aria-hidden",
]);

const IMG_ATTRS = new Set(["src", "alt", "width", "height"]);

/** Presentation and geometry attributes, exact case as parse5 adjusts them. */
const SVG_ATTRS = new Set([
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy",
  "d", "points", "width", "height", "viewBox", "preserveAspectRatio",
  "transform", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width",
  "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
  "color-interpolation", "color-interpolation-filters",
  "stroke-dashoffset", "stroke-miterlimit", "opacity", "color", "display",
  "visibility", "overflow", "clip-path", "clip-rule", "mask", "filter",
  "font-family", "font-size", "font-weight", "font-style", "letter-spacing",
  "word-spacing", "text-anchor", "dominant-baseline", "alignment-baseline",
  "baseline-shift", "dx", "dy", "rotate", "textLength", "lengthAdjust",
  "startOffset", "method", "spacing", "side", "path", "pathLength", "offset",
  "stop-color", "stop-opacity", "gradientUnits", "gradientTransform",
  "spreadMethod", "patternUnits", "patternContentUnits", "patternTransform",
  "clipPathUnits", "maskUnits", "maskContentUnits", "filterUnits",
  "primitiveUnits", "in", "in2", "result", "stdDeviation", "mode", "operator",
  "k1", "k2", "k3", "k4", "values", "type", "tableValues", "slope",
  "intercept", "amplitude", "exponent", "baseFrequency", "numOctaves", "seed",
  "stitchTiles", "scale", "xChannelSelector", "yChannelSelector", "radius",
  "kernelMatrix", "order", "divisor", "bias", "targetX", "targetY", "edgeMode",
  "preserveAlpha", "flood-color", "flood-opacity", "lighting-color",
  "surfaceScale", "specularConstant", "specularExponent", "diffuseConstant",
  "azimuth", "elevation", "z", "pointsAtX", "pointsAtY", "pointsAtZ",
  "limitingConeAngle", "markerWidth", "markerHeight", "markerUnits", "refX",
  "refY", "orient", "attributeName", "attributeType", "from", "to", "by",
  "begin", "dur", "end", "repeatCount", "repeatDur", "calcMode", "keyTimes",
  "keySplines", "keyPoints", "additive", "accumulate", "restart", "min", "max",
  "href", "xlink:href",
]);

/** Removed even where some list above might otherwise let them through. */
const BLOCKED_ATTRS = new Set([
  "autofocus", "tabindex", "contenteditable", "popover", "srcset", "ping",
  "formaction", "action",
]);

const DATA_ATTR = /^data-[a-z0-9_.-]+$/;
const FRAGMENT = /^#[A-Za-z_][\w-]*$/;

type ParseNode = {
  nodeName: string;
  tagName?: string;
  namespaceURI?: string;
  attrs?: Array<{ name: string; value: string; prefix?: string; namespace?: string }>;
  childNodes?: ParseNode[];
  value?: string;
  sourceCodeLocation?: { startLine?: number } | null;
};

type State = {
  options: SanitizeOptions;
  removed: Diagnostic[];
  count: number;
  stopped: boolean;
};

function note(state: State, node: ParseNode | null, message: string): void {
  const line = node?.sourceCodeLocation?.startLine;
  state.removed.push({
    ...(state.options.file != null ? { file: state.options.file } : {}),
    ...(line != null ? { line } : {}),
    message,
  });
}

/**
 * The scheme a value would be read as, with whitespace and control characters
 * taken out the way a URL parser takes them out: `jav&#x09;ascript:` arrives
 * from parse5 as `jav<TAB>ascript:`, and is still `javascript:` to Chromium.
 */
function hasScriptScheme(value: string): boolean {
  const squeezed = value.replace(/[\u0000- \u007f]/g, "").toLowerCase();
  return /^(javascript|vbscript|data):/.test(squeezed);
}

/** Every `url(...)` argument, or `null` when one is not closed. */
function urlArgs(value: string): string[] | null {
  const out: string[] = [];
  const pattern = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
  const opened = (value.match(/url\(/gi) ?? []).length;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) != null) {
    out.push(match[2].trim());
  }
  return out.length === opened ? out : null;
}

function attrName(attr: { name: string; prefix?: string }): string {
  return attr.prefix != null && attr.prefix !== "" ? attr.prefix + ":" + attr.name : attr.name;
}

function isAssetRef(value: string, assetNames: ReadonlySet<string>): boolean {
  return value.startsWith("asset:") && assetNames.has(value.slice("asset:".length));
}

/**
 * One attribute's fate: its (possibly rewritten) value, or `null` with the
 * reason already noted.
 */
function filterAttribute(
  tag: string,
  ns: "html" | "svg",
  name: string,
  value: string,
  node: ParseNode,
  state: State,
): string | null {
  const lower = name.toLowerCase();
  const refuse = (why: string): null => {
    note(state, node, "<" + tag + "> " + name + ": " + why);
    return null;
  };

  if (lower.startsWith("on")) {
    return refuse("event handlers never run in a graphic");
  }
  if (BLOCKED_ATTRS.has(lower) || lower.startsWith("xmlns")) {
    return refuse("not allowed");
  }
  if (DATA_ATTR.test(name)) {
    // Data, read by `data-param` and `data-split` and by `attr()`. Never a
    // reference, so the URL rules below do not apply.
    return value;
  }

  const allowed =
    GLOBAL_ATTRS.has(name) ||
    (ns === "html" && tag === "img" && IMG_ATTRS.has(name)) ||
    (ns === "svg" && SVG_ATTRS.has(name));
  if (!allowed) {
    return refuse("not an attribute a graphic uses");
  }
  if (hasScriptScheme(value)) {
    return refuse("a script or data URL");
  }

  if (name === "style") {
    const filtered = filterInlineStyle(value, {
      assetNames: state.options.assetNames,
      ...(state.options.file != null ? { file: state.options.file } : {}),
    });
    state.removed.push(...filtered.removed);
    return filtered.css.trim() === "" ? null : filtered.css;
  }

  if (name === "href" || name === "xlink:href") {
    if (ns !== "svg" || !HREF_ELEMENTS.has(tag)) {
      return refuse("only use, textPath, mpath and feImage may point at something");
    }
    if (FRAGMENT.test(value)) {
      return value;
    }
    if (tag === "feImage" && isAssetRef(value, state.options.assetNames)) {
      return value;
    }
    return refuse("may point only at an #id in this graphic");
  }

  if (ns === "html" && tag === "img" && name === "src") {
    if (isAssetRef(value, state.options.assetNames)) {
      return value;
    }
    return refuse("an image must be a declared asset:<name>");
  }

  if (/url\(/i.test(value)) {
    const args = urlArgs(value);
    if (args == null || !args.every((arg) => FRAGMENT.test(arg))) {
      return refuse("url() may point only at an #id in this graphic");
    }
  }
  return value;
}

/** What SMIL would animate, refused when it could undo the attribute rules. */
function dangerousAnimationTarget(node: ParseNode): string | null {
  for (const attr of node.attrs ?? []) {
    if (attrName(attr) !== "attributeName") {
      continue;
    }
    const target = attr.value.trim().toLowerCase();
    if (
      target === "href" ||
      target === "xlink:href" ||
      target === "style" ||
      target.startsWith("on")
    ) {
      return attr.value;
    }
  }
  return null;
}

function walkChildren(nodes: ParseNode[] | undefined, depth: number, state: State): SafeNode[] {
  const out: SafeNode[] = [];
  for (const child of nodes ?? []) {
    if (state.stopped) {
      break;
    }
    out.push(...walk(child, depth, state));
  }
  return out;
}

function walk(node: ParseNode, depth: number, state: State): SafeNode[] {
  if (state.stopped) {
    return [];
  }
  state.count += 1;
  if (state.count > MAX_NODES) {
    state.stopped = true;
    note(state, node, "more than " + MAX_NODES + " nodes; the rest was not read");
    return [];
  }
  if (depth > MAX_DEPTH) {
    state.stopped = true;
    note(state, node, "nested deeper than " + MAX_DEPTH + "; the rest was not read");
    return [];
  }

  if (node.nodeName === "#text") {
    return [{ kind: "text", text: node.value ?? "" }];
  }
  if (node.nodeName.startsWith("#")) {
    // Comments, CDATA read as a bogus comment, a stray doctype. Nothing a
    // picture needs, and a comment is where markup hides from a reader.
    return [];
  }

  const rawTag = node.tagName ?? node.nodeName;
  const lower = rawTag.toLowerCase();
  const nsUri = node.namespaceURI;

  if (nsUri !== NS_HTML && nsUri !== NS_SVG) {
    note(state, node, "<" + rawTag + "> is MathML or another namespace; removed with its contents");
    return [];
  }
  if (rawTag.includes("-")) {
    note(
      state,
      node,
      "<" + rawTag + "> is a custom element, which would construct the editor's own component; removed with its contents",
    );
    return [];
  }
  if (DROPPED_SUBTREES.has(lower)) {
    note(state, node, "<" + rawTag + "> is not allowed; removed with its contents");
    return [];
  }

  const ns: "html" | "svg" = nsUri === NS_SVG ? "svg" : "html";
  const tag = ns === "svg" ? rawTag : lower;
  const known = ns === "svg" ? SVG_ELEMENTS.has(tag) : HTML_ELEMENTS.has(tag);
  if (!known) {
    note(state, node, "<" + rawTag + "> is not used by graphics; its contents are kept");
    return walkChildren(node.childNodes, depth + 1, state);
  }

  if (ns === "svg" && SMIL_ELEMENTS.has(tag)) {
    const target = dangerousAnimationTarget(node);
    if (target != null) {
      note(state, node, "<" + tag + "> animates " + target + ", which could undo the attribute rules; removed");
      return [];
    }
  }

  const attrs: [string, string][] = [];
  for (const attr of node.attrs ?? []) {
    const name = attrName(attr);
    const kept = filterAttribute(tag, ns, name, attr.value, node, state);
    if (kept != null) {
      attrs.push([name, kept]);
    }
  }

  return [
    {
      kind: "element",
      tag,
      ns,
      attrs,
      children: walkChildren(node.childNodes, depth + 1, state),
    },
  ];
}

export function sanitizeHtml(
  source: string,
  options: SanitizeOptions,
): { nodes: SafeNode[]; removed: Diagnostic[] } {
  const state: State = { options, removed: [], count: 0, stopped: false };
  const text = typeof source === "string" ? source : "";
  if (new TextEncoder().encode(text).length > MAX_HTML_BYTES) {
    note(state, null, "more than " + MAX_HTML_BYTES + " bytes of markup");
    return { nodes: [], removed: state.removed };
  }
  let fragment: ParseNode;
  try {
    fragment = parseFragment(text, { sourceCodeLocationInfo: true }) as unknown as ParseNode;
  } catch (error) {
    note(state, null, "could not be read as HTML: " + String(error));
    return { nodes: [], removed: state.removed };
  }
  try {
    return { nodes: walkChildren(fragment.childNodes, 0, state), removed: state.removed };
  } catch (error) {
    // Never thrown by anything above; kept so a parse5 surprise costs this one
    // program its picture rather than the editor a render.
    note(state, null, "could not be sanitised: " + String(error));
    return { nodes: [], removed: state.removed };
  }
}

const VOID_HTML = new Set(["br", "hr", "img", "wbr"]);

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;");
}

/**
 * The tree as markup. For tests, and for anything that needs a stable text of
 * it; never for mounting, which builds nodes directly so nothing is parsed twice.
 */
export function serializeSafeNodes(nodes: SafeNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += escapeText(node.text);
      continue;
    }
    const attrs = node.attrs.map(([name, value]) => " " + name + '="' + escapeAttr(value) + '"').join("");
    if (node.ns === "html" && VOID_HTML.has(node.tag)) {
      out += "<" + node.tag + attrs + ">";
      continue;
    }
    out += "<" + node.tag + attrs + ">" + serializeSafeNodes(node.children) + "</" + node.tag + ">";
  }
  return out;
}
