/**
 * Where a resize grip should put the element's rectangle.
 *
 * Split out of eight closures in `previewCanvas._handleMouseMove` that each
 * mutated the store's own element object in place. Two things were wrong with
 * them beyond the mutation.
 *
 * The locked corner branches projected the pointer delta onto a fixed 45-degree
 * axis and then rebuilt the size from `element.ratio` — the *source file's*
 * native aspect, frozen at import and never recomputed. At zero delta that
 * formula yields `height * ratio`, not the width the element actually had, so a
 * clip whose width and height had been set independently (the sidebar's
 * `handleSize` does exactly that) snapped back to its native proportions the
 * instant the pointer twitched, before the drag had gone anywhere. And because
 * the axis was 45 degrees regardless of the element, a 16:9 clip dragged
 * horizontally by 100px grew by 50: half of every delta was spent on the other
 * axis and the grabbed corner never sat under the pointer.
 *
 * Both go away by treating a constrained resize as a *scale* rather than a
 * size. `s` is 1 at zero delta whatever proportions the element is in, so there
 * is nothing to jump from, and the proportions held are the ones it had when
 * the drag started rather than the ones its file happened to have.
 *
 * Kept DOM-free so it runs in the `node` suite alongside `dragMath` and
 * `hitTest`.
 */

import {
  applyPoint,
  applyVector,
  IDENTITY,
  multiply,
  type Mat,
  type Point,
} from "../timeline/transform";
import { addKeyframe } from "../animation/keyframeOps";
import type { TimelineDocument } from "../timeline/tracks";
import type { Rect } from "./dragMath";
import type { StretchZone } from "./hitTest";

export type { StretchZone };

export type ResizeInput = {
  /** The element's rect in its parent's space at mousedown. */
  origin: Rect;
  zone: StretchZone;
  /** Pointer delta, already taken into the element's own axes. */
  localDx: number;
  localDy: number;
  /** Hold the proportions the element had at mousedown. */
  constrain: boolean;
  /** Smallest side a drag may produce, in parent-space units. */
  minSize: number;
  /**
   * The element's own local matrix — `localMatrixOf`, the one the renderer
   * draws with. Only its linear part is read, so the rotation and scale it
   * carries are what matter; defaults to the identity.
   *
   * Required for a rotated or scaled element, and the reason is in
   * `anchoredAt`: without it the anchor is held in the *unrotated* rect's
   * coordinates, which is not where the user sees it.
   */
  linear?: Mat;
};

type AxisSign = { sx: -1 | 0 | 1; sy: -1 | 0 | 1 };

/**
 * Which edge each grip drives, and therefore which one anchors.
 *
 * `+1` means the far edge on that axis moves and the near one is pinned, `-1`
 * the reverse, `0` that the grip does not drive that axis at all.
 */
const AXIS_SIGN: Record<StretchZone, AxisSign> = {
  stretchE: { sx: 1, sy: 0 },
  stretchW: { sx: -1, sy: 0 },
  stretchN: { sx: 0, sy: -1 },
  stretchS: { sx: 0, sy: 1 },
  stretchNW: { sx: -1, sy: -1 },
  stretchNE: { sx: 1, sy: -1 },
  stretchSW: { sx: -1, sy: 1 },
  stretchSE: { sx: 1, sy: 1 },
};

export function resizedRect(input: ResizeInput): Rect | null {
  const { origin, zone, localDx, localDy, constrain, minSize } = input;
  const linear = input.linear ?? IDENTITY;

  const sign = AXIS_SIGN[zone];
  if (sign == null) {
    return null;
  }
  if (!Number.isFinite(localDx) || !Number.isFinite(localDy)) {
    return null;
  }
  if (
    !Number.isFinite(origin.x) ||
    !Number.isFinite(origin.y) ||
    !Number.isFinite(origin.w) ||
    !Number.isFinite(origin.h)
  ) {
    return null;
  }
  if (
    !Number.isFinite(linear.a) ||
    !Number.isFinite(linear.b) ||
    !Number.isFinite(linear.c) ||
    !Number.isFinite(linear.d)
  ) {
    return null;
  }

  const floor = Number.isFinite(minSize) ? Math.max(0, minSize) : 0;
  // Proportions of a degenerate box are not a ratio, and scaling a box already
  // under the floor would have to make it *grow* to reach it. Either way, fall
  // back to the free path, which guards each axis on its own.
  const canConstrain = constrain && origin.w > floor && origin.h > floor;

  const size = canConstrain
    ? constrainedSize(origin, sign, localDx, localDy, floor)
    : freeSize(origin, sign, localDx, localDy, floor);

  // Always a rect, never "no change" — the *document* decides whether anything
  // happened, by comparing what this returns against what the element already
  // holds (`resizedDocument`). Returning null for a rect that equalled `origin`
  // read as "skip the write", which quietly made the element keep the previous
  // mousemove's size: bring the pointer back to exactly where the drag began
  // and it stayed one event stale instead of returning to its original size.
  return anchoredAt(origin, sign, size, linear);
}

/**
 * Place the resized box so the grip's opposite corner stays where it is.
 *
 * The subtlety this exists for, and the bug it fixes: `localMatrixOf` composes
 * as `location + centre + RS·(p − centre)` — it turns the element about the
 * *centre of its box*, and that centre moves as soon as `width` or `height`
 * change. Holding the anchor by pinning the unrotated rect's own coordinates
 * (keeping `x + w` fixed, as this used to) therefore only holds it while the
 * element is upright. Rotate it and the pinned corner swings around the moving
 * centre, so the box slid off in a direction unrelated to the drag.
 *
 * Writing the renderer's own composition for the anchor `a` before and after,
 * with `k = (a − centre)` expressed as a fraction of each side, and requiring
 * the two to land on the same parent-space point:
 *
 * ```
 * location_new = location_old + (dw/2, dh/2) + RS·(k.x·dw, k.y·dh)
 * ```
 *
 * `k` is `−sign/2`: the grip drives one side, so the anchor is the opposite one
 * — `stretchE` (`sx = +1`) hangs off the western edge, `stretchNW` off the SE
 * corner, and an undriven axis anchors at the centre and spreads both ways.
 *
 * At `RS = I` the two terms collapse to `(k.x + 0.5)·dw`, which is the plain
 * edge-pinning arithmetic this replaces — so an upright element behaves exactly
 * as before, to the bit.
 */
function anchoredAt(
  origin: Rect,
  sign: AxisSign,
  size: { w: number; h: number },
  linear: Mat,
): Rect {
  const dw = origin.w - size.w;
  const dh = origin.h - size.h;

  const swing = applyVector(linear, {
    x: (-sign.sx / 2) * dw,
    y: (-sign.sy / 2) * dh,
  });

  return {
    x: origin.x + dw / 2 + swing.x,
    y: origin.y + dh / 2 + swing.y,
    w: size.w,
    h: size.h,
  };
}

/**
 * Each axis moves, and hits the floor, on its own.
 *
 * Dragging a corner past the floor on one axis still resizes the other, which
 * is what the eight closures did — the two edge helpers a corner called each
 * carried their own guard — and it is what lets you flatten a shape against one
 * side without the whole drag freezing.
 *
 * Clamped rather than declined, as `constrainedSize` is. Declining meant
 * returning the side's *original* length, so a drag past the floor described a
 * box at full size; only the caller throwing the result away kept the element
 * pinned at the minimum, and a floor that depends on its caller ignoring it is
 * not a floor.
 */
function freeSize(
  o: Rect,
  sign: AxisSign,
  dx: number,
  dy: number,
  floor: number,
): { w: number; h: number } {
  return {
    w: sign.sx === 0 ? o.w : Math.max(floor, o.w + sign.sx * dx),
    h: sign.sy === 0 ? o.h : Math.max(floor, o.h + sign.sy * dy),
  };
}

/**
 * One scale factor for both axes, so the proportions cannot drift.
 *
 * A corner follows whichever axis the pointer pushed further — `max`, so the
 * grabbed corner reaches at least as far as the pointer on its dominant axis
 * and the element grows to meet a drag rather than splitting the difference.
 * An edge has only its own axis to go on; `anchoredAt` then spreads the other
 * about the centre, which is what a locked edge drag has always done.
 */
function constrainedSize(
  o: Rect,
  sign: AxisSign,
  dx: number,
  dy: number,
  floor: number,
): { w: number; h: number } {
  const sw = sign.sx === 0 ? null : (o.w + sign.sx * dx) / o.w;
  const sh = sign.sy === 0 ? null : (o.h + sign.sy * dy) / o.h;

  let s = sw == null ? (sh as number) : sh == null ? sw : Math.max(sw, sh);
  // Clamp rather than decline: a constrained drag that reaches the floor should
  // stop there, not snap back to the size it started at. `canConstrain` has
  // already established both sides exceed the floor, so both bounds are below 1
  // and this can never force the element to grow.
  s = Math.max(s, floor / o.w, floor / o.h);

  return { w: o.w * s, h: o.h * s };
}

/**
 * Whether this drag holds the element's proportions.
 *
 * Which kinds resize freely by default: text has to, because a caption's box is
 * a text-wrapping width rather than a picture; a group for the same reason, its
 * `width`/`height` being an invisible frame whose job is to sit where the user
 * wants the pivot; and a shape, because a rectangle that can only scale is not
 * a rectangle tool.
 *
 * Shift then **inverts** that default rather than always meaning "lock". A
 * caption or a shape is free and Shift holds its proportions; a photo is locked
 * and Shift releases it. One key, one meaning — "the other one".
 */
export function constrainsAspect(filetype: string, shiftKey: boolean): boolean {
  const freeByDefault =
    filetype === "text" || filetype === "group" || filetype === "shape";
  return freeByDefault ? shiftKey : !shiftKey;
}

/** What a resize gesture captured at mousedown, plus where it has got to. */
export type ResizeCommit = {
  /**
   * The element's rect at mousedown, in parent space with animation resolved —
   * `displayPosition`, so an animated element starts from where it is drawn.
   */
  originLocal: Rect;
  /**
   * The element's **static** `location` field at mousedown.
   *
   * Not the same point as `originLocal` for an animated element: one is where
   * the track puts it at the cursor, the other is the field the resize has to
   * write. Keeping both is what lets the write stay absolute without mixing the
   * two spaces — see `resizedDocument`.
   */
  originLocation: Point;
  /** Where `resizedRect` says the rect should be now. */
  next: Rect;
  /**
   * The playhead in the element's own milliseconds, for the keyframes this
   * writes — `size`, and `position` for the anchor correction.
   *
   * Optional, and omitting it means "write the static box only". A caller with
   * no playhead — a test, a batch op — has no honest answer here, and a
   * keyframe planted at a guessed time is worse than no keyframe: it is a
   * point on the curve the user did not author and cannot see they have.
   */
  atMs?: number;
  /** The project's bake rate, for the lanes this writes. */
  bakeHz?: number;
};

/**
 * The document a resize gesture has reached, or the input when it changed
 * nothing.
 *
 * **This function must stay an absolute setter, and that is not a style
 * preference.** `GestureCommit.apply` re-applies against the *live* document on
 * every mousemove, and its contract — stated in its own header — is that each
 * step sets a value rather than adjusting one, so that re-applying is
 * idempotent.
 *
 * The version this replaces read `location` off the live document and added
 * `next − originLocal` to it. That offset is constant for a stationary pointer,
 * so it was re-added on every mousemove and the element ran away from under the
 * cursor: parking on the NE grip 20px above the start slid it up 20px per
 * event, forever. `E`, `S` and `SE` were unaffected only because their anchor
 * does not move, which is what made a whole-gesture bug look corner-specific.
 *
 * Anchoring on `originLocation` — captured once, at mousedown — makes the write
 * a pure function of the pointer's current position, so no number can
 * accumulate. `resizedDocument.test.ts` pins that by replaying whole gestures.
 */
export function resizedDocument(
  doc: TimelineDocument,
  elementId: string,
  commit: ResizeCommit,
): TimelineDocument {
  const current: any = doc.elements[elementId];
  if (current == null) {
    return doc;
  }

  const { originLocal, originLocation, next, atMs, bakeHz } = commit;

  // The anchor correction is measured against the mousedown rect and applied to
  // the mousedown field, so the animated and static positions never mix. With
  // no animation the two coincide and this is exactly `next.x`.
  const location = {
    x: originLocation.x + (next.x - originLocal.x),
    y: originLocation.y + (next.y - originLocal.y),
  };

  // The keyframe at the playhead, where the clip's size is animated — the
  // same pairing the move gesture makes between `location` and `position`.
  // Without it the grip and the sidebar would move while the picture stayed
  // put, because the sampled box overrides the static one at draw time.
  //
  // Still an absolute setter: `addKeyframe` *replaces* the keyframe at a given
  // time rather than appending one, so re-applying against the live document
  // on every mousemove collapses to a single keyframe per lane, and a held
  // pointer writes the same value over itself.
  let withKeyframes = doc;
  if (Number.isFinite(atMs) && current.animation?.size?.isActivate === true) {
    withKeyframes = addKeyframe(
      addKeyframe(
        withKeyframes,
        elementId,
        "size",
        "x",
        atMs!,
        next.w,
        undefined,
        bakeHz,
      ),
      elementId,
      "size",
      "y",
      atMs!,
      next.h,
      undefined,
      bakeHz,
    );
  }

  // The same correction, for a clip whose *position* is animated.
  //
  // `location` below is dead data in that case: `transform.localSampleAt` reads
  // the baked position lane and never looks at the static field while the track
  // is on. So the anchor correction `anchoredAt` computed — the whole reason a
  // NW drag keeps the SE corner pinned — was written somewhere nothing reads,
  // and the grip slid out from under the pointer. Exactly the divergence
  // `preview/elementPosition.ts` documents being closed for the *move* gesture;
  // the resize gesture never got the same treatment.
  //
  // `next.x`/`next.y` are already the drawn rect in parent space, which is the
  // space the position track's own values live in, so this stays the absolute
  // setter `GestureCommit.apply` requires.
  if (Number.isFinite(atMs) && current.animation?.position?.isActivate === true) {
    withKeyframes = addKeyframe(
      addKeyframe(
        withKeyframes,
        elementId,
        "position",
        "x",
        atMs!,
        next.x,
        undefined,
        bakeHz,
      ),
      elementId,
      "position",
      "y",
      atMs!,
      next.y,
      undefined,
      bakeHz,
    );
  }

  const settled: any = withKeyframes.elements[elementId];
  if (
    withKeyframes === doc &&
    settled.width === next.w &&
    settled.height === next.h &&
    settled.location?.x === location.x &&
    settled.location?.y === location.y
  ) {
    // Identity, so the gesture records nothing for a drag that changed nothing
    // — the same decline-by-identity contract the pure timeline ops use.
    return doc;
  }

  return {
    ...withKeyframes,
    elements: {
      ...withKeyframes.elements,
      [elementId]: { ...settled, width: next.w, height: next.h, location },
    },
  };
}


/**
 * How near a frame line counts as a hit, in canvas units.
 *
 * The same figure the move path's `isAlign` uses, and for the same reason: this
 * is a distance between two things being *drawn*, so unlike a grab band it does
 * not follow the pointer's screen scale.
 */
export const SNAP_PADDING = 20;

/** How far off an axis a transform may be and still count as upright. */
const AXIS_EPSILON = 1e-9;

type SnapTarget = { at: number; direction: string };

const xTargetsOf = (frame: { w: number; h: number }): SnapTarget[] => [
  { at: 0, direction: "left" },
  { at: frame.w / 2, direction: "vertical" },
  { at: frame.w, direction: "right" },
];

const yTargetsOf = (frame: { w: number; h: number }): SnapTarget[] => [
  { at: 0, direction: "top" },
  { at: frame.h / 2, direction: "horizontal" },
  { at: frame.h, direction: "bottom" },
];

export type ResizeSnapInput = {
  origin: Rect;
  zone: StretchZone;
  localDx: number;
  localDy: number;
  constrain: boolean;
  minSize: number;
  /** The element's own local matrix, as `resizedRect` takes it. */
  linear?: Mat;
  /** Parent space to world space, so the frame lines mean what the user sees. */
  parentMatrix?: Mat;
  /** The frame the guides belong to, in world units. */
  frame: { w: number; h: number };
  padding?: number;
};

/**
 * Pull the dragged edge onto a frame line, and say which guides to draw.
 *
 * Resizing had no snapping of any kind: `alignDirection` was written only by
 * the move branch, and `isAlign` was never called from the resize one — so
 * dragging an element out to fill the frame was a pixel-hunt with no magnet and
 * no guide to aim at.
 *
 * `isAlign` could not simply be reused, because it answers a *move* question.
 * It slides a rect of fixed size until an edge lands on a line (`nx = cw - w`).
 * A resize has to do the opposite: hold the anchor still and change the size
 * until the *dragged* edge lands there. So this returns a correction to the
 * pointer delta rather than a position, and the caller feeds the corrected
 * delta back through `resizedRect` — which is what keeps the anchor arithmetic
 * in one place, and means a snap can never break the invariant that the
 * opposite corner stays put. It is the same shape as the move path folding its
 * snap correction back into the world delta before changing spaces.
 *
 * The driven edge's world position is affine in the delta, so one extra probe
 * measures the rate exactly — no case analysis over rotation, scale, or which
 * side the grip is on, and it stays right for an element inside a scaled group.
 *
 * Snapping is declined outright when the element is not upright in the world
 * (`b` or `c` non-zero once the parent is composed in). A rotated element's
 * edge is not a vertical or horizontal line, so "put it on the frame's right
 * edge" has no single answer, and guessing one would pull the box somewhere the
 * user cannot predict. `resizedRect` still runs; only the magnet is off.
 */
export function resizeSnap(input: ResizeSnapInput): {
  localDx: number;
  localDy: number;
  direction: string[];
} {
  const { origin, zone, localDx, localDy, constrain, minSize, frame } = input;
  const linear = input.linear ?? IDENTITY;
  const parentMatrix = input.parentMatrix ?? IDENTITY;
  const padding = Number.isFinite(input.padding as number)
    ? (input.padding as number)
    : SNAP_PADDING;

  const unsnapped = { localDx, localDy, direction: [] as string[] };

  const sign = AXIS_SIGN[zone];
  if (sign == null) {
    return unsnapped;
  }
  if (!Number.isFinite(frame?.w) || !Number.isFinite(frame?.h)) {
    return unsnapped;
  }

  // Upright in the world, or no magnet. Measured on the composed matrix, so a
  // child of a rotated group is correctly excluded even though it carries no
  // rotation of its own.
  const world = multiply(parentMatrix, linear);
  const scale = Math.max(
    Math.abs(world.a),
    Math.abs(world.b),
    Math.abs(world.c),
    Math.abs(world.d),
    1,
  );
  if (
    !Number.isFinite(world.b) ||
    !Number.isFinite(world.c) ||
    Math.abs(world.b) > AXIS_EPSILON * scale ||
    Math.abs(world.c) > AXIS_EPSILON * scale
  ) {
    return unsnapped;
  }

  // The side the grip drives — the one opposite the anchor `anchoredAt` holds.
  const u = 0.5 + sign.sx / 2;
  const v = 0.5 + sign.sy / 2;

  const drivenAt = (dx: number, dy: number): Point | null => {
    const rect = resizedRect({
      origin,
      zone,
      localDx: dx,
      localDy: dy,
      constrain,
      minSize,
      linear,
    });
    if (rect == null) {
      return null;
    }
    // `localMatrixOf`'s composition, written out for a hypothetical rect:
    // the box turns about its own centre, then sits at `rect.x, rect.y`.
    const cx = rect.w / 2;
    const cy = rect.h / 2;
    const spun = applyVector(linear, { x: u * rect.w - cx, y: v * rect.h - cy });
    return applyPoint(parentMatrix, {
      x: rect.x + cx + spun.x,
      y: rect.y + cy + spun.y,
    });
  };

  const base = drivenAt(localDx, localDy);
  if (base == null) {
    return unsnapped;
  }

  type Candidate = {
    axis: "x" | "y";
    delta: number;
    distance: number;
    direction: string;
  };
  const candidates: Candidate[] = [];

  const consider = (
    axis: "x" | "y",
    driven: boolean,
    here: number,
    probed: Point | null,
    targets: SnapTarget[],
  ) => {
    if (!driven || probed == null) {
      return;
    }
    const rate = probed[axis] - here;
    if (!Number.isFinite(rate) || Math.abs(rate) <= AXIS_EPSILON) {
      return;
    }
    let best: SnapTarget | null = null;
    let bestDistance = Infinity;
    for (const target of targets) {
      const distance = Math.abs(target.at - here);
      if (distance <= padding && distance < bestDistance) {
        best = target;
        bestDistance = distance;
      }
    }
    if (best == null) {
      return;
    }
    candidates.push({
      axis,
      delta: (best.at - here) / rate,
      distance: bestDistance,
      direction: best.direction,
    });
  };

  consider(
    "x",
    sign.sx !== 0,
    base.x,
    drivenAt(localDx + 1, localDy),
    xTargetsOf(frame),
  );
  consider(
    "y",
    sign.sy !== 0,
    base.y,
    drivenAt(localDx, localDy + 1),
    yTargetsOf(frame),
  );

  if (candidates.length === 0) {
    return unsnapped;
  }

  // Free: the axes are independent, so both can land at once — which is what
  // makes a corner drag fill the frame exactly. Constrained: one scale drives
  // both sides, so honouring two targets is generally impossible; take the
  // nearer one and let the other follow the proportions.
  const chosen = constrain
    ? [candidates.reduce((a, b) => (b.distance < a.distance ? b : a))]
    : candidates;

  let nextDx = localDx;
  let nextDy = localDy;
  for (const candidate of chosen) {
    if (candidate.axis === "x") {
      nextDx += candidate.delta;
    } else {
      nextDy += candidate.delta;
    }
  }

  // Only claim a guide the edge actually reached. `minSize` can clamp a snap
  // short, and a line drawn where the element is not is worse than no line.
  const landed = drivenAt(nextDx, nextDy);
  const direction = landed == null
    ? []
    : chosen
        .filter((candidate) => {
          const targets =
            candidate.axis === "x" ? xTargetsOf(frame) : yTargetsOf(frame);
          const target = targets.find((t) => t.direction === candidate.direction);
          return (
            target != null &&
            Math.abs(landed[candidate.axis] - target.at) <= 1e-6 * scale
          );
        })
        .map((candidate) => candidate.direction);

  return { localDx: nextDx, localDy: nextDy, direction };
}
