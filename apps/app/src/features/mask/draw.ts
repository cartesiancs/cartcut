/**
 * The one file in `features/mask/` that touches a 2D context.
 *
 * Everything upstream of it is arithmetic on node lists, which is what lets the
 * geometry be tested without a canvas. This is deliberately thin: it traces a
 * path and nothing else — no fill style, no composite mode, no transform. The
 * caller owns all three, because the two callers want different ones (a
 * `destination-in` stencil on a layer, and a `clip()` on the frame) and neither
 * should have to undo the other's opinion.
 */

import type { MaskNode } from "../../@types/timeline";
import { segmentsOf } from "./geometry";

/**
 * Trace the closed mask path into `ctx`'s current path.
 *
 * Issues `beginPath` itself and `closePath` at the end, and leaves the path
 * *unfilled* so the caller can `fill()` or `clip()` it. Draws nothing at all
 * for a path with fewer than two nodes — the pass-through case, which
 * `isMaskActive` has usually already caught, so reaching it here is the second
 * line of the same contract rather than the first.
 *
 * Every edge is a `bezierCurveTo`, including the straight ones: a straight edge
 * is the cubic whose control points sit on its endpoints, so there is no line
 * case to get wrong and no branch to diverge between the two callers.
 */
export function traceMaskPath(
  ctx: CanvasRenderingContext2D,
  nodes: readonly MaskNode[],
): boolean {
  const segments = segmentsOf(nodes);
  if (segments.length === 0) {
    return false;
  }

  ctx.beginPath();
  ctx.moveTo(segments[0].from.x, segments[0].from.y);
  for (const segment of segments) {
    ctx.bezierCurveTo(
      segment.c1.x,
      segment.c1.y,
      segment.c2.x,
      segment.c2.y,
      segment.to.x,
      segment.to.y,
    );
  }
  ctx.closePath();
  return true;
}
