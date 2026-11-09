/**
 * A graphic's live tree written out as XML, for the body of its SVG snapshot.
 *
 * Not `XMLSerializer`, because what it writes is not always well-formed or
 * faithful, and an SVG image that fails to parse draws nothing at all:
 *
 *  - a lone surrogate (a text slot cut in the middle of an emoji,
 *    `htmlContract.ts#textSlotsFor` slices UTF-16) becomes U+FFFD, which is
 *    what the live tree draws for it, and C0 controls XML forbids are dropped;
 *  - `\n`, `\t` and `\r` in an attribute are written as character references,
 *    because XML's attribute normalisation turns them into spaces, which
 *    changes `content: attr(data-x)` and a `style` value;
 *  - `\r` in text is a reference too, or the parser folds it into `\n`;
 *  - a namespace is declared wherever it changes, and a name XML cannot hold
 *    drops its element rather than the document.
 *
 * Over a node-shaped interface, so it is tested in node against an XML parser
 * that shares no code with it.
 */

export const HTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";
export const XLINK_NS = "http://www.w3.org/1999/xlink";

type AttrLike = { readonly name: string; readonly value: string };

export type NodeLike = {
  readonly nodeType: number;
  readonly nodeValue: string | null;
  readonly namespaceURI: string | null;
  readonly localName: string | null;
  readonly attributes?: { readonly length: number; readonly [index: number]: AttrLike };
  readonly childNodes: { readonly length: number; readonly [index: number]: NodeLike };
};

/**
 * What to write for an element: its attributes as they should appear, or
 * `null` to leave the element and everything under it out.
 */
export type ElementEdit = (
  node: NodeLike,
  attrs: Array<[string, string]>,
) => Array<[string, string]> | null;

const ELEMENT = 1;
const TEXT = 3;
const CDATA = 4;

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;

/**
 * `text` with every lone surrogate replaced and every character XML 1.0
 * forbids removed. A loop rather than a lookbehind: Safari before 16.4 cannot
 * parse one, and a regex it cannot parse breaks the whole bundle.
 */
export function wellFormed(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i += 1;
      } else {
        out += "�";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "�";
      continue;
    }
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0xfffe ||
      code === 0xffff
    ) {
      continue;
    }
    out += text[i];
  }
  return out;
}

export function escapeText(text: string): string {
  return wellFormed(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;");
}

export function escapeAttr(value: string): string {
  return wellFormed(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;")
    .replace(/\t/g, "&#9;");
}

function attrsOf(node: NodeLike): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const list = node.attributes;
  if (list == null) {
    return out;
  }
  for (let i = 0; i < list.length; i += 1) {
    out.push([list[i].name, list[i].value]);
  }
  return out;
}

/** One node and everything under it, as XML. `parentNs` is the namespace in force. */
export function serializeNode(node: NodeLike, edit?: ElementEdit, parentNs: string = HTML_NS): string {
  if (node.nodeType === TEXT || node.nodeType === CDATA) {
    return escapeText(node.nodeValue ?? "");
  }
  if (node.nodeType !== ELEMENT) {
    return "";
  }
  const name = node.localName ?? "";
  if (!NAME.test(name) || name.includes(":")) {
    return "";
  }
  const ns = node.namespaceURI ?? HTML_NS;
  let attrs: Array<[string, string]> | null = attrsOf(node);
  if (edit != null) {
    attrs = edit(node, attrs);
    if (attrs == null) {
      return "";
    }
  }
  let open = "<" + name;
  if (ns !== parentNs) {
    open += ` xmlns="${escapeAttr(ns)}"`;
  }
  const seen = new Set<string>();
  let xlink = false;
  for (const [attr, value] of attrs) {
    if (!NAME.test(attr) || attr === "xmlns" || attr.startsWith("xmlns:") || seen.has(attr)) {
      continue;
    }
    const prefix = attr.includes(":") ? attr.slice(0, attr.indexOf(":")) : null;
    if (prefix != null && prefix !== "xlink" && prefix !== "xml") {
      continue;
    }
    if (prefix === "xlink" && !xlink) {
      xlink = true;
      open += ` xmlns:xlink="${XLINK_NS}"`;
    }
    seen.add(attr);
    open += ` ${attr}="${escapeAttr(value)}"`;
  }
  let inner = "";
  for (let i = 0; i < node.childNodes.length; i += 1) {
    inner += serializeNode(node.childNodes[i], edit, ns);
  }
  return inner === "" ? open + "/>" : open + ">" + inner + "</" + name + ">";
}
