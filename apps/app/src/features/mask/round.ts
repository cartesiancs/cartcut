/**
 * Round corners, as a rewrite of the node list.
 *
 * One rule decides what is affected, and it is a property of the geometry
 * rather than a list of shape names: **a node with no handles is a corner, and
 * a corner between two straight edges is what gets rounded.** Everything the
 * feature is supposed to do follows from it —
 *
 *  - a rectangle is four corners, so it rounds completely;
 *  - a star is ten, so its points and its notches both soften;
 *  - a heart carries a handle on every node, so it never rounds and there is no
 *    `if (shape === "heart")` anywhere to say so;
 *  - a drawn path rounds exactly the vertices the user *clicked* and leaves the
 *    ones they *dragged* — which is the distinction they were making with the
 *    mouse at the time.
 *
 * The replacement is a cubic, not an arc. `arcTo` and `roundRect` are both
 * exact only under a similarity transform, and this path still has the clip's
 * world matrix ahead of it; a cubic's control points map through an affine
 * matrix to the control points of the transformed cubic, so the rounded corner
 * survives a stretch as the ellipse arc it ought to be.
 */

import type { MaskNode } from "../../@types/timeline";
import { isCorner, isStraight, type Point } from "./geometry";

/** Below this a corner is treated as already smooth, or as doubled back. */
const ANGLE_EPSILON = 1e-6;

/** Below this a trim would move the tangent points nowhere. */
const LENGTH_EPSILON = 1e-9;

/**
 * The control-point distance, as a fraction of the distance from the tangent
 * point to the corner, for a circular arc of sweep `theta`.
 *
 * `4/3 · tan(θ/4)` is the classic cubic approximation to an arc of sweep θ and
 * radius R, and the tangent point sits `R · tan(θ/2)` from the corner — so the
 * ratio between them is all this needs, and the radius never has to be named.
 * At a right angle it is 0.5523, the number every rounded rectangle in graphics
 * is built on; this is that constant's general form, so an acute star point and
 * a right-angled rectangle corner are the same code.
 */
function controlRatio(theta: number): number {
  return ((4 / 3) * Math.tan(theta / 4)) / Math.tan(theta / 2);
}

function subtract(a: readonly [number, number], b: readonly [number, number]): Point {
  return { x: a[0] - b[0], y: a[1] - b[1] };
}

function length(v: Point): number {
  return Math.hypot(v.x, v.y);
}

/**
 * Round every eligible corner by up to `radius`, in the node list's own units.
 *
 * Returns its **input by identity** when nothing is eligible, which is not just
 * tidiness here: it is what lets the render path ask for rounding
 * unconditionally and pay nothing for the shapes and the settings that do not
 * use it.
 *
 * The trim is capped at **half** each adjacent edge rather than all of it, so
 * two corners sharing a short edge cannot each eat past the middle and cross
 * over into a bow tie. That cap is per corner and per edge, which is why a
 * star's sharp points round far less than its long outer edges would allow —
 * correctly, since that is where the geometry runs out.
 */
export function roundCorners(
  nodes: readonly MaskNode[],
  radius: number,
): MaskNode[] {
  if (!(radius > 0) || !Number.isFinite(radius) || nodes.length < 3) {
    return nodes as MaskNode[];
  }

  const out: MaskNode[] = [];
  let changed = false;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const previous = nodes[(i - 1 + nodes.length) % nodes.length];
    const next = nodes[(i + 1) % nodes.length];

    const eligible =
      isCorner(node) && isStraight(previous, node) && isStraight(node, next);
    if (!eligible) {
      out.push(node);
      continue;
    }

    const toPrevious = subtract(previous.p, node.p);
    const toNext = subtract(next.p, node.p);
    const previousLength = length(toPrevious);
    const nextLength = length(toNext);
    if (previousLength < LENGTH_EPSILON || nextLength < LENGTH_EPSILON) {
      out.push(node);
      continue;
    }

    const previousDirection = {
      x: toPrevious.x / previousLength,
      y: toPrevious.y / previousLength,
    };
    const nextDirection = { x: toNext.x / nextLength, y: toNext.y / nextLength };

    // The interior angle at this corner. Clamped before `acos` because a dot
    // product of two unit vectors can land a few ulps outside [-1, 1] and
    // `Math.acos(1.0000000000000002)` is `NaN`, which would put the whole path
    // off-canvas.
    const dot = Math.min(
      1,
      Math.max(
        -1,
        previousDirection.x * nextDirection.x + previousDirection.y * nextDirection.y,
      ),
    );
    const interior = Math.acos(dot);
    const sweep = Math.PI - interior;
    // Collinear: there is no corner to round. Doubled back: the "corner" is a
    // spike with no interior, and rounding it would swing the path through a
    // half-turn nobody drew.
    if (sweep < ANGLE_EPSILON || interior < ANGLE_EPSILON) {
      out.push(node);
      continue;
    }

    const trim = Math.min(radius, previousLength / 2, nextLength / 2);
    if (trim < LENGTH_EPSILON) {
      out.push(node);
      continue;
    }

    const handle = trim * controlRatio(sweep);

    // Traversal order is previous -> node -> next, so the tangent point on the
    // previous edge comes first and carries the *outgoing* handle.
    out.push({
      p: [node.p[0] + previousDirection.x * trim, node.p[1] + previousDirection.y * trim],
      ce: [-previousDirection.x * handle, -previousDirection.y * handle],
    });
    out.push({
      p: [node.p[0] + nextDirection.x * trim, node.p[1] + nextDirection.y * trim],
      cs: [-nextDirection.x * handle, -nextDirection.y * handle],
    });
    changed = true;
  }

  return changed ? out : (nodes as MaskNode[]);
}
