/**
 * One drag of one keyframe or handle, as a pure transform.
 *
 * The rule the component used to state in a comment and now cannot break:
 * **every frame recomputes from the document as it stood when the drag began**,
 * rather than folding the latest delta into the result of the last frame. The
 * compounding version drifted — each frame's rounding error was carried into
 * the next — and, worse, it re-read an index that `moveKeyframe` re-sorts, so
 * dragging one keyframe past another started moving a different keyframe.
 *
 * Nothing here touches the store. The caller previews the returned document
 * through `previewDocument`, which records no history, and commits once on
 * mouseup through `withCheckpoint`. That is what makes a drag one undo step
 * instead of several hundred.
 */

import type { AnimatableProperty } from "../../@types/timeline";
import type { TimelineDocument } from "../timeline/tracks";
import {
  moveKeyframePaired,
  setHandles,
  type Lane,
} from "../animation/keyframeOps";
import { lanesOf, sameKeyframes } from "../animation/keyframes";
import {
  clampToClip,
  msPerPx,
  snapTime,
  toTrack,
  type Hit,
  type Viewport,
} from "./editorGeometry";

/** Which curve is being edited. */
export type DragTarget = {
  elementId: string;
  property: AnimatableProperty;
  lane: Lane;
};

export type DragState = {
  /** The document as it stood when the pointer went down. */
  originDoc: TimelineDocument;
  /** Index into `originDoc`, which never re-sorts underneath us. */
  originIndex: number;
  part: Hit["part"];
  target: DragTarget;
};

/** How near, in px, a time has to be to snap. */
export const SNAP_RADIUS_PX = 6;

export function beginDrag(
  doc: TimelineDocument,
  target: DragTarget,
  hit: Hit,
): DragState {
  return {
    originDoc: doc,
    originIndex: hit.index,
    part: hit.part,
    target,
  };
}

/**
 * The instants a dragged keyframe should be pulled onto.
 *
 * The playhead above all — lining a keyframe up with where you are scrubbed to
 * is the single most common thing anyone does in a curve editor, and landing
 * 3ms off it is invisible until the render is wrong. The clip's two ends
 * matter for the same reason.
 *
 * Not the sibling lane's keyframes: the paired ops keep the two lanes at
 * identical instants already, so they would only ever offer the time the
 * keyframe is being dragged away from.
 */
export function snapCandidates(
  v: Viewport,
  playheadMs: number,
): readonly number[] {
  return [playheadMs - v.startTime, 0, v.duration];
}

/**
 * Fold one pointer position into the drag.
 *
 * `enableSnap` is false while a modifier is held — the escape hatch for
 * placing a keyframe a few ms off the playhead on purpose.
 */
export function updateDrag(
  state: DragState,
  v: Viewport,
  px: number,
  py: number,
  opts: { playheadMs: number; enableSnap: boolean },
): { doc: TimelineDocument; index: number } {
  const { tMs, value } = toTrack(v, px, py);
  const { elementId, property, lane } = state.target;

  if (state.part === "p") {
    const snapped = opts.enableSnap
      ? snapTime(
          tMs,
          snapCandidates(v, opts.playheadMs),
          SNAP_RADIUS_PX * msPerPx(v.timelineRange),
        )
      : tMs;

    return moveKeyframePaired(
      state.originDoc,
      elementId,
      property,
      lane,
      state.originIndex,
      clampToClip(v, snapped),
      value,
    );
  }

  // Handles are not snapped and not clamped to the clip here: `setHandles`
  // already constrains them to the span between their anchor and the
  // neighbour they point at, which is a tighter bound and lies inside the clip
  // by construction. See `handleBounds`.
  return {
    doc: setHandles(
      state.originDoc,
      elementId,
      property,
      lane,
      state.originIndex,
      state.part === "cs" ? { cs: [tMs, value] } : { ce: [tMs, value] },
    ),
    index: state.originIndex,
  };
}

/**
 * Whether a drag actually changed the curve.
 *
 * Identity is not enough: the ops build a fresh document on every mousemove, so
 * `!==` says "changed" about a drag that ended exactly where it began, and
 * `withCheckpoint` would record an undo step that appears to do nothing.
 *
 * Both lanes, because a position drag moves both.
 */
export function curveChanged(
  before: TimelineDocument,
  after: TimelineDocument,
  target: DragTarget,
): boolean {
  if (before === after) {
    return false;
  }
  const read = (doc: TimelineDocument, lane: Lane) =>
    (doc.elements[target.elementId] as any)?.animation?.[target.property]?.[
      lane
    ] ?? [];

  for (const lane of lanesOf(target.property)) {
    if (!sameKeyframes(read(before, lane), read(after, lane))) {
      return true;
    }
  }
  return false;
}
