/**
 * The document edit: a tracked path becomes a null object.
 *
 * A pure `(TimelineDocument) => TimelineDocument`, applied by the panel through
 * `useTimelineStore.withCheckpoint`, so one tracking run is one undo step — the
 * same seam the agent's `commit` and the user's own mouse go through.
 *
 * It declines by returning **its input, by identity** when there is nothing to
 * write. `withCheckpoint` reads that as "nothing happened" and records no
 * history, which is what makes a track the user cancelled, or one that lost the
 * feature on its first frame, cost them nothing.
 *
 * ## Three things this has to get right
 *
 * **The null starts at 0, not at the clip.** `localSampleAt` falls back to the
 * element's *static* value for any cursor before its `startTime`, so a null
 * seated at the clip's start would have its own keyframes quietly ignored
 * everywhere to the left of it — the same trap `create_null` documents. Seating
 * it at 0 also collapses a conversion: keyframe times are stored relative to
 * the element's start, so with a start of 0 the stored time *is* the timeline
 * time.
 *
 * **`location` is the pivot's top-left, not its centre.** `localMatrixOf`
 * rotates and scales about `w/2, h/2`, so the tracked point has to be written
 * as `point − size/2`. Getting this wrong is invisible until somebody rotates
 * the null or parents something to it with an offset, and then everything
 * swings about a corner.
 *
 * **The null's `duration` gates nothing.** `renderer/timeline.ts` says a
 * group's span does not gate its children, so the bar's length is only how much
 * there is to aim at when setting a keyframe by hand later. It is given the
 * project's length rather than the clip's for that reason: a user extending the
 * track by hand should not first have to lengthen the bar.
 */

import type { GroupElementType } from "../../@types/timeline";
import { createNullElement, NULL_PIVOT_SIZE } from "../element/nullElement";
import { placeNewElement } from "../timeline/placement";
import type { TimelineDocument } from "../timeline/tracks";
import { positionTrackFrom } from "./keyframeTrack";
import type { PathSample } from "./simplify";

export type TrackNullParams = {
  /** The path, in project pixels and timeline ms. */
  samples: readonly PathSample[];
  /** Id for the new element. Passed in so the op stays deterministic. */
  nullId: string;
  /** Id to use if a new track row has to be made for it. */
  newTrackId: string;
  /** Shown on the bar. Defaults to "Track". */
  name?: string;
  color?: string;
  /** One side of the pivot square. */
  size?: number;
  /** How long the bar is. Usually the project's length, in ms. */
  durationMs?: number;
  /** `bakeRateFor(fps)` — the caller reads the store, the op does not. */
  bakeHz: number;
};

export function createTrackNull(
  doc: TimelineDocument,
  params: TrackNullParams,
): TimelineDocument {
  const size =
    Number.isFinite(params.size) && (params.size as number) > 0
      ? (params.size as number)
      : NULL_PIVOT_SIZE;

  // The samples describe where the *feature* is; the element's `location` is
  // the top-left of the pivot box around it. Shifting here rather than in the
  // panel keeps the two halves of the same convention — this offset and
  // `createNullElement`'s `center` — next to each other.
  const half = size / 2;
  const located: PathSample[] = params.samples.map((sample) => ({
    tMs: sample.tMs,
    x: sample.x - half,
    y: sample.y - half,
  }));

  const position = positionTrackFrom(located, params.bakeHz);
  if (position == null) {
    return doc;
  }

  const first = params.samples.find((sample) =>
    Number.isFinite(sample.x) && Number.isFinite(sample.y),
  );
  if (first == null) {
    return doc;
  }

  const element = createNullElement({
    name: params.name ?? "Track",
    color: params.color,
    size,
    // Where the null sits when the position track is off — the same place its
    // first keyframe puts it, so switching the stopwatch off does not teleport
    // whatever is parented to it.
    center: { x: first.x, y: first.y },
    startTime: 0,
    duration: params.durationMs,
  });

  const withTrack: GroupElementType = {
    ...element,
    animation: { ...element.animation, position },
  };

  return placeNewElement(doc, params.nullId, withTrack, 0, params.newTrackId);
}
