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
 * **The bar covers what was tracked, and nothing reads it differently for
 * that.** The null starts on the first sample and ends where the caller says,
 * the end of the last tracked frame. Keyframe times are stored relative to the
 * element's `startTime`, so every sample is shifted back by the first one. Two
 * facts keep the transform identical at every cursor to a null seated at 0
 * with the curve on absolute times: before `startTime`, `localSampleAt` reads
 * the static `location`, and that is seated on the first keyframe's value,
 * which is what the curve itself holds before its first keyframe; and nothing
 * reads a group's end (`renderer/timeline.ts`: its span does not gate its
 * children), so past the bar the curve holds its last value as before. A null
 * seated at 0 and given the project's length had a bar that started at 0 and
 * stopped wherever the project's duration said, short of a clip placed later.
 *
 * **`location` is the pivot's top-left, not its centre.** `localMatrixOf`
 * rotates and scales about `w/2, h/2`, so the tracked point has to be written
 * as `point - size/2`. Getting this wrong is invisible until somebody rotates
 * the null or parents something to it with an offset, and then everything
 * swings about a corner.
 *
 * **The static location is read off the built curve.** Not off the first
 * sample in the caller's order: `positionTrackFrom` sorts, drops what is not
 * finite and keeps the later of two samples at one instant, and the static
 * value has to equal the first keyframe exactly or a child parented to the null
 * jumps on the frame the bar begins.
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
  /**
   * Where the bar ends, exclusive, in timeline ms: the end of the last tracked
   * frame (`trackToTimeline.ts#trackedEndMs`). Absent, or short of the last
   * sample, the bar ends on the last sample, so no keyframe is ever past it.
   */
  endMs?: number;
  /** `bakeRateFor(fps)`: the caller reads the store, the op does not. */
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

  const usable = params.samples.filter(
    (sample) =>
      Number.isFinite(sample.tMs) &&
      Number.isFinite(sample.x) &&
      Number.isFinite(sample.y),
  );
  if (usable.length === 0) {
    return doc;
  }

  let firstMs = Infinity;
  let lastMs = -Infinity;
  for (const sample of usable) {
    firstMs = Math.min(firstMs, sample.tMs);
    lastMs = Math.max(lastMs, sample.tMs);
  }
  // `placeNewElement` clamps a start to 0, and the keyframes have to be
  // relative to the start it actually writes.
  const startMs = Math.max(0, firstMs);

  // The samples describe where the *feature* is; the element's `location` is
  // the top-left of the pivot box around it. Shifting here rather than in the
  // panel keeps the two halves of the same convention, this offset and
  // `createNullElement`'s `center`, next to each other.
  const half = size / 2;
  const located: PathSample[] = usable.map((sample) => ({
    tMs: sample.tMs - startMs,
    x: sample.x - half,
    y: sample.y - half,
  }));

  const position = positionTrackFrom(located, params.bakeHz);
  if (position == null) {
    return doc;
  }

  const endMs =
    Number.isFinite(params.endMs) && (params.endMs as number) > lastMs
      ? (params.endMs as number)
      : lastMs;

  const element = createNullElement({
    name: params.name ?? "Track",
    color: params.color,
    size,
    // Where the null sits before its bar, and when the position track is off:
    // the first keyframe's value, so neither moves whatever is parented to it.
    center: { x: position.x[0].p[1] + half, y: position.y[0].p[1] + half },
    startTime: startMs,
    duration: endMs - startMs,
  });

  const withTrack: GroupElementType = {
    ...element,
    animation: { ...element.animation, position },
  };

  return placeNewElement(
    doc,
    params.nullId,
    withTrack,
    startMs,
    params.newTrackId,
  );
}
