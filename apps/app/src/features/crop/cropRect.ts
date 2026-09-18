/**
 * Where a crop rectangle goes when a grip is dragged.
 *
 * The crop tool's equivalent of `preview/resizeMath.ts#resizedRect`, and
 * deliberately not a reuse of it: the two answer different questions. A resize
 * moves a box on an infinite plane and has to keep the opposite corner still
 * while the box's own centre moves under it. A crop moves a rectangle inside a
 * *fixed* frame, so the anchor is trivially still, and what is hard instead is
 * the thing a resize never does, staying inside the frame, on both axes, while
 * holding an aspect ratio.
 *
 * Everything here is in **normalized frame coordinates**: the whole source frame
 * is the unit square, whatever its pixel size. That is what makes the session
 * survive the clip being moved, scaled or rotated mid-drag, and it is the same
 * reasoning `mask/penSession.ts` gives for holding its nodes in element-local
 * pixels rather than in world ones.
 *
 * **An absolute setter.** `origin` is the rect as it was when the pointer went
 * down and `dx`/`dy` are the total delta since, so replaying the same pointer
 * position gives the same rect however many times it is applied.
 * `resizeMath.ts:288-308` is the written record of what an adjusting setter
 * costs when the caller re-applies it every mousemove.
 */

import type { CropRect } from "../../@types/timeline";
import { MIN_CROP } from "../timeline/cropOps";
import type { StretchZone } from "../preview/hitTest";

/** The eight grips, plus the body of the rectangle. */
export type CropZone = StretchZone | "inside";

type AxisSign = -1 | 0 | 1;

/**
 * Which edge each grip drives, and therefore which one anchors.
 *
 * `+1` means the far edge moves and the near one is pinned, `-1` the reverse,
 * `0` that the grip does not drive that axis and the rectangle is held about its
 * centre there. The same table `preview/resizeMath.ts#AXIS_SIGN` keeps, and the
 * same meanings, so the two tools cannot disagree about what a grip called
 * `stretchNE` does.
 */
const AXIS_SIGN: Record<StretchZone, { sx: AxisSign; sy: AxisSign }> = {
  stretchE: { sx: 1, sy: 0 },
  stretchW: { sx: -1, sy: 0 },
  stretchN: { sx: 0, sy: -1 },
  stretchS: { sx: 0, sy: 1 },
  stretchNW: { sx: -1, sy: -1 },
  stretchNE: { sx: 1, sy: -1 },
  stretchSW: { sx: -1, sy: 1 },
  stretchSE: { sx: 1, sy: 1 },
};

export type CropDragInput = {
  /** The rect as it stood when the pointer went down. */
  origin: CropRect;
  zone: CropZone;
  /** Total pointer delta since mousedown, in normalized frame units. */
  dx: number;
  dy: number;
  /**
   * The locked aspect as the user means it: the **drawn** rectangle's width over
   * its height. `null` for a free drag.
   *
   * Drawn, not normalized, because "16:9" is a promise about what the viewer
   * sees. A frame is only square in normalized coordinates, so the two differ
   * for every clip that is not, and locking the normalized ratio would give a
   * 16:9 preset that produced 16:9 only on square footage.
   */
  aspect?: number | null;
  /** The whole frame's box in element-local pixels. Only its shape is read. */
  frame: { width: number; height: number };
};

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** The drawn aspect, expressed in the normalized coordinates this file works in. */
function normalizedAspect(
  aspect: number,
  frame: { width: number; height: number },
): number | null {
  if (
    !Number.isFinite(aspect) ||
    aspect <= 0 ||
    !(frame.width > 0) ||
    !(frame.height > 0)
  ) {
    return null;
  }
  return (aspect * frame.height) / frame.width;
}

/**
 * The point the drag holds still, in normalized frame coordinates.
 *
 * The edge opposite the one being driven, and the centre on an axis the grip
 * does not drive, which is what makes an east drag under an aspect lock grow
 * the rectangle symmetrically in height rather than dropping it downwards.
 */
function anchorOf(
  origin: CropRect,
  sx: AxisSign,
  sy: AxisSign,
): { x: number; y: number } {
  return {
    x:
      sx === 1
        ? origin.x
        : sx === -1
          ? origin.x + origin.width
          : origin.x + origin.width / 2,
    y:
      sy === 1
        ? origin.y
        : sy === -1
          ? origin.y + origin.height
          : origin.y + origin.height / 2,
  };
}

/** How far the rectangle may extend from its anchor before leaving the frame. */
function roomOf(anchor: number, sign: AxisSign): number {
  if (sign === 1) {
    return 1 - anchor;
  }
  if (sign === -1) {
    return anchor;
  }
  // Undriven: the rectangle spreads both ways about the anchor, so the shorter
  // side is what runs out first.
  return 2 * Math.min(anchor, 1 - anchor);
}

/** Place a sized rectangle so its anchor stays where it is. */
function placedAt(
  anchor: { x: number; y: number },
  sx: AxisSign,
  sy: AxisSign,
  width: number,
  height: number,
): CropRect {
  return {
    x: sx === 1 ? anchor.x : sx === -1 ? anchor.x - width : anchor.x - width / 2,
    y: sy === 1 ? anchor.y : sy === -1 ? anchor.y - height : anchor.y - height / 2,
    width,
    height,
  };
}

/** Sliding the whole rectangle, which changes no edge and only has to stay in. */
function draggedInside(origin: CropRect, dx: number, dy: number): CropRect {
  return {
    x: clamp(origin.x + dx, 0, Math.max(0, 1 - origin.width)),
    y: clamp(origin.y + dy, 0, Math.max(0, 1 - origin.height)),
    width: origin.width,
    height: origin.height,
  };
}

/**
 * The crop rectangle a drag has reached.
 *
 * Always a rect, never "no change": whether anything happened is the session's
 * question, and returning the origin for a drag that hit a limit would make the
 * rectangle snap back to where the gesture started rather than resting against
 * the edge.
 */
export function cropDragged(input: CropDragInput): CropRect {
  const { origin, zone, frame } = input;
  const dx = Number.isFinite(input.dx) ? input.dx : 0;
  const dy = Number.isFinite(input.dy) ? input.dy : 0;

  if (zone === "inside") {
    return draggedInside(origin, dx, dy);
  }

  const sign = AXIS_SIGN[zone];
  if (sign == null) {
    return origin;
  }

  const anchor = anchorOf(origin, sign.sx, sign.sy);
  const roomX = roomOf(anchor.x, sign.sx);
  const roomY = roomOf(anchor.y, sign.sy);

  // What the pointer asks for on each axis it drives, before any limit but the
  // floor.
  //
  // The floor is applied **here**, not only in the branches below, because a
  // grip dragged past its own opposite edge asks for a negative size. The free
  // branch would clamp that away, but the locked branch multiplies it by the
  // ratio and divides the frame's room by it, and a negative divisor turns the
  // whole fit backwards: dragging the north grip down past the south one
  // silently produced a rectangle of the wrong shape rather than a flat one.
  const wantedWidth =
    sign.sx === 0
      ? origin.width
      : Math.max(MIN_CROP, origin.width + sign.sx * dx);
  const wantedHeight =
    sign.sy === 0
      ? origin.height
      : Math.max(MIN_CROP, origin.height + sign.sy * dy);

  const aspect =
    input.aspect == null ? null : normalizedAspect(input.aspect, frame);

  if (aspect == null) {
    // Each axis moves, and hits its limit, on its own. Clamped rather than
    // declined, so a drag past the edge rests there instead of describing a
    // rectangle outside the frame.
    return placedAt(
      anchor,
      sign.sx,
      sign.sy,
      clamp(wantedWidth, MIN_CROP, Math.max(MIN_CROP, roomX)),
      clamp(wantedHeight, MIN_CROP, Math.max(MIN_CROP, roomY)),
    );
  }

  // One number drives both sides, so the ratio cannot drift. A corner follows
  // whichever axis the pointer pushed further, which is what makes the grabbed
  // corner reach the pointer rather than splitting the difference; an edge has
  // only its own axis to go on, and the other follows the ratio about the
  // centre. The same rule `resizeMath.ts#constrainedSize` states.
  let width: number;
  if (sign.sx !== 0 && sign.sy !== 0) {
    width = Math.max(wantedWidth, wantedHeight * aspect);
  } else if (sign.sx !== 0) {
    width = wantedWidth;
  } else {
    width = wantedHeight * aspect;
  }
  let height = width / aspect;

  // Shrink both together until the whole rectangle fits, rather than clamping
  // one axis and breaking the lock the user asked for.
  const fit = Math.min(1, roomX / width, roomY / height);
  if (Number.isFinite(fit) && fit < 1) {
    width *= fit;
    height *= fit;
  }

  // The floor, also applied to both. A ratio so extreme that one side cannot
  // reach the floor without the other leaving the frame is unreachable from the
  // presets, but the guard keeps the rect usable rather than inverted.
  const lift = Math.max(1, MIN_CROP / width, MIN_CROP / height);
  if (Number.isFinite(lift) && lift > 1) {
    width *= lift;
    height *= lift;
  }

  width = clamp(width, MIN_CROP, 1);
  height = clamp(height, MIN_CROP, 1);

  const placed = placedAt(anchor, sign.sx, sign.sy, width, height);
  // A last clamp on the origin alone, for the case the two guards above fought:
  // the size is already legal, so this can only slide the rectangle back in.
  return {
    x: clamp(placed.x, 0, Math.max(0, 1 - placed.width)),
    y: clamp(placed.y, 0, Math.max(0, 1 - placed.height)),
    width: placed.width,
    height: placed.height,
  };
}
