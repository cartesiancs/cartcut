/**
 * Shadows WebKit leaves out of an SVG image, drawn by an SVG filter instead.
 *
 * Inside an SVG image WebKit draws only the first layer of a `text-shadow`
 * list, and an outer `box-shadow` only when it is the element's one shadow and
 * the box has a background: two outer layers draw nothing, and neither does
 * one under a transparent box (`tests/e2e/FINDINGS.md` section 11). Its live
 * page draws all of them, and it draws SVG filters on HTML correctly. So where
 * the probe saw this, each such element's shadows, read from computed style at
 * time t, become one filter: a shadow per layer under the element's own
 * picture, in the order CSS paints them (the first layer on top).
 *
 *  - A text shadow is the element's alpha, offset, blurred and coloured.
 *  - An outer box shadow is the border box (with its corner radii), spread,
 *    blurred, offset, coloured, and cut away where the box itself is, as CSS
 *    clips it.
 *
 * Inset box shadows stay as CSS, which WebKit draws. DOM-free: computed values
 * in, filter markup out.
 */

import { escapeAttr } from "./snapshotMarkup";
import { splitTopLevel } from "./snapshotCss";

export type ShadowLayer = {
  color: string;
  x: number;
  y: number;
  blur: number;
  spread: number;
  inset: boolean;
};

const LENGTH = /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?px$/i;

/**
 * A computed `text-shadow` or `box-shadow` list. Every engine writes lengths
 * in px and the colour as one token (`rgb(...)`, `color(srgb ...)`, a
 * keyword), before or after them. `[]` for `none` or anything unreadable.
 */
export function parseComputedShadows(value: string): ShadowLayer[] {
  const text = value.trim();
  if (text === "" || text === "none") {
    return [];
  }
  const out: ShadowLayer[] = [];
  for (const layer of splitTopLevel(text, ",")) {
    const lengths: number[] = [];
    let color = "";
    let inset = false;
    for (const token of splitTopLevel(layer, " ")) {
      if (token === "inset") {
        inset = true;
      } else if (LENGTH.test(token) || token === "0") {
        lengths.push(parseFloat(token));
      } else {
        color = token;
      }
    }
    if (lengths.length < 2) {
      return [];
    }
    out.push({
      color: color === "" ? "currentcolor" : color,
      x: lengths[0],
      y: lengths[1],
      blur: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
      inset,
    });
  }
  return out;
}

/** A computed `box-shadow` list written back without its outer layers. */
export function insetOnly(layers: readonly ShadowLayer[]): string {
  const inset = layers.filter((layer) => layer.inset);
  if (inset.length === 0) {
    return "none";
  }
  return inset
    .map((l) => `inset ${l.x}px ${l.y}px ${l.blur}px ${l.spread}px ${l.color}`)
    .join(", ");
}

/** Corner radii of the border box, in px, clockwise from the top left: [x, y] each. */
export type Radii = [[number, number], [number, number], [number, number], [number, number]];

export type ShadowBox = { width: number; height: number; radii: Radii };

function n(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** The border box's outline as an SVG path, rounded corners included. */
export function roundedRectPath(box: ShadowBox, grow = 0): string {
  const w = box.width + 2 * grow;
  const h = box.height + 2 * grow;
  const x0 = -grow;
  const y0 = -grow;
  // Corner radii grow with the spread, as CSS's do, and never past half a side.
  const r = box.radii.map(([rx, ry]) => {
    const ax = rx > 0 ? Math.max(0, rx + grow) : 0;
    const ay = ry > 0 ? Math.max(0, ry + grow) : 0;
    return [Math.min(ax, w / 2), Math.min(ay, h / 2)];
  });
  const [tl, tr, br, bl] = r;
  return (
    `M${n(x0 + tl[0])} ${n(y0)}` +
    `H${n(x0 + w - tr[0])}` +
    (tr[0] > 0 || tr[1] > 0 ? `A${n(tr[0])} ${n(tr[1])} 0 0 1 ${n(x0 + w)} ${n(y0 + tr[1])}` : "") +
    `V${n(y0 + h - br[1])}` +
    (br[0] > 0 || br[1] > 0 ? `A${n(br[0])} ${n(br[1])} 0 0 1 ${n(x0 + w - br[0])} ${n(y0 + h)}` : "") +
    `H${n(x0 + bl[0])}` +
    (bl[0] > 0 || bl[1] > 0 ? `A${n(bl[0])} ${n(bl[1])} 0 0 1 ${n(x0)} ${n(y0 + h - bl[1])}` : "") +
    `V${n(y0 + tl[1])}` +
    (tl[0] > 0 || tl[1] > 0 ? `A${n(tl[0])} ${n(tl[1])} 0 0 1 ${n(x0 + tl[0])} ${n(y0)}` : "") +
    "Z"
  );
}

/** The box's shape, `grow` px larger on every side, as an image a filter can place. */
function shapeImage(box: ShadowBox, grow: number, pad: number): string {
  const w = box.width + 2 * pad;
  const h = box.height + 2 * pad;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" viewBox="${n(-pad)} ${n(-pad)} ${n(w)} ${n(h)}">` +
    `<path d="${roundedRectPath(box, grow)}" fill="#000"/></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/** How far past the box a set of shadows can reach. */
function reach(layers: readonly ShadowLayer[]): number {
  let out = 0;
  for (const l of layers) {
    out = Math.max(out, Math.abs(l.x) + Math.abs(l.y) + Math.max(0, l.spread) + 3 * l.blur);
  }
  return Math.ceil(out + 2);
}

/**
 * An SVG `<filter>` drawing `layers` under the element's own picture, or
 * `null` when there is nothing it can draw. `kind` "text" shadows the
 * element's alpha; "box" shadows the border box (`box` required), outer layers
 * only.
 *
 * A box filter is written in bounding-box units throughout: WebKit places a
 * filter's user space on an HTML element somewhere other than its border box,
 * so absolute positions cut the shadow and the box away, while fractions of
 * the box land the same in WebKit, Blink and Gecko (measured: the filter drew
 * the same pixels as Blink's own box-shadow, to within 2 of 2700).
 */
export function shadowFilter(
  id: string,
  kind: "text" | "box",
  layers: readonly ShadowLayer[],
  box?: ShadowBox,
): string | null {
  const used = kind === "box" ? layers.filter((layer) => !layer.inset) : layers;
  if (used.length === 0) {
    return null;
  }
  if (kind === "box" && (box == null || !(box.width > 0) || !(box.height > 0))) {
    return null;
  }
  const pad = reach(used);
  // In box units a length along x is a fraction of the width, along y of the height.
  const fx = (value: number) => (box != null ? value / box.width : value);
  const fy = (value: number) => (box != null ? value / box.height : value);
  let region: string;
  let image = (_grow: number, _result: string) => "";
  if (kind === "box" && box != null) {
    const sub = `x="${n(fx(-pad))}" y="${n(fy(-pad))}" width="${n(fx(box.width + 2 * pad))}" height="${n(fy(box.height + 2 * pad))}"`;
    region = `filterUnits="objectBoundingBox" primitiveUnits="objectBoundingBox" ${sub}`;
    image = (grow, result) =>
      `<feImage xlink:href="${escapeAttr(shapeImage(box, grow, pad))}" ${sub} preserveAspectRatio="none" result="${result}"/>`;
  } else {
    region = `x="-100%" y="-100%" width="300%" height="300%"`;
  }
  let body = kind === "box" ? image(0, "box") : "";
  const merged: string[] = [];
  // CSS paints the first layer on top, so the last is merged first.
  for (let i = used.length - 1; i >= 0; i -= 1) {
    const l = used[i];
    const key = `s${i}`;
    let source = "SourceAlpha";
    if (kind === "box") {
      body += image(l.spread, `${key}a`);
      source = `${key}a`;
    }
    if (l.blur > 0) {
      const deviation = l.blur / 2;
      body += `<feGaussianBlur in="${source}" stdDeviation="${n(fx(deviation))} ${n(fy(deviation))}" result="${key}b"/>`;
      source = `${key}b`;
    }
    body += `<feOffset in="${source}" dx="${n(fx(l.x))}" dy="${n(fy(l.y))}" result="${key}o"/>`;
    body += `<feFlood style="flood-color:${escapeAttr(l.color)}" result="${key}c"/>`;
    body += `<feComposite in="${key}c" in2="${key}o" operator="in" result="${key}s"/>`;
    if (kind === "box") {
      // An outer box shadow is never drawn where the box is.
      body += `<feComposite in="${key}s" in2="box" operator="out" result="${key}"/>`;
    } else {
      body += `<feMerge result="${key}"><feMergeNode in="${key}s"/></feMerge>`;
    }
    merged.push(key);
  }
  body += `<feMerge>${merged.map((key) => `<feMergeNode in="${key}"/>`).join("")}<feMergeNode in="SourceGraphic"/></feMerge>`;
  return `<filter id="${escapeAttr(id)}" ${region} color-interpolation-filters="sRGB">${body}</filter>`;
}
