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

import type { Point } from "../timeline/transform";
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

  const floor = Number.isFinite(minSize) ? Math.max(0, minSize) : 0;
  // Proportions of a degenerate box are not a ratio, and scaling a box already
  // under the floor would have to make it *grow* to reach it. Either way, fall
  // back to the free path, which guards each axis on its own.
  const canConstrain = constrain && origin.w > floor && origin.h > floor;

  // Always a rect, never "no change" — the *document* decides whether anything
  // happened, by comparing what this returns against what the element already
  // holds (`resizedDocument`). Returning null for a rect that equalled `origin`
  // read as "skip the write", which quietly made the element keep the previous
  // mousemove's size: bring the pointer back to exactly where the drag began
  // and it stayed one event stale instead of returning to its original size.
  return canConstrain
    ? constrainedRect(origin, sign, localDx, localDy, floor)
    : freeRect(origin, sign, localDx, localDy, floor);
}

/**
 * Each axis moves, and hits the floor, on its own.
 *
 * Dragging a corner past the floor on one axis still resizes the other, which
 * is what the eight closures did — the two edge helpers a corner called each
 * carried their own guard — and it is what lets you flatten a shape against one
 * side without the whole drag freezing.
 *
 * Clamped rather than declined, as `constrainedRect` is. Declining meant
 * returning the side's *original* length, so a drag past the floor described a
 * box at full size; only the caller throwing the result away kept the element
 * pinned at the minimum, and a floor that depends on its caller ignoring it is
 * not a floor.
 */
function freeRect(
  o: Rect,
  sign: AxisSign,
  dx: number,
  dy: number,
  floor: number,
): Rect {
  let { x, y, w, h } = o;

  if (sign.sx !== 0) {
    w = Math.max(floor, o.w + sign.sx * dx);
    x = sign.sx > 0 ? o.x : o.x + o.w - w;
  }
  if (sign.sy !== 0) {
    h = Math.max(floor, o.h + sign.sy * dy);
    y = sign.sy > 0 ? o.y : o.y + o.h - h;
  }

  return { x, y, w, h };
}

/**
 * One scale factor for both axes, so the proportions cannot drift.
 *
 * A corner follows whichever axis the pointer pushed further — `max`, so the
 * grabbed corner reaches at least as far as the pointer on its dominant axis
 * and the element grows to meet a drag rather than splitting the difference.
 * An edge has only its own axis to go on and spreads the other about the
 * centre, which is what a locked edge drag has always done.
 */
function constrainedRect(
  o: Rect,
  sign: AxisSign,
  dx: number,
  dy: number,
  floor: number,
): Rect {
  const sw = sign.sx === 0 ? null : (o.w + sign.sx * dx) / o.w;
  const sh = sign.sy === 0 ? null : (o.h + sign.sy * dy) / o.h;

  let s = sw == null ? (sh as number) : sh == null ? sw : Math.max(sw, sh);
  // Clamp rather than decline: a constrained drag that reaches the floor should
  // stop there, not snap back to the size it started at. `canConstrain` has
  // already established both sides exceed the floor, so both bounds are below 1
  // and this can never force the element to grow.
  s = Math.max(s, floor / o.w, floor / o.h);

  const w = o.w * s;
  const h = o.h * s;

  const x =
    sign.sx > 0 ? o.x : sign.sx < 0 ? o.x + o.w - w : o.x - (w - o.w) / 2;
  const y =
    sign.sy > 0 ? o.y : sign.sy < 0 ? o.y + o.h - h : o.y - (h - o.h) / 2;

  return { x, y, w, h };
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

  const { originLocal, originLocation, next } = commit;

  // The anchor correction is measured against the mousedown rect and applied to
  // the mousedown field, so the animated and static positions never mix. With
  // no animation the two coincide and this is exactly `next.x`.
  const location = {
    x: originLocation.x + (next.x - originLocal.x),
    y: originLocation.y + (next.y - originLocal.y),
  };

  if (
    current.width === next.w &&
    current.height === next.h &&
    current.location?.x === location.x &&
    current.location?.y === location.y
  ) {
    // Identity, so the gesture records nothing for a drag that changed nothing
    // — the same decline-by-identity contract the pure timeline ops use.
    return doc;
  }

  return {
    ...doc,
    elements: {
      ...doc.elements,
      [elementId]: { ...current, width: next.w, height: next.h, location },
    },
  };
}
