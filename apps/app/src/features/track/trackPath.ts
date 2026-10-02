/**
 * One clip's track, built from runs that may start anywhere in it.
 *
 * After Effects' way of fixing a track: go back to the last frame it was right,
 * put the point back on the feature, analyse again, and everything from there
 * on is rewritten. The panel has no buttons for any of that, so the click says
 * which of three things is meant:
 *
 * - **Near the track, inside its span**: a correction. The samples before that
 *   frame are kept and the run replaces the rest.
 * - **After its end, within reach of where it ended**: a continuation, the
 *   usual case after a run that lost its feature or was cancelled. All of it
 *   is kept.
 * - **Anywhere else**: a different feature. The old track goes.
 *
 * Reach grows with the time since the track's last sample, because the feature
 * has gone on moving since: `nearPx`, plus `REACH_PX_PER_MS` for each ms, up to
 * `MAX_REACH_FACTOR` times `nearPx`. Without the distance test past the end,
 * a short track of one thing and a click on another later in the clip were
 * joined into one path, and the null built from it jumped between the two.
 *
 * A run seeded before the track begins replaces all of it, which needs no rule.
 *
 * Every sample is in source ms and working-frame pixels, as `tracker.ts`
 * produces them, and a path is sorted by `sourceMs` with no repeats.
 */

import type { TrackSample } from "./tracker";

export type PathPoint = { x: number; y: number };

/** A quarter of the 960px working width per second. */
export const REACH_PX_PER_MS = 0.25;

/**
 * The ceiling on reach. Past it a gap is long enough for the feature to be
 * anywhere, and a click anywhere is likelier to be a new feature than this one.
 */
export const MAX_REACH_FACTOR = 4;

/** Where the track is at `sourceMs`, interpolated, or null outside its span. */
export function positionAt(
  path: readonly TrackSample[],
  sourceMs: number,
): PathPoint | null {
  if (
    path.length === 0 ||
    !(sourceMs >= path[0].sourceMs) ||
    !(sourceMs <= path[path.length - 1].sourceMs)
  ) {
    return null;
  }

  // The first sample at or after `sourceMs`.
  let lo = 0;
  let hi = path.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (path[mid].sourceMs < sourceMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const after = path[lo];
  if (lo === 0 || after.sourceMs === sourceMs) {
    return { x: after.x, y: after.y };
  }
  const before = path[lo - 1];
  const t = (sourceMs - before.sourceMs) / (after.sourceMs - before.sourceMs);
  return {
    x: before.x + (after.x - before.x) * t,
    y: before.y + (after.y - before.y) * t,
  };
}

/**
 * The samples a run seeded at `sourceMs` on `point` keeps.
 *
 * `nearPx` is how far from the track a click may land and still mean "this is
 * the same feature". Inside the span the reference is the track's position at
 * that frame, so a correction is judged against where the track *was*, not
 * where it ended; past the end it is the last sample, with the reach above.
 *
 * Answers `path` itself when it keeps all of it, so a caller can tell a
 * continuation from a correction by identity.
 */
export function keptBy(
  path: readonly TrackSample[],
  sourceMs: number,
  point: PathPoint,
  nearPx: number,
): readonly TrackSample[] {
  if (path.length === 0) {
    return path;
  }
  if (sourceMs <= path[0].sourceMs) {
    return [];
  }

  const last = path[path.length - 1];
  if (sourceMs > last.sourceMs) {
    const reach = Math.min(
      nearPx * MAX_REACH_FACTOR,
      nearPx + REACH_PX_PER_MS * (sourceMs - last.sourceMs),
    );
    return Math.hypot(point.x - last.x, point.y - last.y) <= reach ? path : [];
  }

  const at = positionAt(path, sourceMs) as PathPoint;
  if (Math.hypot(point.x - at.x, point.y - at.y) > nearPx) {
    return [];
  }
  return path.filter((sample) => sample.sourceMs < sourceMs);
}

/**
 * The kept samples, then the run. An empty run answers `kept` by identity.
 *
 * Not for a run that refused its seed: that one changed nothing, and the panel
 * keeps the whole old track rather than the part this would keep.
 */
export function joinRun(
  kept: readonly TrackSample[],
  run: readonly TrackSample[],
): readonly TrackSample[] {
  if (run.length === 0) {
    return kept;
  }
  if (kept.length === 0) {
    return run;
  }
  return [...kept, ...run];
}
