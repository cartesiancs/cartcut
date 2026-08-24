/**
 * The arithmetic behind a move or a rotate in the preview.
 *
 * The bug this exists for: a drag mixed two coordinate spaces. `localMatrixOf`
 * places the element's *unrotated* top-left at `location` and turns it about its
 * centre, so once `rotation` is non-zero the drawn corner `(m.e, m.f)` is not
 * `location` at all. The move path captured the drawn corner as its origin, added
 * the canvas-space pointer delta to it, and wrote the sum into `location` — so
 * the element teleported by `drawnCorner − location` on the first mouse move,
 * before the pointer had travelled anywhere. A 200x100 clip at 45 degrees jumped
 * by (+64.6, -56.1). The rotate path made the same mistake about the pivot: it
 * built the centre as `drawnCorner + (w/2, h/2)`, which is a point on neither
 * quantity's terms, and grabbing the knob snapped the angle by tens of degrees.
 *
 * The fix, and the rule for anything added here: a drag is a **delta**. Take the
 * pointer's canvas-space delta into the element's parent space, add it to an
 * origin already in that space, and the two sides of the sum can no longer
 * disagree. Nothing here reads a drawn corner.
 *
 * Kept DOM-free so it runs in the `node` suite alongside the timeline modules,
 * as `hitTest.ts` and `elementPosition.ts` are.
 */

import { applyVector, invert, type Mat, type Point } from "../timeline/transform";

/** An axis-aligned rectangle, in whatever space the caller is working in. */
export type Rect = { x: number; y: number; w: number; h: number };

/** What a snap resolved to, and which guides to draw for it. */
export type SnapResult = { x: number; y: number; direction: string[] };

/**
 * Where a drag should put the element, as a value fit to write into `location`.
 *
 * `originLocal` is the element's position in its **parent's** space at drag
 * start — `displayPosition`, so an animated element starts from where it is
 * drawn rather than from its static field. `originBounds` is the world-space
 * axis-aligned box of the same element at the same instant, which for a rotated
 * one is the box around its quad, not its rectangle.
 *
 * Snapping stays a canvas-space question: guides line up with the frame as the
 * user sees it. So `snap` is offered the shifted world box and its correction —
 * the difference between what it returned and what it was given — is folded back
 * into the world delta before the whole thing crosses into parent space. Passing
 * the correction rather than the snapped position is what keeps this a delta all
 * the way through.
 *
 * For an unrotated, unparented element `originBounds` equals
 * `{...originLocal, w, h}` and `parentMatrix` is the identity, so this reduces
 * to `origin + delta` exactly as before.
 */
export function movedLocation(input: {
  originLocal: Point;
  originBounds: Rect;
  dx: number;
  dy: number;
  parentMatrix: Mat;
  snap?: (rect: Rect) => SnapResult | undefined;
}): { location: Point; direction: string[] } {
  const { originLocal, originBounds, dx, dy, parentMatrix, snap } = input;

  const dragged: Rect = {
    x: originBounds.x + dx,
    y: originBounds.y + dy,
    w: originBounds.w,
    h: originBounds.h,
  };

  const snapped = snap?.(dragged);
  const worldDelta: Point = {
    x: dx + (snapped == null ? 0 : snapped.x - dragged.x),
    y: dy + (snapped == null ? 0 : snapped.y - dragged.y),
  };

  // The linear part only — a delta has no origin to translate, and running it
  // through the full inverse would subtract the parent's offset a second time.
  const localDelta = applyVector(invert(parentMatrix), worldDelta);

  return {
    location: {
      x: originLocal.x + localDelta.x,
      y: originLocal.y + localDelta.y,
    },
    direction: snapped == null ? [] : snapped.direction,
  };
}

/**
 * The shortest signed step from one angle to another, in (-180, 180].
 *
 * A rotation drag accumulates these rather than reading the pointer's absolute
 * angle, so the element keeps turning past a full circle instead of wrapping,
 * and so grabbing the 50px-wide knob off its centre costs nothing: only the
 * change in pointer angle is applied, never its value.
 */
export function angleStep(previousDeg: number, currentDeg: number): number {
  if (!Number.isFinite(previousDeg) || !Number.isFinite(currentDeg)) {
    return 0;
  }
  let step = (currentDeg - previousDeg) % 360;
  if (step > 180) {
    step -= 360;
  } else if (step <= -180) {
    step += 360;
  }
  return step;
}

/** An angle in degrees brought into [0, 360). */
export function normalizeDegrees(deg: number): number {
  if (!Number.isFinite(deg)) {
    return 0;
  }
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}
