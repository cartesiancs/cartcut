/**
 * The SVG document a graphic's snapshot is, around its body and styles.
 *
 *  - **Sized at the raster, with no `viewBox`.** WebKit draws shadows right
 *    only at an SVG's natural size, and ignores the `viewBox` origin for
 *    transformed layers, so the image is exactly the pixels it is drawn into
 *    and the graphic is scaled up inside it: `transform: scale()` on the host
 *    element, from its corner. A transform, never `zoom`, so the layout is the
 *    live mount's to the pixel and only the drawing is larger. Text drawn this
 *    way is as crisp as `fillText` at the larger size (section 11).
 *  - **`cc-host` is the shadow host**: `snapshotCss.ts` scopes every rule under
 *    it, and the base sheet's `:host` rule styles it. The live host's `lang`
 *    and `dir` go on it, which a shadow tree would have inherited.
 *  - **The styles go in CDATA**, with any `]]>` split, so CSS nesting's `&`
 *    and a `<` inside a string do not end the document.
 *  - **A `data:` URL, never `blob:`.** Chrome and Safari taint a canvas that
 *    draws a `blob:` SVG holding a `foreignObject`; a `data:` one taints in no
 *    engine measured, so `getImageData`, `VideoFrame` and WebGL keep working.
 */

import { HOST_TAG } from "./snapshotCss";
import { escapeAttr, HTML_NS, SVG_NS, XLINK_NS } from "./snapshotMarkup";

export type SnapshotParts = {
  /** The image's size: the raster it is drawn into, in pixels. */
  rasterWidth: number;
  rasterHeight: number;
  /** The live outer box, in CSS pixels: the graphic's layout plus bleed. */
  outerWidth: number;
  outerHeight: number;
  lang: string;
  dir: string;
  /** Every rule the snapshot needs, already scoped. */
  css: string;
  /** The serialised graphic root. */
  body: string;
  /**
   * Show only this rectangle of the graphic, in its own CSS pixels, at that
   * size: the nested image that masks one element's text (Gecko's missing
   * `background-clip: text`). Never used in WebKit, whose `viewBox` handling
   * of transformed layers is the reason the main image has none.
   */
  crop?: { x: number; y: number; width: number; height: number };
};

export function cdata(text: string): string {
  return "<![CDATA[" + text.replace(/]]>/g, "]]]]><![CDATA[>") + "]]>";
}

function num(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}

export function snapshotSvg(parts: SnapshotParts): string {
  const w = Math.max(1, Math.round(parts.rasterWidth));
  const h = Math.max(1, Math.round(parts.rasterHeight));
  const sx = parts.outerWidth > 0 ? w / parts.outerWidth : 1;
  const sy = parts.outerHeight > 0 ? h / parts.outerHeight : 1;
  const hostStyle =
    "display:block;position:relative;overflow:hidden;margin:0;" +
    `width:${num(parts.outerWidth)}px;height:${num(parts.outerHeight)}px;` +
    `transform:scale(${num(sx)},${num(sy)});transform-origin:0 0;`;
  const lang = parts.lang !== "" ? ` lang="${escapeAttr(parts.lang)}" xml:lang="${escapeAttr(parts.lang)}"` : "";
  const dir = parts.dir !== "" ? ` dir="${escapeAttr(parts.dir)}"` : "";
  const crop = parts.crop;
  const frame =
    crop != null
      ? `width="${num(crop.width)}" height="${num(crop.height)}" viewBox="${num(crop.x)} ${num(crop.y)} ${num(crop.width)} ${num(crop.height)}"`
      : `width="${w}" height="${h}"`;
  return (
    `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" ${frame}>` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}" style="width:${w}px !important;height:${h}px !important">` +
    `<${HOST_TAG} xmlns="${HTML_NS}"${lang}${dir} style="${escapeAttr(hostStyle)}">` +
    `<style>${cdata(parts.css)}</style>` +
    parts.body +
    `</${HOST_TAG}></foreignObject></svg>`
  );
}

/** The image source for a snapshot: a `data:` URL, percent-encoded. */
export function svgDataUrl(svg: string): string {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
