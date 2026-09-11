/**
 * Turning a clip's picture over inside its own box.
 *
 * Called by `element.ts#drawDirect` after the element's transform and opacity
 * are on the context and immediately before the per-type renderer draws, so
 * `video.ts`, `image.ts` and the WebGL filter pipeline — which all finish with
 * a `drawImage` into `(0, 0, width, height)` — needed no changes.
 *
 * **Here, not in `transform.ts#localMatrixOf`.** The box is symmetric about its
 * centre, so flipping what is drawn *inside* it leaves everything that reasons
 * about the box untouched: the hit test, the selection outline, the eight
 * grips, the resize arithmetic, the pen tool, tracking and group children. A
 * negative scale in the matrix would have reached every one of those, and
 * `transform.ts` actively prevents one (`MIN_SAMPLED_SCALE`) because its
 * decomposition reads a mirrored matrix as a 180° turn.
 *
 * The consequence worth knowing: **a mask stays where it was drawn** and the
 * picture turns over beneath it. `renderElement` resolves the mask from its own
 * matrix, before this runs. That is the CapCut meaning — mirror the footage —
 * rather than mirroring the layer and everything attached to it.
 */

import { mirrorOf } from "../timeline/mirrorOps";
import type { VisualTimelineElement } from "../../@types/timeline";

/**
 * Flip `ctx` about the centre of a `width` x `height` box whose top-left is
 * the origin. A no-op — not even a `translate` — for a clip that is not
 * mirrored, which is what keeps `golden.test.ts`'s digests unchanged.
 */
export function applyMirror(
  ctx: CanvasRenderingContext2D,
  element: VisualTimelineElement,
  width: number,
  height: number,
): void {
  const { h, v } = mirrorOf(element);
  if (h) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  if (v) {
    ctx.translate(0, height);
    ctx.scale(1, -1);
  }
}
