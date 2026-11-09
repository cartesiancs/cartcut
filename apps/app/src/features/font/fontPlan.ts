/**
 * Which font files an SVG snapshot of a graphic must carry, and how much of
 * each.
 *
 * An SVG image loads nothing, so every web font a graphic's text uses travels
 * inside it as a `data:` URL, and is decoded again for every frame. The
 * default face is a 4.7 MB OTF, so a face is cut to the glyphs the graphic can
 * show (`fontSubset.ts`) unless it is small enough to carry whole, which is
 * also the one way to be exact about layouts a subset can still change
 * (`tests/e2e/FINDINGS.md` section 11). DOM-free.
 */

/** A face this small travels whole: exact, and decoded in about 2 ms. */
export const WHOLE_FACE_MAX_BYTES = 256 * 1024;

const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "emoji",
  "math",
  "fangsong",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "-apple-system",
  "blinkmacsystemfont",
]);

/** The names in a `font-family` list, unquoted and lowercased; generic families dropped. */
export function familyNames(list: string): string[] {
  const out: string[] = [];
  for (const raw of list.split(",")) {
    const name = raw
      .trim()
      .replace(/^(["'])([\s\S]*)\1$/, "$2")
      .replace(/\\(.)/g, "$1")
      .trim()
      .toLowerCase();
    if (name !== "" && !GENERIC.has(name) && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

/** A `unicode-range` as inclusive code point ranges; empty means every code point. */
export function parseUnicodeRange(value: string | null | undefined): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (value == null) {
    return out;
  }
  for (const part of value.split(",")) {
    const token = part.trim().replace(/^u\+/i, "");
    if (token === "") {
      continue;
    }
    if (token.includes("?")) {
      out.push([parseInt(token.replace(/\?/g, "0"), 16), parseInt(token.replace(/\?/g, "f"), 16)]);
      continue;
    }
    const [from, to] = token.split("-");
    const start = parseInt(from, 16);
    const end = to != null ? parseInt(to, 16) : start;
    if (Number.isFinite(start) && Number.isFinite(end)) {
      out.push([start, end]);
    }
  }
  return out;
}

/** Whether a face with `ranges` would be used for any of `codepoints`. */
export function rangeHits(ranges: Array<[number, number]>, codepoints: readonly number[]): boolean {
  if (ranges.length === 0) {
    return true;
  }
  return codepoints.some((cp) => ranges.some(([from, to]) => cp >= from && cp <= to));
}

export type FontSource = { url: string; format: string | null } | { local: string };

/** The sources of an `@font-face` `src`, in order. */
export function parseFontSrc(src: string): FontSource[] {
  const out: FontSource[] = [];
  const pattern =
    /(url|local)\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*?))\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?/gi;
  for (const match of src.matchAll(pattern)) {
    const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (match[1].toLowerCase() === "local") {
      out.push({ local: value });
    } else {
      out.push({ url: value, format: match[5]?.trim() ?? null });
    }
  }
  return out;
}

/** Characters a title can show that its text does not hold. */
const ALWAYS = "  -‐‑….,:;!?'\"()[]{}/\\&%#*+=<>@_~0123456789‘’“”«»";

/**
 * Every code point a graphic's text can draw: the text, its upper and lower
 * case in the graphic's language (`text-transform`), and the characters
 * layout and counters add on their own (hyphens, ellipses, digits, quotes,
 * spaces). Sorted, so equal sets give equal cache keys.
 */
export function harvestCodepoints(texts: readonly string[], lang: string): number[] {
  const set = new Set<number>();
  const add = (text: string) => {
    for (const ch of text) {
      set.add(ch.codePointAt(0) ?? 0);
    }
  };
  const locale = lang !== "" ? lang : undefined;
  for (const text of texts) {
    add(text);
    try {
      add(text.toLocaleUpperCase(locale));
      add(text.toLocaleLowerCase(locale));
    } catch {
      add(text.toUpperCase());
      add(text.toLowerCase());
    }
  }
  add(ALWAYS);
  set.delete(0);
  return [...set].sort((a, b) => a - b);
}

/** The table tags of an OpenType or TrueType file, or `null` for anything else (WOFF, WOFF2). */
export function sfntTables(bytes: Uint8Array): string[] | null {
  if (bytes.length < 12) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0);
  const sfnt = version === 0x00010000 || version === 0x4f54544f || version === 0x74727565;
  if (!sfnt) {
    return null;
  }
  const count = view.getUint16(4);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 16;
    if (at + 4 > bytes.length) {
      break;
    }
    out.push(String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]));
  }
  return out;
}

/**
 * Tables HarfBuzz copies through unsubset. They name glyphs by id, so the
 * subset must keep every glyph at its id or they point at the wrong ones:
 * PermanentMarker's `kern` laid a line out 106 px short in every engine.
 */
const PASSED_THROUGH = new Set(["kern", "kerx", "morx", "mort", "feat", "trak", "just", "ankr", "opbd", "prop", "bsln", "lcar"]);

export type EmbedPlan = { kind: "whole" } | { kind: "subset"; retainGids: boolean };

/** Whole when small or not an sfnt (WOFF2 cannot be subset here); otherwise subset. */
export function embedPlan(bytes: Uint8Array): EmbedPlan {
  const tables = sfntTables(bytes);
  if (tables == null || bytes.length <= WHOLE_FACE_MAX_BYTES) {
    return { kind: "whole" };
  }
  return { kind: "subset", retainGids: tables.some((tag) => PASSED_THROUGH.has(tag)) };
}

/** The `format()` and media type a face's bytes are. */
export function fontKind(bytes: Uint8Array): { mime: string; format: string } {
  const tag = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  if (tag === "wOF2") return { mime: "font/woff2", format: "woff2" };
  if (tag === "wOFF") return { mime: "font/woff", format: "woff" };
  if (tag === "OTTO") return { mime: "font/otf", format: "opentype" };
  return { mime: "font/ttf", format: "truetype" };
}

/** Bytes as base64, in chunks so a large face does not overflow the argument stack. */
export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(binary);
}
