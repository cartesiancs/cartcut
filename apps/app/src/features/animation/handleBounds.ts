/**
 * Where a keyframe's bezier handles are allowed to sit.
 *
 * The editor and the baker used to disagree about this. `setHandles` wrote
 * whatever `[t, value]` the drag produced, while `bakeTrack` clamped the
 * control abscissae into the segment before solving — so pulling a handle past
 * its neighbouring anchor moved the drawn handle and nothing else. The curve
 * stopped responding, with no indication why.
 *
 * The rule here is After Effects': a handle is constrained **on the time axis
 * only**, to the span between its anchor and the neighbour it points at. The
 * value axis is deliberately left free, because that is what makes overshoot
 * and bounce easings expressible — clamping it would quietly delete a whole
 * class of curve.
 *
 * The invariant this establishes over a whole list:
 *
 *     p[0]ᵢ₋₁ ≤ cs[0]ᵢ ≤ p[0]ᵢ ≤ ce[0]ᵢ ≤ p[0]ᵢ₊₁
 *
 * `bakeTrack`'s own clamp stays where it is. It is now a safety net for project
 * files authored before this module existed, not the place the two
 * representations diverge.
 */

import type { Keyframe } from "./keyframes";

/**
 * The time span `list[index].cs` may occupy, or `null` if it has none.
 *
 * The first keyframe's `cs` points at a segment that does not exist —
 * `bakeTrack` walks pairs and reads only `a.ce` and `b.cs`, so nothing ever
 * looks at it. `null` means "this handle is inert", and both the clamp below
 * and the editor's hit test treat it as such.
 */
export function csTimeBounds(
  list: Keyframe[],
  index: number,
): [number, number] | null {
  if (index <= 0 || index >= list.length) {
    return null;
  }
  return [list[index - 1].p[0], list[index].p[0]];
}

/** The time span `list[index].ce` may occupy, or `null` for the last keyframe. */
export function ceTimeBounds(
  list: Keyframe[],
  index: number,
): [number, number] | null {
  if (index < 0 || index >= list.length - 1) {
    return null;
  }
  return [list[index].p[0], list[index + 1].p[0]];
}

function clampTo(value: number, bounds: [number, number]): number {
  return value < bounds[0] ? bounds[0] : value > bounds[1] ? bounds[1] : value;
}

/**
 * One keyframe's handles folded into their bounds, or the input by identity.
 *
 * An inert handle collapses onto its anchor rather than being left wherever it
 * happened to be. That gives the editor a single unambiguous test for "do not
 * draw this, do not let it be grabbed" — the handle is at the anchor — instead
 * of every call site having to re-derive which ends are endpoints.
 */
function clampOne(list: Keyframe[], index: number): Keyframe {
  const current = list[index];
  const csBounds = csTimeBounds(list, index);
  const ceBounds = ceTimeBounds(list, index);

  const cs: [number, number] =
    csBounds == null
      ? [current.p[0], current.p[1]]
      : [clampTo(current.cs[0], csBounds), current.cs[1]];
  const ce: [number, number] =
    ceBounds == null
      ? [current.p[0], current.p[1]]
      : [clampTo(current.ce[0], ceBounds), current.ce[1]];

  if (
    cs[0] === current.cs[0] &&
    cs[1] === current.cs[1] &&
    ce[0] === current.ce[0] &&
    ce[1] === current.ce[1]
  ) {
    return current;
  }
  return { ...current, cs, ce };
}

/**
 * Every handle in a list folded into bounds.
 *
 * Returns the input by identity when nothing moves, which is what keeps this
 * usable at the tail of `addKeyframe` and friends: those declare "an op that
 * changes nothing returns the document it was given", and `withCheckpoint`
 * compares by identity to decide whether an undo step happened. A clamp that
 * always allocated would push an undo entry for every no-op drag.
 */
export function clampHandles(list: Keyframe[]): Keyframe[] {
  let out: Keyframe[] | null = null;

  for (let index = 0; index < list.length; index++) {
    const next = clampOne(list, index);
    if (next === list[index]) {
      continue;
    }
    if (out == null) {
      out = [...list];
    }
    out[index] = next;
  }

  return out ?? list;
}

/**
 * Whether a handle sits exactly on its anchor.
 *
 * The editor's test for an inert handle: nothing to draw, nothing to grab.
 */
export function isCollapsedHandle(
  keyframe: Keyframe,
  which: "cs" | "ce",
): boolean {
  const handle = keyframe[which];
  return handle[0] === keyframe.p[0] && handle[1] === keyframe.p[1];
}

/**
 * Whether a list satisfies the monotonicity invariant.
 *
 * Exported for tests and for `assertBakedInvariants`-style debugging, not
 * because production code should need to ask.
 */
export function handlesInBounds(list: Keyframe[]): boolean {
  for (let index = 0; index < list.length; index++) {
    const keyframe = list[index];
    const csBounds = csTimeBounds(list, index);
    const ceBounds = ceTimeBounds(list, index);

    if (csBounds == null) {
      if (!isCollapsedHandle(keyframe, "cs")) {
        return false;
      }
    } else if (keyframe.cs[0] < csBounds[0] || keyframe.cs[0] > csBounds[1]) {
      return false;
    }

    if (ceBounds == null) {
      if (!isCollapsedHandle(keyframe, "ce")) {
        return false;
      }
    } else if (keyframe.ce[0] < ceBounds[0] || keyframe.ce[0] > ceBounds[1]) {
      return false;
    }
  }
  return true;
}
