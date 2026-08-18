/**
 * Horizontal placement of a wrapped text line within its box.
 *
 * The original renderers repeated a three-way `align == "left" / "center" /
 * "right"` branch five times over (drawText and drawTextBackground in
 * previewCanvas, controllers/render.ts, offscreen-render.ts, and the legacy
 * prerender). The three branches differ only in this one x coordinate, so the
 * wrapping loop can be written once and parameterised by this function.
 */

export type TextAlign = "left" | "center" | "right";

/** x at which a line of width `lineWidth` starts inside the box `[boxX, boxX+boxW]`. */
export function alignedLineX(
  align: TextAlign | string | undefined,
  boxX: number,
  boxW: number,
  lineWidth: number,
): number {
  if (align === "center") return boxX + boxW / 2 - lineWidth / 2;
  if (align === "right") return boxX + boxW - lineWidth;
  return boxX;
}

/** Padding the original `drawTextBackground` applied around each line's box. */
export const TEXT_BACKGROUND_PADDING = 12;

/**
 * Background rectangle behind one line. Matches the originals exactly: the box
 * starts one padding left of the line and is one padding wider than it — note
 * that this is asymmetric (padding is *not* added on both sides).
 */
export function textBackgroundBox(
  align: TextAlign | string | undefined,
  boxX: number,
  boxW: number,
  lineWidth: number,
): { x: number; width: number } {
  return {
    x: alignedLineX(align, boxX, boxW, lineWidth) - TEXT_BACKGROUND_PADDING,
    width: lineWidth + TEXT_BACKGROUND_PADDING,
  };
}
