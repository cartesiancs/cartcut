/**
 * The teal wash behind a range the user has selected in the option panel's
 * text field.
 *
 * A sibling of `controlOutline.ts` and `nullGizmo.ts`, and here for the same
 * reason they are. `renderTimelineAtTime` is shared by the preview, the in-app
 * export, the offscreen export window, the agent's contact sheet and the e2e
 * reference render, so anything drawn inside it is baked into the delivered
 * file. A selection belongs to whoever is looking at the panel and to nobody
 * else, so `previewCanvas` draws it in the chrome pass afterwards.
 *
 * No casing pass. `controlOutline.ts` draws every mark twice, dark then light,
 * because a one-pixel line has to stay visible over any picture. This is a
 * wash rather than a mark: it is read by its colour over a large area, and an
 * outline around it would make it look like a box somebody drew.
 */

import type { TimelineElement } from "../../@types/timeline";
import { maskOf } from "../mask/maskShape";
import { localSampleAt } from "../timeline/transform";
import { adjustOf } from "./adjust";
import { DEFAULT_BLEND, blendOf } from "./blend";
import { lutOf } from "./lut";

/** One line's worth of selection, in the element's own space. */
export type HighlightRect = { x: number; y: number; w: number; h: number };

/**
 * Light teal, close to what a browser paints for `::selection` on a dark page.
 * Named rather than inlined because the panel may one day want to match it.
 */
export const RANGE_HIGHLIGHT_COLOR = "#5eead4";

/**
 * Opaque enough to read as a selection under the glyphs that are redrawn over
 * it, and short of 1 so the picture behind a parked title is not simply gone.
 */
export const RANGE_HIGHLIGHT_ALPHA = 0.85;

/** The wash, in whatever space the caller has already set up. */
export function drawTextRangeHighlight(
  ctx: CanvasRenderingContext2D,
  rects: readonly HighlightRect[],
): void {
  if (rects.length === 0) {
    return;
  }

  ctx.save();
  ctx.globalAlpha *= RANGE_HIGHLIGHT_ALPHA;
  ctx.fillStyle = RANGE_HIGHLIGHT_COLOR;
  for (const rect of rects) {
    if (rect.w <= 0 || rect.h <= 0) {
      continue;
    }
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  ctx.restore();
}

/**
 * How visible the wash is when it has to go **over** the glyphs instead.
 *
 * Lower than `RANGE_HIGHLIGHT_ALPHA`, because this one tints the letters rather
 * than sitting behind them, and at the full value they stop being readable.
 */
export const OVERLAID_SELECTION_ALPHA = 0.4;

/**
 * Whether the glyphs can honestly be redrawn on top of the wash.
 *
 * The preview's chrome pass runs after the composite has been blitted, and it
 * applies none of the per-element effects `renderElement` does: no blend mode,
 * no mask, no clip opacity, no LUT and no colour grade. Redrawing a clip that
 * carries any of those would put unblended, unmasked, ungraded glyphs next to
 * the composited ones, which reads as the clip losing its look for as long as
 * the panel is open.
 *
 * So the underlay is offered only where the two would agree, and where they
 * would not the caller lays the wash over the top at
 * `OVERLAID_SELECTION_ALPHA`. Both are highlights; one is prettier.
 */
export function canUnderlaySelection(
  element: TimelineElement | null | undefined,
  cursor: number,
): boolean {
  if (element == null) {
    return false;
  }
  return (
    blendOf(element) === DEFAULT_BLEND &&
    maskOf(element) == null &&
    lutOf(element) == null &&
    adjustOf(element) == null &&
    localSampleAt(element, cursor).opacity >= 100
  );
}
