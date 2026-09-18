/**
 * Turning a crop session's rectangle into something that can be drawn and
 * pointed at.
 *
 * Two coordinate systems meet here and nowhere else:
 *
 *  - **Normalized frame**, where the whole source frame is the unit square. The
 *    session and the stored `crop` field both live here.
 *  - **Element-local pixels**, the space `renderElement` draws the clip's box in
 *    and the space `previewCanvas` can reach by inverting the clip's world
 *    matrix.
 *
 * The bridge is the one fact `cropOps.ts` states: the clip's box holds the
 * *cropped* picture, so the whole frame occupies `box.width / crop.width`, and
 * the frame's top-left sits at `(-crop.x * Wf, -crop.y * Hf)` in box coordinates.
 * Everything below is that, applied twice.
 *
 * `crop` throughout is the clip's **committed** crop, not the session's live
 * rectangle: it is what places the box on the frame, and it does not move while
 * the user drags.
 */

import type { CropRect } from "../../@types/timeline";
import { frameBoxOf } from "../timeline/cropOps";
import type { StretchZone } from "../preview/hitTest";

export type CropPoint = { x: number; y: number };

export type CropBox = { width: number; height: number };

/** Element-local pixels for a point in normalized frame coordinates. */
export function localOfFrame(
  point: CropPoint,
  crop: CropRect,
  box: CropBox,
): CropPoint {
  const frame = frameBoxOf(box, crop);
  return {
    x: (point.x - crop.x) * frame.width,
    y: (point.y - crop.y) * frame.height,
  };
}

/** Normalized frame coordinates for a point in element-local pixels. */
export function frameOfLocal(
  point: CropPoint,
  crop: CropRect,
  box: CropBox,
): CropPoint {
  const frame = frameBoxOf(box, crop);
  return {
    x: frame.width === 0 ? crop.x : point.x / frame.width + crop.x,
    y: frame.height === 0 ? crop.y : point.y / frame.height + crop.y,
  };
}

/** A rectangle in normalized frame coordinates, as element-local pixels. */
export function localRectOfFrame(
  rect: CropRect,
  crop: CropRect,
  box: CropBox,
): { x: number; y: number; width: number; height: number } {
  const frame = frameBoxOf(box, crop);
  const topLeft = localOfFrame({ x: rect.x, y: rect.y }, crop, box);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: rect.width * frame.width,
    height: rect.height * frame.height,
  };
}

/**
 * A grab band of `pixels` element-local pixels, as a fraction of the frame on
 * each axis.
 *
 * Two numbers rather than one because a grab target is a property of the
 * pointer, the same number of screen pixels whatever the artwork is doing, and
 * the frame is not square in normalized coordinates, so one fraction would make
 * the bands on the short axis fatter than the ones on the long axis.
 */
export function grabOf(
  pixels: number,
  crop: CropRect,
  box: CropBox,
): { x: number; y: number } {
  const frame = frameBoxOf(box, crop);
  return {
    x: frame.width > 0 ? pixels / frame.width : 0,
    y: frame.height > 0 ? pixels / frame.height : 0,
  };
}

/** The eight grips, in the order `previewCanvas` draws them. */
export const CROP_HANDLE_ZONES: readonly StretchZone[] = [
  "stretchNW",
  "stretchN",
  "stretchNE",
  "stretchE",
  "stretchSE",
  "stretchS",
  "stretchSW",
  "stretchW",
];

/**
 * Where each grip sits on a rectangle, in normalized frame coordinates.
 *
 * Corners at the corners and edge grips at the midpoints, which is where
 * `preview/hitTest.ts` puts a clip's own eight and therefore where a user
 * already expects to find them.
 */
export function cropHandlePoints(
  rect: CropRect,
): Array<{ zone: StretchZone; point: CropPoint }> {
  const left = rect.x;
  const midX = rect.x + rect.width / 2;
  const right = rect.x + rect.width;
  const top = rect.y;
  const midY = rect.y + rect.height / 2;
  const bottom = rect.y + rect.height;

  const at: Record<StretchZone, CropPoint> = {
    stretchNW: { x: left, y: top },
    stretchN: { x: midX, y: top },
    stretchNE: { x: right, y: top },
    stretchE: { x: right, y: midY },
    stretchSE: { x: right, y: bottom },
    stretchS: { x: midX, y: bottom },
    stretchSW: { x: left, y: bottom },
    stretchW: { x: left, y: midY },
  };

  return CROP_HANDLE_ZONES.map((zone) => ({ zone, point: at[zone] }));
}

/**
 * The CSS cursor each grip wants, plus the body's.
 *
 * Typed as a closed union rather than `string`, because `previewCanvas` keeps
 * its own closed union of the cursors it may show and a widened lookup would
 * not check against it.
 */
export type CropCursor =
  | "nwse-resize"
  | "nesw-resize"
  | "ns-resize"
  | "ew-resize"
  | "move";

export const CROP_CURSORS: Record<string, CropCursor> = {
  stretchNW: "nwse-resize",
  stretchSE: "nwse-resize",
  stretchNE: "nesw-resize",
  stretchSW: "nesw-resize",
  stretchN: "ns-resize",
  stretchS: "ns-resize",
  stretchE: "ew-resize",
  stretchW: "ew-resize",
  inside: "move",
};

/**
 * The rule-of-thirds guides, as fractions along the rectangle.
 *
 * Thirds rather than a centre cross: a crop is a framing decision, and the
 * thirds are the lines people actually frame against.
 */
export const CROP_THIRDS: readonly number[] = [1 / 3, 2 / 3];
