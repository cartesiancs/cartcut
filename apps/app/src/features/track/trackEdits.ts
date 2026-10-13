/**
 * The two edits the Auto Track panel makes, as pure document transforms.
 *
 * The panel is a Lit component and there is no DOM test environment here, so
 * everything a button press does to the document lives in this file instead,
 * and the panel only reads the store, mints ids and calls one of these inside
 * a `withCheckpoint`. One press, one undo step, whatever it builds.
 *
 * Both measure the track through `preRigElements`. A clip already in a
 * stabilize rig is drawn through its camera, and a track measured in that
 * picture would read back the stabilized feature, nearly still; measured
 * without the camera it reads the footage's own space, which is the space the
 * rig's children keep their numbers in.
 */

import { bakeRateFor } from "../animation/keyframes";
import { adoptIntoRig } from "../timeline/groupOps";
import { preRigElements, rigOf } from "../timeline/rig";
import type { TimelineDocument } from "../timeline/tracks";
import { seekedFrameMs } from "./frameSource";
import { simplifyPath } from "./simplify";
import {
  stabilize,
  stabilizeRefusal,
  type StabilizeOutcome,
  type StabilizeParams,
} from "./stabilizeOp";
import { joinRun } from "./trackPath";
import { toDisplayedPath, trackedEndMs } from "./trackToTimeline";
import { createTrackNull } from "./trackNullOp";
import type { TrackSample } from "./tracker";

export type TrackedClip = {
  clipId: string;
  /** The panel's path: source working pixels and source ms. */
  samples: readonly TrackSample[];
  frameWidth: number;
  frameHeight: number;
  /** One source frame, as the harvest measured it, or `null`. */
  sourceFrameMs: number | null;
  fps: number;
};

/**
 * Create Null: the track as a null, one point per project frame at the frame
 * on show, thinned for editing. On a stabilized clip the null goes into the
 * rig's camera beside the footage, where it sits on the feature in the
 * stabilized picture and a label parented to it follows that picture.
 */
export function createNullFromTrack(
  doc: TimelineDocument,
  tracked: TrackedClip,
  ids: { nullId: string; trackId: string },
): TimelineDocument {
  const element = doc.elements[tracked.clipId];
  if (element == null) {
    return doc;
  }

  const path = toDisplayedPath(tracked.samples, {
    elements: preRigElements(doc.elements, tracked.clipId),
    clipId: tracked.clipId,
    frameWidth: tracked.frameWidth,
    frameHeight: tracked.frameHeight,
    fps: tracked.fps,
    sourceFrameMs: tracked.sourceFrameMs,
  });

  const placed = createTrackNull(doc, {
    samples: simplifyPath(path),
    nullId: ids.nullId,
    newTrackId: ids.trackId,
    endMs: trackedEndMs(path, element, tracked.fps) ?? undefined,
    bakeHz: bakeRateFor(tracked.fps),
  });
  if (placed === doc) {
    return doc;
  }

  const rig = rigOf(placed.elements, tracked.clipId);
  return rig == null ? placed : adoptIntoRig(placed, rig.cameraId, [ids.nullId]);
}

/**
 * Stabilize: the null this track already made, if it is still there and still
 * fit, else a new one made in the same step; then the rig.
 *
 * All or nothing: a stabilize that refuses takes the new null with it, so a
 * refused press records no undo step at all.
 */
export function stabilizeFromTrack(
  doc: TimelineDocument,
  tracked: TrackedClip,
  ids: { reuseNullId: string | null; nullId: string; nullTrackId: string },
  params: Omit<StabilizeParams, "clipId" | "nullId" | "fps">,
): { doc: TimelineDocument; outcome: StabilizeOutcome; nullId: string | null } {
  const reusable =
    ids.reuseNullId != null &&
    stabilizeRefusal(doc, tracked.clipId, ids.reuseNullId) == null;

  let withNull = doc;
  let nullId = ids.reuseNullId;
  if (!reusable) {
    nullId = ids.nullId;
    withNull = createNullFromTrack(doc, tracked, {
      nullId: ids.nullId,
      trackId: ids.nullTrackId,
    });
    if (withNull === doc) {
      return { doc, outcome: { ok: false, reason: "missing-null" }, nullId: null };
    }
  }

  const result = stabilize(withNull, {
    ...params,
    clipId: tracked.clipId,
    nullId: nullId as string,
    fps: tracked.fps,
  });
  if (!result.outcome.ok) {
    return { doc, outcome: result.outcome, nullId: null };
  }
  return { doc: result.doc, outcome: result.outcome, nullId };
}

/**
 * A finished run joined onto what the panel kept of the track, with the seed
 * moved onto the frame its seek actually showed.
 *
 * The harvest reports the seed at the instant it asked for, and the frame a
 * seek shows can start up to a whole frame earlier (`seekedFrameMs`). Left
 * there, the seed reads as a frame on show for longer than it was. A kept
 * sample at or after the seated seed is that same frame, measured by an
 * earlier run, and the new run's answer replaces it.
 */
export function seatRun(
  kept: readonly TrackSample[],
  run: readonly TrackSample[],
  seedMs: number,
  arrivals: readonly number[],
  frameMs: number | null,
): readonly TrackSample[] {
  if (run.length === 0) {
    return kept;
  }
  const first = run[0];
  const seededAt =
    first.sourceMs === seedMs ? seekedFrameMs(seedMs, arrivals, frameMs) : first.sourceMs;
  const seated =
    seededAt === first.sourceMs ? run : [{ ...first, sourceMs: seededAt }, ...run.slice(1)];
  const before = kept.every((sample) => sample.sourceMs < seededAt)
    ? kept
    : kept.filter((sample) => sample.sourceMs < seededAt);
  return joinRun(before, seated);
}
