/**
 * Thinning a tracked path down to keyframes anyone can edit.
 *
 * A ten-second track at 60fps is 600 samples. Written straight out that is 600
 * keyframes on each of two lanes, which makes the curve editor a solid band of
 * diamonds, adds a couple of hundred kilobytes to the `.ngt`, and gives the
 * user nothing they can grab: the whole value of a keyframe is that it is a
 * place you can move, and there is no moving one of 600.
 *
 * So the path is simplified with Ramer–Douglas–Peucker, which keeps the samples
 * the track actually needs and drops the ones the interpolation between their
 * neighbours already reproduces. A car crossing frame at constant speed becomes
 * two keyframes; the frame it swerves on is kept, and so is the frame it pulls
 * away from a standstill on — see `reconstructionError` for why the second of
 * those does not come for free.
 *
 * **The decimation is 2D.** Running it on `x` and then on `y` would produce two
 * lanes with different keyframe times, and `position` is a paired track —
 * `lanesOf` gives it both lanes and every op in `keyframeOps` writes them
 * together. Splitting the times would also be wrong on its own terms: a corner
 * that shows only in `y` still needs an `x` keyframe at that instant, or `x`
 * interpolates straight through it.
 *
 * Pure and DOM-free, like everything else under `features/track/`.
 */

export type PathSample = {
  /** Timeline milliseconds. */
  tMs: number;
  x: number;
  y: number;
};

/**
 * How far, in pixels, a dropped sample may sit from the line drawn in its place.
 *
 * Half a pixel: below what anyone can see at 100% zoom, and comfortably below
 * the tracker's own accuracy, so the simplification cannot be the largest error
 * in the chain. A caller wanting every frame passes 0.
 */
export const DEFAULT_TOLERANCE_PX = 0.5;

/**
 * Drop the samples a straight line already accounts for.
 *
 * Iterative rather than recursive: a 120fps five-minute track is 36,000 samples
 * and the worst case for RDP is one frame of recursion per sample, which
 * overflows the stack on exactly the input that most needs thinning.
 */
export function simplifyPath(
  samples: readonly PathSample[],
  tolerancePx: number = DEFAULT_TOLERANCE_PX,
): PathSample[] {
  // Nothing to remove from two points, and nothing meaningful to measure
  // against: the line through them is them.
  if (samples.length <= 2) {
    return [...samples];
  }
  if (!(tolerancePx > 0)) {
    return [...samples];
  }

  const keep = new Uint8Array(samples.length);
  keep[0] = 1;
  keep[samples.length - 1] = 1;

  const stack: [number, number][] = [[0, samples.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    if (last - first < 2) {
      continue;
    }

    let worst = 0;
    let worstIndex = -1;

    for (let i = first + 1; i < last; i++) {
      const distance = reconstructionError(
        samples[i],
        samples[first],
        samples[last],
      );
      if (distance > worst) {
        worst = distance;
        worstIndex = i;
      }
    }

    if (worstIndex >= 0 && worst > tolerancePx) {
      keep[worstIndex] = 1;
      stack.push([first, worstIndex]);
      stack.push([worstIndex, last]);
    }
  }

  const out: PathSample[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (keep[i] === 1) {
      out.push(samples[i]);
    }
  }
  return out;
}

/**
 * How far the keyframe track would be from this sample if it were dropped.
 *
 * Textbook RDP measures the *perpendicular* distance to the chord, and that is
 * the wrong question here. Perpendicular distance asks whether the path passes
 * through the same places; a keyframe track has to answer whether it is in the
 * same place **at the same time**. The two differ exactly when the speed
 * changes without the direction doing so — which is a feature that holds still
 * and then moves off, or one that decelerates into a stop. Perpendicular
 * distance scores every one of those at zero, because they never leave the
 * line, and RDP then collapses a two-second hold and a sudden move into a
 * single slow constant drift across the whole span.
 *
 * So the error measured is the one the track will actually produce: the
 * endpoints interpolated **by time**, which is what the linear handles in
 * `keyframeTrack.ts` give, compared against where the tracker really was. That
 * keeps the tolerance in pixels — the unit it is quoted in and the unit anyone
 * can reason about — while making a change of speed just as visible to the
 * thinning as a change of direction.
 *
 * A segment with no duration cannot be interpolated across; it falls back to
 * the distance from its start, so nothing is dropped for free.
 */
function reconstructionError(
  point: PathSample,
  a: PathSample,
  b: PathSample,
): number {
  const span = b.tMs - a.tMs;
  if (span === 0) {
    return Math.hypot(point.x - a.x, point.y - a.y);
  }

  const t = (point.tMs - a.tMs) / span;
  return Math.hypot(
    point.x - (a.x + (b.x - a.x) * t),
    point.y - (a.y + (b.y - a.y) * t),
  );
}
