/**
 * One frame of one Text panel tile.
 *
 * Kept apart from `textTilePainter.ts` so it can be drawn in node: the painter
 * hands it the export's renderer table, whose image renderer reaches for
 * `document` the moment it is imported, and the pixel suite hands it the text
 * renderer alone. The drawing is the same either way, because a tile's map
 * holds one text clip and nothing else.
 */

import type { TextElementType } from "../../@types/timeline";
import { measureTextDetail } from "../renderer/text";
import { renderTimelineAtTime, type TimelineRenderers } from "../renderer/timeline";
import { tileViewOf, type TileSpec, type TileView } from "./textTile";

/**
 * The crop, measured against whatever face the canvas resolves right now.
 * Call it after the face has loaded: the fallback has other widths.
 */
export function measureTileView(
  canvas: HTMLCanvasElement,
  element: TextElementType,
): TileView | null {
  const ctx = canvas.getContext("2d");
  if (ctx == null) {
    return null;
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const metrics = measureTextDetail(ctx, element);
  ctx.restore();
  return tileViewOf(element, metrics);
}

/**
 * `spec` at clip ms `timeMs`, cropped to `view`.
 *
 * Cleared and reset under identity first: `paint` fills the frame with the
 * background colour, which here is transparent and covers nothing, and
 * `drawDirect` multiplies into `globalAlpha`.
 */
export function drawTile(
  canvas: HTMLCanvasElement,
  spec: TileSpec,
  view: TileView,
  timeMs: number,
  renderers: TimelineRenderers,
): void {
  const ctx = canvas.getContext("2d");
  if (ctx == null) {
    return;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const k = canvas.width / view.w;
  ctx.save();
  ctx.setTransform(k, 0, 0, k, -view.x * k, -view.y * k);
  renderTimelineAtTime(
    ctx,
    spec.timeline,
    timeMs,
    renderers,
    "rgba(0, 0, 0, 0)",
    spec.frame.w,
    spec.frame.h,
  );
  ctx.restore();
}
