/**
 * The crop tool's state machine, as pure data.
 *
 * `previewCanvas` is a dispatcher over this and nothing more: it turns a
 * `MouseEvent` into a point in the clip's frame and asks what should happen.
 * That split is `mask/penSession.ts`'s, and it is here for the same reason , 
 * this codebase has no DOM test environment, so a state machine living inside a
 * Lit class is a rule nothing can check, and the crop tool is the part of this
 * feature with the most cases to get wrong.
 *
 * ## Normalized frame coordinates, not box pixels and not world
 *
 * A session holds its rectangle in **fractions of the clip's whole source
 * frame**, which is the same space the stored `crop` field uses. Zooming,
 * panning, scrubbing and moving, rotating or scaling the clip mid-crop all
 * leave that number alone, so none of them has to touch the session, and the
 * rect the session commits is the field it commits to, with no conversion in
 * between that could be wrong.
 *
 * ## One session, one undo step
 *
 * Nothing here writes to the document. The session accumulates and the component
 * commits **once**, on Apply, so a crop is one undo step and an undo pressed
 * mid-crop cannot desynchronise the session from a document it has not touched.
 */

import type { CropRect } from "../../@types/timeline";
import { sameCrop } from "../timeline/cropOps";
import { centreOf, rectOfAspect, ratioOf, CROP_ASPECTS, type CropAspect } from "./aspects";
import { cropDragged, type CropZone } from "./cropRect";

export type CropPoint = { x: number; y: number };

/** The grab band, as a fraction of the frame on each axis. */
export type CropGrab = { x: number; y: number };

export type CropSession = {
  /** The clip being cropped, fixed for the life of the session. */
  elementId: string;
  /** The crop the clip had when the session opened. Apply compares against it. */
  origin: CropRect;
  /**
   * The whole source frame's box in element-local pixels, fixed for the session.
   *
   * Only its shape is read, and only by the aspect lock: a drawn ratio means
   * nothing without knowing what shape the frame is. Fixed at open rather than
   * re-read, so a `size` keyframe passing under the playhead cannot change what
   * "16:9" means halfway through a drag.
   */
  frame: { width: number; height: number };
  /** The rectangle the user is describing. */
  rect: CropRect;
  /** Which preset is selected, by `CropAspect.id`. */
  aspectId: string;
  /** The grip that is down, and the rect as it was when it went down. */
  drag: { zone: CropZone; rect: CropRect; from: CropPoint } | null;
  /** Live pointer, for the cursor shape. `null` before the first move. */
  hover: CropPoint | null;
};

/**
 * What the caller should do next.
 *
 * `"none"` is distinct from an unchanged session on purpose: the component
 * repaints on `"update"` and does not on `"none"`, so a pointer moving over the
 * overlay without a button down costs no frame unless something moved.
 */
export type CropAction =
  | { kind: "none" }
  | { kind: "update"; session: CropSession }
  | { kind: "commit"; session: CropSession }
  | { kind: "cancel" };

export function cropBegin(
  elementId: string,
  crop: CropRect,
  frame: { width: number; height: number },
): CropSession {
  return {
    elementId,
    origin: crop,
    frame,
    rect: crop,
    aspectId: "free",
    drag: null,
    hover: null,
  };
}

/** Whether Apply would actually change anything. */
export function cropChanged(session: CropSession): boolean {
  return !sameCrop(session.origin, session.rect);
}

/** The preset currently selected, or the free one. */
export function aspectOf(session: CropSession): CropAspect {
  return (
    CROP_ASPECTS.find((aspect) => aspect.id === session.aspectId) ??
    CROP_ASPECTS[0]
  );
}

/** The locked drawn ratio for this session, or `null` while it is free. */
function lockOf(session: CropSession): number | null {
  return ratioOf(aspectOf(session), session.frame);
}

/**
 * Which part of the rectangle a point is over.
 *
 * Corners before edges, because a corner point satisfies two edge bands at once
 * and a diagonal drag is what the user aimed at; edges before the body, because
 * the body is the fallback. The bands are clamped to a third of each side, the
 * rule `preview/hitTest.ts` uses and for its reason: past half a side the bands
 * overlap and a small rectangle reports a grip at every point on it, so it could
 * never be dragged as a whole.
 *
 * Exported so the component can set a cursor from a hover without inventing a
 * second copy of the rule.
 */
export function cropZoneAt(
  rect: CropRect,
  point: CropPoint,
  grab: CropGrab,
): CropZone | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return null;
  }

  const padX = Math.max(0, Math.min(grab.x, rect.width / 3));
  const padY = Math.max(0, Math.min(grab.y, rect.height / 3));

  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;

  const nearW = Math.abs(point.x - left) <= padX;
  const nearE = Math.abs(point.x - right) <= padX;
  const nearN = Math.abs(point.y - top) <= padY;
  const nearS = Math.abs(point.y - bottom) <= padY;

  const withinX = point.x >= left - padX && point.x <= right + padX;
  const withinY = point.y >= top - padY && point.y <= bottom + padY;

  if (withinX && withinY) {
    if (nearW && nearN) return "stretchNW";
    if (nearE && nearN) return "stretchNE";
    if (nearW && nearS) return "stretchSW";
    if (nearE && nearS) return "stretchSE";
    if (nearE) return "stretchE";
    if (nearW) return "stretchW";
    if (nearN) return "stretchN";
    if (nearS) return "stretchS";
  }

  if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) {
    return "inside";
  }
  return null;
}

/**
 * A press.
 *
 * A press that lands on nothing arms no drag and is **not** a miss the component
 * should pass on: the crop tool owns the whole preview while it is open, so a
 * click on the backdrop must not select a clip behind it.
 */
export function cropDown(
  session: CropSession,
  point: CropPoint,
  grab: CropGrab,
): CropAction {
  const zone = cropZoneAt(session.rect, point, grab);
  if (zone == null) {
    return { kind: "none" };
  }
  return {
    kind: "update",
    session: { ...session, drag: { zone, rect: session.rect, from: point }, hover: point },
  };
}

/**
 * The pointer moving, with or without a button down.
 *
 * With no drag armed this only records the hover, so the component can shape the
 * cursor. With one armed it recomputes the rectangle from the **rect as it was
 * at mousedown** and the total delta, which is what keeps `cropDragged` an
 * absolute setter.
 */
export function cropMove(session: CropSession, point: CropPoint): CropAction {
  const drag = session.drag;
  if (drag == null) {
    if (
      session.hover != null &&
      session.hover.x === point.x &&
      session.hover.y === point.y
    ) {
      return { kind: "none" };
    }
    return { kind: "update", session: { ...session, hover: point } };
  }

  const rect = cropDragged({
    origin: drag.rect,
    zone: drag.zone,
    dx: point.x - drag.from.x,
    dy: point.y - drag.from.y,
    aspect: lockOf(session),
    frame: session.frame,
  });

  if (sameCrop(rect, session.rect)) {
    return { kind: "update", session: { ...session, hover: point } };
  }
  return { kind: "update", session: { ...session, rect, hover: point } };
}

/** The button coming up. Disarms the drag; the session stays open. */
export function cropUp(session: CropSession): CropAction {
  if (session.drag == null) {
    return { kind: "none" };
  }
  return { kind: "update", session: { ...session, drag: null } };
}

/**
 * Pick an aspect preset, reshaping the rectangle around where it already is.
 *
 * Free leaves the rectangle exactly as it is: a lock is a constraint on the
 * *next* drag, and snapping on release of the constraint would throw away the
 * framing the user had already aimed.
 */
export function cropSetAspect(
  session: CropSession,
  aspectId: string,
): CropAction {
  const aspect = CROP_ASPECTS.find((candidate) => candidate.id === aspectId);
  if (aspect == null || aspect.id === session.aspectId) {
    return { kind: "none" };
  }

  const ratio = ratioOf(aspect, session.frame);
  if (ratio == null) {
    return { kind: "update", session: { ...session, aspectId: aspect.id } };
  }

  const rect = rectOfAspect(ratio, session.frame, centreOf(session.rect));
  return { kind: "update", session: { ...session, aspectId: aspect.id, rect } };
}

/**
 * Key codes the crop tool consumes while a session is live.
 *
 * Backspace and Delete are here for the reason `mask/penSession.ts` lists them:
 * the component installs a **capture-phase** listener for exactly these codes,
 * so without them a Backspace aimed at the crop would reach
 * `elementTimelineCanvas._handleKeydown` and delete the clip being cropped.
 * Given they have to be swallowed, they are given the useful meaning rather than
 * being made inert.
 *
 * Arrow keys are deliberately absent. They are already inert in a non-pointer
 * tool through the `cursorType` guards in `stepCursor` and
 * `moveSelectionByTrack`, which is a better place for it: a modal tool should
 * not have to enumerate every binding it is not using.
 */
export const CROP_KEY_CODES: readonly string[] = [
  "Escape",
  "Enter",
  "NumpadEnter",
  "Backspace",
  "Delete",
];

export function cropCapturesKey(code: string): boolean {
  return CROP_KEY_CODES.includes(code);
}

/**
 * A keystroke the crop tool owns.
 *
 * Enter on a rectangle that has not moved **cancels** rather than committing.
 * The visible result is the same, the tool closes and the clip is unchanged , 
 * and it keeps the commit path from ever reaching `withCheckpoint` with an edit
 * that would decline, which is one fewer way to record an empty undo step.
 */
export function cropKey(session: CropSession, code: string): CropAction {
  switch (code) {
    case "Escape":
      return { kind: "cancel" };
    case "Enter":
    case "NumpadEnter":
      return cropChanged(session)
        ? { kind: "commit", session: { ...session, drag: null } }
        : { kind: "cancel" };
    case "Backspace":
    case "Delete": {
      const full = { x: 0, y: 0, width: 1, height: 1 };
      if (sameCrop(session.rect, full)) {
        return { kind: "none" };
      }
      return {
        kind: "update",
        session: { ...session, rect: full, aspectId: "free", drag: null },
      };
    }
    default:
      return { kind: "none" };
  }
}
