/**
 * The aspect ratios the crop panel offers, and how one becomes a rectangle.
 *
 * A ratio here is the **drawn** rectangle's width over its height, which is what
 * a person means by "16:9". Everything that consumes it converts into normalized
 * frame coordinates itself, because the frame is only square in those
 * coordinates and a preset that locked the normalized ratio would deliver 16:9
 * only on square footage.
 */

import type { CropRect } from "../../@types/timeline";
import { FULL_CROP, MIN_CROP } from "../timeline/cropOps";

export type CropAspect = {
  /** Stable id, used as the panel's selection key. */
  id: string;
  label: string;
  /**
   * Drawn width over drawn height, `null` for a free drag, and `"frame"` for
   * the frame's own shape.
   *
   * `"frame"` rather than a number because the frame's shape is a property of
   * the clip, not of the preset: reading `element.ratio` instead would give the
   * *source file's* aspect, which is a different number for any clip the user
   * has stretched. `preview/resizeMath.ts:1-26` records what reading that field
   * for a live aspect cost the last time.
   */
  ratio: number | null | "frame";
};

/**
 * Ordered as the panel shows them: the two that are not ratios at all, then the
 * square, then the landscape family and the portrait family interleaved so a
 * ratio and its inverse sit together.
 */
export const CROP_ASPECTS: readonly CropAspect[] = [
  { id: "free", label: "Free", ratio: null },
  { id: "original", label: "Original", ratio: "frame" },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "3:4", label: "3:4", ratio: 3 / 4 },
  { id: "4:5", label: "4:5", ratio: 4 / 5 },
  { id: "21:9", label: "21:9", ratio: 21 / 9 },
];

/** The drawn ratio a preset means for this frame, or `null` for a free drag. */
export function ratioOf(
  aspect: CropAspect | null | undefined,
  frame: { width: number; height: number },
): number | null {
  if (aspect == null || aspect.ratio == null) {
    return null;
  }
  if (aspect.ratio === "frame") {
    return frame.height > 0 && frame.width > 0
      ? frame.width / frame.height
      : null;
  }
  return Number.isFinite(aspect.ratio) && aspect.ratio > 0 ? aspect.ratio : null;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * The largest rectangle of this drawn aspect that fits the frame, put where the
 * current one is.
 *
 * Centred on `centre` rather than on the frame, so switching from 16:9 to 1:1
 * keeps the framing the user had already aimed and only changes its shape. It is
 * then slid back inside the frame, which is why picking a preset near an edge
 * moves the rectangle rather than letting it hang over.
 *
 * `record/bubbleLayout.ts#bubbleSourceRect` is the same shape of function for
 * the recorder's camera bubble; this one works in the unit square and has to
 * honour a centre, so it is written out rather than shared.
 */
export function rectOfAspect(
  ratio: number | null,
  frame: { width: number; height: number },
  centre: { x: number; y: number },
): CropRect {
  if (
    ratio == null ||
    !Number.isFinite(ratio) ||
    ratio <= 0 ||
    !(frame.width > 0) ||
    !(frame.height > 0)
  ) {
    return FULL_CROP;
  }

  // The same conversion `cropRect.ts` makes: a drawn ratio is a normalized one
  // scaled by the frame's own shape.
  const normalized = (ratio * frame.height) / frame.width;

  const width = normalized >= 1 ? 1 : normalized;
  const height = normalized >= 1 ? 1 / normalized : 1;

  const safeWidth = clamp(width, MIN_CROP, 1);
  const safeHeight = clamp(height, MIN_CROP, 1);

  return {
    x: clamp(centre.x - safeWidth / 2, 0, 1 - safeWidth),
    y: clamp(centre.y - safeHeight / 2, 0, 1 - safeHeight),
    width: safeWidth,
    height: safeHeight,
  };
}

/** The centre of a rect, for handing to `rectOfAspect`. */
export function centreOf(crop: CropRect): { x: number; y: number } {
  return { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 };
}
