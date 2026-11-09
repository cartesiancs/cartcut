/**
 * Small pieces of style the snapshot host writes on an element's copy. Pure,
 * so they are tested in node; `snapshotHost.ts` reads computed style and hands
 * the strings here.
 */

/** Outranks any selector a program writes with fewer than three ids. */
export const STRONG = ":not(#cc-none):not(#cc-none):not(#cc-none)";

export function appendStyle(style: string, extra: string): string {
  if (extra === "") {
    return style;
  }
  const trimmed = style.trim();
  return trimmed === "" || trimmed.endsWith(";") ? style + extra : style + ";" + extra;
}

/** No background colour or image: the box itself is not drawn. */
export function clearBox(style: { backgroundColor: string; backgroundImage: string }): boolean {
  const colour = style.backgroundColor.replace(/\s+/g, "");
  const clear =
    colour === "transparent" ||
    /^rgba\(\d+,\d+,\d+,0\)$/.test(colour) ||
    /\/0\)$/.test(colour);
  return clear && style.backgroundImage === "none";
}

/** One corner's computed radius, `[x, y]` in px against a box of `width` x `height`. */
export function cornerOf(value: string, width: number, height: number): [number, number] {
  const parts = value.trim().split(/\s+/);
  const read = (token: string | undefined, side: number) =>
    token == null ? Number.NaN : token.endsWith("%") ? (parseFloat(token) / 100) * side : parseFloat(token);
  const x = read(parts[0], width);
  const y = parts.length > 1 ? read(parts[1], height) : parts[0]?.endsWith("%") ? read(parts[0], height) : x;
  return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0];
}

/**
 * A computed `url()` pointing into this document, written back as a fragment.
 * WebKit can answer `url("https://page/#f")` for `url(#f)`, which the image
 * would read as another document and draw nothing for.
 */
export function localUrls(value: string): string {
  return value.replace(/url\((["']?)[^"')#]*#([^"')]+)\1\)/g, "url(#$2)");
}

const ANGLE = /^(-?[\d.]+(?:e-?\d+)?)(deg|rad|turn|grad)$/;

export function degrees(token: string): number {
  const match = ANGLE.exec(token.trim());
  if (match == null) {
    return 0;
  }
  const value = Number(match[1]);
  switch (match[2]) {
    case "rad":
      return (value * 180) / Math.PI;
    case "turn":
      return value * 360;
    case "grad":
      return value * 0.9;
    default:
      return value;
  }
}

/** Rules that leave only the element marked `mark` visible, as black text, in its own untransformed box. */
export function maskRules(mark: string): string {
  const self = `[data-cc-m="${mark}"]${STRONG}`;
  const settled =
    "transform:none !important;translate:none !important;rotate:none !important;scale:none !important;" +
    "opacity:1 !important;filter:none !important;mask:none !important;-webkit-mask:none !important;clip-path:none !important;";
  return (
    `cc-host *${STRONG}{visibility:hidden !important;}` +
    `${self},${self} *{visibility:visible !important;color:#000 !important;-webkit-text-fill-color:#000 !important;` +
    "background:none !important;text-shadow:none !important;box-shadow:none !important;" +
    "border-color:transparent !important;outline-color:transparent !important;}" +
    `${self}{${settled}}` +
    `[data-cc-a]${STRONG}{${settled}}`
  );
}

/**
 * The registered custom properties whose syntax is `<integer>`, from a
 * program's `@property` rules. WebKit interpolates them without rounding, so
 * `counter-reset: n var(--n)` reads `1359.4`, is invalid, and the counter
 * stays at 0 (measured 2026-11-09); the snapshot pins them to their rounded
 * live value.
 */
export function integerProperties(propertyRules: string): string[] {
  const out: string[] = [];
  const pattern = /@property\s+(--[\w-]+)\s*\{([^}]*)\}/g;
  for (const match of propertyRules.matchAll(pattern)) {
    if (/syntax\s*:\s*["']\s*<integer>\s*["']/i.test(match[2])) {
      out.push(match[1]);
    }
  }
  return out;
}

/** A computed integer property's value rounded, or `null` when it is already whole or not a number. */
export function roundedInteger(value: string): string | null {
  const trimmed = value.trim();
  if (!/^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i.test(trimmed)) {
    return null;
  }
  const number = Number(trimmed);
  return Number.isInteger(number) ? null : String(Math.round(number));
}
