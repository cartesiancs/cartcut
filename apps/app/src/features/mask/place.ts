/**
 * Placing a mask: unit square -> the element's own local pixels.
 *
 * The order is scale, then round, then rotate, then translate, and two of those
 * four are only in that position for a reason:
 *
 *  - **Rounding happens after the scale**, in pixels, so a corner is a circular
 *    arc on screen whatever the mask's aspect. Rounding in the unit square
 *    first would stretch every corner into an ellipse along with the shape, so
 *    a wide, short mask would get corners that were visibly wider than they
 *    were tall — the thing `border-radius` percentages do, and the thing nobody
 *    wants from a "round corners" slider.
 *  - **Rotation happens after the rounding**, which costs nothing because a
 *    rotation is rigid and cannot change a corner's angle. It is written this
 *    way round so the rounding step never has to reason about orientation.
 *
 * The result is in **element-local pixels**: the same space `renderElement`
 * hands each element renderer, where the clip occupies `(0, 0, width, height)`.
 * Everything after this — the world transform, the device mapping, the feather
 * radius — is `renderer/mask.ts`'s problem.
 *
 * DOM-free.
 */

import type { MaskNode, MaskType } from "../../@types/timeline";
import { multiply } from "../timeline/transform";
import {
  type Box,
  rotateMat,
  scaleMat,
  transformNodes,
  translateMat,
} from "./geometry";
import { roundCorners } from "./round";
import { templateNodes } from "./templates";

/**
 * A mask's five animatable values, resolved at one cursor.
 *
 * A separate type from `MaskType` because these are what the *keyframes*
 * produce: at any given frame the mask being drawn may be nowhere near the one
 * stored on the element. `maskStaticSample` is the un-animated case, and the
 * renderer replaces it with the sampled one.
 */
export type MaskSample = {
  location: { x: number; y: number };
  size: { width: number; height: number };
  rotation: number;
  feather: number;
  roundness: number;
};

/** The mask exactly as authored — the sample for a clip with no mask tracks. */
export function maskStaticSample(mask: MaskType): MaskSample {
  return {
    location: { x: mask.location.x, y: mask.location.y },
    size: { width: mask.size.width, height: mask.size.height },
    rotation: mask.rotation,
    feather: mask.feather,
    roundness: mask.roundness,
  };
}

/**
 * The mask's nodes in element-local pixels.
 *
 * Empty when there is nothing to draw — a `pen` shape with too few nodes, or an
 * element box with no extent. An empty list is the pass-through: `draw.ts`
 * issues no path for it, and `isMaskActive` has already kept such a mask off
 * the layer path entirely, so this is a second line rather than the first.
 */
export function maskNodesInElementSpace(
  mask: MaskType,
  sample: MaskSample,
  box: Box,
): MaskNode[] {
  const nodes = templateNodes(mask.shape, mask.path);
  if (nodes.length < 2) {
    return [];
  }

  const widthPx = (sample.size.width / 100) * box.width;
  const heightPx = (sample.size.height / 100) * box.height;

  const scaled = transformNodes(nodes, scaleMat(widthPx, heightPx));

  // Half the shorter side is the most a corner can be rounded before opposite
  // corners meet, so 100 means "as round as this box goes" and the slider has
  // the same meaning on a square mask and a letterbox one.
  const radius = (sample.roundness / 100) * (Math.min(widthPx, heightPx) / 2);
  const rounded = roundCorners(scaled, radius);

  const placement = multiply(
    translateMat(
      (sample.location.x / 100) * box.width,
      (sample.location.y / 100) * box.height,
    ),
    rotateMat(sample.rotation),
  );

  return transformNodes(rounded, placement);
}
