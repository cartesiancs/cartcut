/**
 * A tracked path, as the `position` track of an element.
 *
 * ## Why this does not call `addKeyframe` in a loop
 *
 * Two reasons, and the second is the one that would have shown on screen.
 *
 * `keyframes.ts#addKeyframe` copies the list and runs `clampHandles` over all
 * of it on every call, so inserting `n` keyframes is quadratic — a few hundred
 * samples is a visible stall on the button press. That much is only slow.
 *
 * The real problem is the handles. `addKeyframe` seats every keyframe's `cs`
 * and `ce` **flat**, at `±DEFAULT_HANDLE_MS` with the anchor's own value, which
 * is an ease-in-out. That is the right default for a keyframe somebody placed:
 * two of them a second apart should glide. Here they are 16ms apart and there
 * are six hundred of them, and an ease at every one means the value comes to a
 * complete stop sixty times a second. The curve is a staircase, and it is a
 * staircase that reads as tracker jitter rather than as a wrong handle.
 *
 * So the keyframes are built directly with handles on the **chord**, at a third
 * of the way to each neighbour. A cubic bezier whose controls are evenly spaced
 * along the straight line between its anchors *is* that straight line —
 * `B(t) = P0 + t(P1 − P0)` exactly — so the result interpolates linearly
 * between samples, which is what a measurement should do. The samples carry the
 * shape; the interpolation between them must not invent any.
 *
 * `clampHandles` still runs once at the end, because the tolerance-based
 * thinning in `simplify.ts` can leave two keyframes a single frame apart and
 * the monotonicity invariant is the store's, not ours to assume.
 */

import { clampHandles } from "../animation/handleBounds";
import {
  bakeTrack,
  type Baked,
  type Keyframe,
  type VectorTrack,
} from "../animation/keyframes";
import type { PathSample } from "./simplify";

/**
 * The keyframes for one lane, with linear handles.
 *
 * `lane` names the field on the sample, not the field on the track: `x` and `y`
 * here are picture coordinates, and it is the caller that knows they land in
 * the track's `x`/`ax` and `y`/`ay` slots.
 */
export function laneKeyframes(
  samples: readonly PathSample[],
  lane: "x" | "y",
): Keyframe[] {
  const anchors: Keyframe[] = samples.map((sample) => ({
    type: "cubic" as const,
    p: [sample.tMs, sample[lane]] as [number, number],
    // Collapsed to start with; the two passes below push out the handles that
    // have a neighbour to point at. A single keyframe keeps both collapsed,
    // which is what `addKeyframe` does for the first keyframe on a track and
    // means the same thing: there is no curve, so there is no easing.
    cs: [sample.tMs, sample[lane]] as [number, number],
    ce: [sample.tMs, sample[lane]] as [number, number],
  }));

  for (let i = 0; i < anchors.length - 1; i++) {
    const from = anchors[i].p;
    const to = anchors[i + 1].p;
    const dt = (to[0] - from[0]) / 3;
    const dv = (to[1] - from[1]) / 3;

    anchors[i].ce = [from[0] + dt, from[1] + dv];
    anchors[i + 1].cs = [to[0] - dt, to[1] - dv];
  }

  return clampHandles(anchors);
}

/**
 * The whole `position` track for a tracked path.
 *
 * `null` when there is nothing to write — no samples, or every sample at the
 * same instant. The caller turns that into a declined edit rather than an
 * active track with an empty curve, which would switch the stopwatch on and
 * pin the element wherever `sampleBaked` fell back to.
 */
export function positionTrackFrom(
  samples: readonly PathSample[],
  bakeHz: number,
): VectorTrack | null {
  const ordered = sortedByTime(samples);
  if (ordered.length === 0) {
    return null;
  }

  const x = laneKeyframes(ordered, "x");
  const y = laneKeyframes(ordered, "y");

  return {
    isActivate: true,
    x,
    y,
    ax: bakeTrack(x, bakeHz) as Baked,
    ay: bakeTrack(y, bakeHz) as Baked,
  };
}

/**
 * Sorted, finite, and one sample per instant.
 *
 * The frames arrive in order from `frameSource.ts`, so this is not sorting so
 * much as insisting: `requestVideoFrameCallback` reports the *presentation*
 * time of whatever the compositor showed, and a repeated or reordered
 * `mediaTime` at a seek boundary is a thing that happens. `bakeTrack` and
 * `sampleBaked` both take a strictly increasing list as a precondition, so this
 * is the boundary where that becomes true.
 *
 * Later wins on a tie, matching `addKeyframe`, which replaces the value at a
 * time it already holds.
 */
function sortedByTime(samples: readonly PathSample[]): PathSample[] {
  const usable = samples.filter(
    (sample) =>
      Number.isFinite(sample.tMs) &&
      Number.isFinite(sample.x) &&
      Number.isFinite(sample.y),
  );

  usable.sort((a, b) => a.tMs - b.tMs);

  const out: PathSample[] = [];
  for (const sample of usable) {
    if (out.length > 0 && out[out.length - 1].tMs === sample.tMs) {
      out[out.length - 1] = sample;
      continue;
    }
    out.push(sample);
  }
  return out;
}
