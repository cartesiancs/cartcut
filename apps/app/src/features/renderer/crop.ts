/**
 * Showing part of a clip's source frame, inside its own box.
 *
 * Called by `element.ts#drawDirect` after the element's transform, its opacity
 * and its mirror are on the context and immediately before the per-type renderer
 * draws. That position is what let this feature ship without touching a single
 * media renderer: `video.ts`, `image.ts`, `gif.ts` and the WebGL filter
 * pipeline all finish with a `drawImage` into `(0, 0, width, height)`, and not
 * one of them calls `setTransform`, `save` or `restore`, so a transform left on
 * the context reaches all four.
 *
 * ## The map
 *
 * The renderer draws the whole source into `(0, 0, W, H)`, so a source point at
 * normalized `(u, v)` lands at `(uW, vH)`. The crop wants the kept rect to fill
 * the box instead, which puts that point at `((u − x)*W/w, (v − y)*H/h)`.
 * Reading the two off against each other gives `scale(1/w, 1/h)` followed by
 * `translate(−xW, −yH)`, in that order, because a canvas transform composes on
 * the right.
 *
 * The clip is what stops the rest of the source spilling out of the box. It goes
 * on **before** the scale, so the rect is in box coordinates where `(0, 0, W, H)`
 * is the whole of what may be drawn.
 *
 * ## After the mirror, not before it
 *
 * A flip and a crop do not commute unless the crop happens to be centred. Taking
 * the mirror first means the *kept* picture is the thing that turns over, which
 * is what "flip this clip" means to a person looking at it. The other order
 * flips the whole frame and then keeps a different part of it, so turning a clip
 * over would also slide the framing.
 *
 * ## Why not a source rect
 *
 * `drawImage`'s nine-argument form would express the same thing, and would have
 * to be threaded through four renderers, one of which is a WebGL pipeline whose
 * canvas is sized in *source* pixels rather than element ones. It is also
 * slightly worse at the seam: a source rect clamps its sampling at the rect's
 * edge, while a clipped draw samples the real neighbouring pixels and throws
 * them away. Skia and Chromium both bound the raster to the clip, so the cost is
 * the same either way.
 */

import type { CropRect, VisualTimelineElement } from "../../@types/timeline";
import { cropOf, isCropped } from "../timeline/cropOps";

/**
 * Put the crop's map on the context, without the clip.
 *
 * Split out because the crop tool's overlay wants exactly this half: it draws
 * the clip's whole source frame, in the place the crop would have put it, so the
 * user can see what they are cutting away.
 */
export function cropTransformInto(
  ctx: CanvasRenderingContext2D,
  crop: CropRect,
  width: number,
  height: number,
): void {
  ctx.scale(1 / crop.width, 1 / crop.height);
  ctx.translate(-crop.x * width, -crop.y * height);
}

/**
 * Keep only the cropped part of `element`'s source inside a `width` x `height`
 * box whose top-left is the origin.
 *
 * A no-op, not even a `beginPath`, for a clip that is not cropped, which is
 * every clip in every project written before this feature and what keeps
 * `golden.test.ts`'s digests unchanged.
 */
export function applyCrop(
  ctx: CanvasRenderingContext2D,
  element: VisualTimelineElement,
  width: number,
  height: number,
): void {
  const crop = cropOf(element);
  if (!isCropped(crop)) {
    return;
  }
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  cropTransformInto(ctx, crop, width, height);
}
