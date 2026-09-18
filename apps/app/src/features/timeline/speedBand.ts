/**
 * The speed ramp, drawn over the clip it retimes.
 *
 * `levelLine.ts#levelPolyline` in shape, and deliberately **not** in behaviour:
 * the level line is grabbable and this is draw-only. Editing a ramp changes how
 * long the clip is, so a press on an in-clip band would resize the clip under
 * the pointer on the frame it committed and the x the pointer is over would
 * name a different instant each repaint. `layout.ts#hitTest` is never told
 * about this, so no press can land on it; the graph in the option panel, whose
 * x axis is source time and therefore stands still, is where a ramp is edited.
 *
 * Sampled through `speedAt` rather than drawn from the points, so what is on
 * screen is the function the preview and the export will both ask.
 */

import type { TimelineElement } from "../../@types/timeline";
import { spanLength, spanStart, speedAt } from "./geometry";
import { MAX_SPEED, MIN_SPEED, speedCurveOf } from "./speedCurve";

export type ClipRect = { x: number; y: number; w: number; h: number };

/** How tall the band is, as a fraction of the clip's height. */
export const BAND_FRACTION = 0.45;

const LN_MIN = Math.log(MIN_SPEED);
const LN_MAX = Math.log(MAX_SPEED);

/**
 * Whether this clip has a ramp worth drawing.
 *
 * A clip with a constant rate draws nothing at all, so an unramped project's
 * timeline is pixel-identical to one rendered before this existed.
 */
export function hasSpeedRamp(element: TimelineElement): boolean {
  return speedCurveOf(element) != null;
}

/**
 * Where a rate sits inside the band, in canvas y.
 *
 * Logarithmic, for the reason the option panel's graph is: 1x lands in the
 * middle of the band, so "faster than normal" and "slower than normal" read as
 * up and down from one line rather than from a fifth of the way up.
 */
function rateToY(rate: number, top: number, height: number): number {
  const clamped = Math.min(Math.max(rate, MIN_SPEED), MAX_SPEED);
  const fraction = (Math.log(clamped) - LN_MIN) / (LN_MAX - LN_MIN);
  return top + height - fraction * height;
}

/**
 * The ramp as a polyline across the clip, and the y of the 1x line.
 *
 * Empty when the clip has no ramp, or when nothing of it is on screen. Clipped
 * to the viewport for the reason `levelPolyline` is: a long clip zoomed in is
 * otherwise a thousand samples a repaint for pixels nobody will see.
 */
export function speedPolyline(
  rect: ClipRect,
  element: TimelineElement,
  range: number,
  viewportW: number,
): { points: Array<{ x: number; y: number }>; unityY: number } {
  void range;
  const empty = { points: [], unityY: 0 };
  if (!(rect.w > 0) || !hasSpeedRamp(element)) {
    return empty;
  }

  const height = rect.h * BAND_FRACTION;
  const top = rect.y + (rect.h - height) / 2;
  const unityY = rateToY(1, top, height);

  const from = Math.max(rect.x, 0);
  const to = Math.min(rect.x + rect.w, viewportW);
  if (!(to > from)) {
    return empty;
  }

  const start = spanStart(element);
  const msPerPx = spanLength(element) / rect.w;
  const points: Array<{ x: number; y: number }> = [];
  for (let x = Math.floor(from); x <= Math.ceil(to); x++) {
    points.push({
      x,
      y: rateToY(speedAt(element, start + (x - rect.x) * msPerPx), top, height),
    });
  }
  return { points, unityY };
}
