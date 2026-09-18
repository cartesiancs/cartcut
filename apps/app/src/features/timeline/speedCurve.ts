/**
 * The speed ramp: speed as a piecewise-linear function of **source** time.
 *
 * ## Why source time, and not a keyframe track
 *
 * Everything else animatable in this codebase is a track in `element.animation`,
 * and this deliberately is not. Two reasons, and either alone decides it:
 *
 *  - keyframe times are clip-local **timeline** ms, so a speed keyframe's own
 *    position would depend on the very curve it defines. The clip's length would
 *    become an implicit solve, and the last keyframe would sit at an edge that
 *    moves when you drag it;
 *  - tracks are read from a lane baked at `bakeRateFor(fps)`, so changing the
 *    project frame rate would re-integrate the curve and move the clip. That
 *    breaks "a rate change is a change of grid, not a re-cut".
 *
 * Keyed in **absolute source ms**, the same units and the same slicing rule as
 * `trim`, the curve costs `splitAt` nothing: both halves keep the same point
 * list, each half's trim window selects its part, and the integrals sum exactly.
 *
 * ## The invariant this exists to serve
 *
 * `element.speed` stays authoritative for the clip's *length* and becomes
 * **derived** whenever a curve is present:
 *
 *     speed === duration / curveSpanLength(curve, trim.startTime, trim.endTime)
 *
 * So `geometry.ts#spanLength` is still `duration / speed` and every collision,
 * ripple, placement and layout call site is untouched. The curve and the scalar
 * agree *exactly at both clip edges* and differ only inside, which is what makes
 * a call site nobody generalised show a slightly wrong frame mid-clip rather
 * than a wrong length. An older build that has never heard of `speedCurve` reads
 * `speed` and plays the clip at its mean rate, in the right place, at the right
 * length.
 *
 * ## Why the maths is closed form
 *
 * On a segment where speed runs `s0` to `s1` over source width `d`, with
 * `m = (s1 - s0) / d`, a source width `w` takes `log1p(m * w / s0) / m` of
 * timeline, and the inverse is `s0 * expm1(m * u) / m`. Both are exact and both
 * are cheap. Verified against a brute-force midpoint sum in `speedCurve.test.ts`.
 *
 * `log1p`/`expm1` rather than `log`/`exp` for the case the round trip hits every
 * time: a query width that is a tiny fraction of a steep segment, where the
 * argument is near zero and `1 + x` throws away the digits that carry the
 * answer. Measured on the steepest legal segment, 0.25x to 4x over ten source
 * ms: at a width of one nanosecond the naive form is out by 6.5e-8 relative and
 * these are exact. An almost flat segment is not the case that needs them, since
 * `FLAT_SPEED_EPSILON` takes that branch first.
 *
 * This file **imports nothing**, for the reason `features/project/assetPaths.ts`
 * does: `geometry.ts` has to import it, and it would otherwise close a cycle
 * through `speedOps.ts`. `MIN_SPEED`/`MAX_SPEED` live here and are re-exported
 * from `speedOps.ts`, where they used to live, exactly as `mergeOps.ts`
 * re-exports `ADJACENCY_EPSILON_MS`.
 */

/** One authored point: a speed at an absolute source instant. */
export type SpeedPoint = { t: number; v: number };

/**
 * A curve prepared for evaluation: validated points plus their prefix integrals.
 *
 * `cum[i]` is the timeline ms from `points[0].t` to `points[i].t`, so `cum[0]`
 * is 0 and the array is strictly increasing. Built by `speedCurveOf` and by
 * nothing else, so anything holding one knows the points are sorted, finite and
 * in range.
 */
export type SpeedCurve = {
  readonly points: readonly SpeedPoint[];
  readonly cum: readonly number[];
};

/** The range every rate in the project lives in, ramped or not. */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

/**
 * Closest two points may sit, in source ms.
 *
 * Restated rather than imported from `geometry.ts#MIN_SOURCE_MS`, which is the
 * same number for the same reason, because this file imports nothing. It bounds
 * the curve's maximum slope, which is what keeps the preview's frame-by-frame
 * rate integration honest and the export stretcher's read pointer from jumping
 * a whole analysis window between two output frames.
 */
export const MIN_CURVE_GAP_MS = 10;

/**
 * Most points one curve may carry.
 *
 * The evaluators are O(log n) and would not care, but the points are serialised
 * into `timeline.json` verbatim and a runaway drag handler that appended one per
 * mousemove would write thousands. A ramp nobody can see the shape of is not a
 * ramp anybody meant.
 */
export const MAX_CURVE_POINTS = 64;

/** Below this spread, a curve is a constant rate and is stored as one. */
export const FLAT_SPEED_EPSILON = 1e-9;

function clampSpeed(value: number): number {
  return value < MIN_SPEED ? MIN_SPEED : value > MAX_SPEED ? MAX_SPEED : value;
}

/**
 * Whether a segment's two speeds are close enough that the log form would be
 * arithmetic on noise.
 *
 * Measured against `s0`, which `clampSpeed` guarantees is at least `MIN_SPEED`,
 * so this is a relative test that cannot divide by anything small. Testing `m`
 * instead would take the flat branch for a real speed change across a very short
 * segment, which is the steepest ramp the format allows and the last one that
 * should be approximated.
 */
function isFlatSegment(s0: number, s1: number): boolean {
  return Math.abs(s1 - s0) < FLAT_SPEED_EPSILON * s0;
}

/** Timeline ms taken by source width `w` on a segment running `s0` to `s1` over `d`. */
function segmentSpan(s0: number, s1: number, d: number, w: number): number {
  if (isFlatSegment(s0, s1)) {
    return w / s0;
  }
  const m = (s1 - s0) / d;
  return Math.log1p((m * w) / s0) / m;
}

/** The inverse: source width covered by timeline `u` on that same segment. */
function segmentSource(s0: number, s1: number, d: number, u: number): number {
  if (isFlatSegment(s0, s1)) {
    return s0 * u;
  }
  const m = (s1 - s0) / d;
  return (s0 * Math.expm1(m * u)) / m;
}

/** Index of the segment holding `sourceMs`, assuming it is inside the points. */
function segmentAtSource(curve: SpeedCurve, sourceMs: number): number {
  const points = curve.points;
  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (points[mid].t <= sourceMs) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

/** Index of the segment holding timeline offset `u`, assuming it is inside `cum`. */
function segmentAtTimeline(curve: SpeedCurve, u: number): number {
  const cum = curve.cum;
  let low = 0;
  let high = cum.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (cum[mid] <= u) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Timeline ms from the curve's first point to `sourceMs`, signed.
 *
 * Outside the outermost points the end speed is **held**, so this extrapolates
 * in both directions rather than running out. That is load-bearing rather than
 * defensive: `loadedAssetStore` deliberately asks for source times outside the
 * trim window while a transition is running, and `transitionGeometry` measures
 * the unused head and tail of the source with it.
 */
function timelineFromFirst(curve: SpeedCurve, sourceMs: number): number {
  const points = curve.points;
  const last = points.length - 1;

  if (sourceMs <= points[0].t) {
    return (sourceMs - points[0].t) / points[0].v;
  }
  if (sourceMs >= points[last].t) {
    return curve.cum[last] + (sourceMs - points[last].t) / points[last].v;
  }

  const i = segmentAtSource(curve, sourceMs);
  const from = points[i];
  const to = points[i + 1];
  return (
    curve.cum[i] + segmentSpan(from.v, to.v, to.t - from.t, sourceMs - from.t)
  );
}

/** The inverse of `timelineFromFirst`. */
function sourceFromFirst(curve: SpeedCurve, u: number): number {
  const points = curve.points;
  const last = points.length - 1;
  const total = curve.cum[last];

  if (u <= 0) {
    return points[0].t + u * points[0].v;
  }
  if (u >= total) {
    return points[last].t + (u - total) * points[last].v;
  }

  const i = segmentAtTimeline(curve, u);
  const from = points[i];
  const to = points[i + 1];
  return (
    from.t + segmentSource(from.v, to.v, to.t - from.t, u - curve.cum[i])
  );
}

/**
 * Clean a raw point list into the shape the evaluators require, or `null`.
 *
 * Shared by the read guard and the write validator, which differ only in whether
 * they enforce `MIN_CURVE_GAP_MS`: a reader must not silently move a point some
 * earlier writer allowed, and a writer must not store two points a microsecond
 * apart.
 */
function cleanPoints(
  value: unknown,
  enforceGap: boolean,
): SpeedPoint[] | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }

  const kept: SpeedPoint[] = [];
  for (const entry of value) {
    if (entry == null || typeof entry !== "object") {
      continue;
    }
    const t = (entry as SpeedPoint).t;
    const v = (entry as SpeedPoint).v;
    if (!Number.isFinite(t) || !Number.isFinite(v)) {
      continue;
    }
    // Out of range is clamped rather than dropped, zero and negative included:
    // a point at 8x was somebody's intent to go fast, and dropping it would
    // silently change the shape of the ramp either side of it, which is a worse
    // answer than pinning it at the limit. `coerceSpeed` rejects instead,
    // because there the whole value is the pick and there is nothing to
    // preserve. Only a value no arithmetic can use is dropped.
    kept.push({ t, v: clampSpeed(v) });
  }

  if (kept.length < 2) {
    return null;
  }

  // Sorted rather than rejected, for the same reason: a hand-edited file that
  // listed its points out of order still describes a curve.
  kept.sort((left, right) => left.t - right.t);

  const gap = enforceGap ? MIN_CURVE_GAP_MS : 0;
  const spaced: SpeedPoint[] = [kept[0]];
  for (let i = 1; i < kept.length && spaced.length < MAX_CURVE_POINTS; i++) {
    const delta = kept[i].t - spaced[spaced.length - 1].t;
    // `delta > 0` holds even at gap 0, so an exact duplicate `t` keeps the
    // first: a zero-width segment has no slope and would divide by zero.
    if (delta > 0 && delta >= gap) {
      spaced.push(kept[i]);
    }
  }

  if (spaced.length < 2) {
    return null;
  }

  // A flat curve is exactly `element.speed` and costs nothing to evaluate as
  // one. `coerceSpeedCurve` never writes one, so this can only arrive from a
  // hand-edited project or a future build.
  const first = spaced[0].v;
  if (spaced.every((point) => Math.abs(point.v - first) < FLAT_SPEED_EPSILON)) {
    return null;
  }

  return spaced;
}

/**
 * The read guard: an element's curve, prepared, or `null` for a constant rate.
 *
 * Runs on every frame of every ramped clip and **must never throw**. Everything
 * unusable degrades to the scalar rate rather than to an error, which is the
 * `normalizeX` half of the pair `coerceSpeedCurve` completes.
 *
 * Points outside the trim window are **kept**, unchanged. That is what makes
 * trimming in and back out restore the ramp, and it is why the points are
 * absolute source ms rather than clip-local ones.
 *
 * Costs one property read and one `Array.isArray` for the overwhelmingly common
 * clip that has no curve at all.
 */
export function speedCurveOf(element: unknown): SpeedCurve | null {
  if (element == null || typeof element !== "object") {
    return null;
  }
  const points = cleanPoints(
    (element as { speedCurve?: unknown }).speedCurve,
    false,
  );
  if (points == null) {
    return null;
  }
  return prepareSpeedCurve(points);
}

/** Build the prefix integrals for an already-clean point list. */
export function prepareSpeedCurve(points: readonly SpeedPoint[]): SpeedCurve {
  const cum: number[] = new Array(points.length);
  cum[0] = 0;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const d = to.t - from.t;
    cum[i] = cum[i - 1] + segmentSpan(from.v, to.v, d, d);
  }
  return { points, cum };
}

/**
 * The write validator: a fresh, storable point list, or `null` to delete the key.
 *
 * `null` for a flat curve or fewer than two points is CLAUDE.md's rule that
 * setting a field back to its default deletes it, so a project nobody has ramped
 * saves byte-identically to one written before the feature existed.
 *
 * Always a **fresh** array of fresh objects, so a Lit component cannot alias its
 * own working list into the document and mutate it out from under an undo step.
 *
 * Deliberately **does not round**, following `coerceSpeed`: a rate of 1.7333x is
 * a rate somebody dragged to, and rounding would also make `mirrorSpeedCurve`
 * stop being an exact involution across a reverse and un-reverse.
 */
export function coerceSpeedCurve(value: unknown): SpeedPoint[] | null {
  const points = cleanPoints(value, true);
  if (points == null) {
    return null;
  }
  return points.map((point) => ({ t: point.t, v: point.v }));
}

/** The rate at a source instant. Held flat outside the outermost points. */
export function speedAtSource(curve: SpeedCurve, sourceMs: number): number {
  const points = curve.points;
  const last = points.length - 1;

  if (sourceMs <= points[0].t) {
    return points[0].v;
  }
  if (sourceMs >= points[last].t) {
    return points[last].v;
  }

  const i = segmentAtSource(curve, sourceMs);
  const from = points[i];
  const to = points[i + 1];
  return from.v + ((to.v - from.v) * (sourceMs - from.t)) / (to.t - from.t);
}

/**
 * Timeline ms between two source instants, signed and additive.
 *
 * Negative when `toSourceMs` is before `fromSourceMs`, and
 * `L(a, c) === L(a, b) + L(b, c)` exactly, which is what makes a split of a
 * ramped clip reconstruct to the original span.
 */
export function curveSpanLength(
  curve: SpeedCurve,
  fromSourceMs: number,
  toSourceMs: number,
): number {
  return timelineFromFirst(curve, toSourceMs) - timelineFromFirst(curve, fromSourceMs);
}

/** The inverse: the source instant `deltaTimelineMs` of timeline after `fromSourceMs`. */
export function curveSourceAt(
  curve: SpeedCurve,
  fromSourceMs: number,
  deltaTimelineMs: number,
): number {
  return sourceFromFirst(
    curve,
    timelineFromFirst(curve, fromSourceMs) + deltaTimelineMs,
  );
}

/**
 * The scalar `element.speed` must carry while this curve is on the clip.
 *
 * `null` when the window is degenerate, so the caller leaves the existing rate
 * alone rather than writing a `NaN` that would turn every span in the document
 * into one. Clamped, because a curve whose points are all in range integrates to
 * a mean in range and only float error can say otherwise.
 */
export function derivedSpeedOf(
  curve: SpeedCurve,
  trimStartMs: number,
  trimEndMs: number,
  durationMs: number,
): number | null {
  const span = curveSpanLength(curve, trimStartMs, trimEndMs);
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  return clampSpeed(durationMs / span);
}

/**
 * Whether two clips carry the same ramp, both raw field values.
 *
 * Two absent curves answer `true`, which is what lets `mergeOps#canJoin` ask one
 * question instead of three. The tolerances are there because a curve survives a
 * round trip through JSON and through `mirrorSpeedCurve`.
 */
export function sameSpeedCurve(a: unknown, b: unknown): boolean {
  const left = cleanPoints(a, false);
  const right = cleanPoints(b, false);
  if (left == null || right == null) {
    return left == null && right == null;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every(
    (point, i) =>
      Math.abs(point.t - right[i].t) < 1e-6 &&
      Math.abs(point.v - right[i].v) < 1e-9,
  );
}

/**
 * Reflect every point about a source instant, for a reversal.
 *
 * `applyReverse` points the clip at a file holding `[from, to]` backwards, where
 * a source instant `r` in the new file is `to - r` in the old one, so the curve
 * maps `t -> aboutMs - t` and the list comes back in the opposite order. `v` is
 * untouched: speed is a magnitude and playing footage backwards does not make it
 * faster.
 *
 * An exact involution, which is what makes `unreverse` need no bookkeeping of
 * its own: reflecting twice about the same axis is the identity.
 */
export function mirrorSpeedCurve(
  points: readonly SpeedPoint[],
  aboutMs: number,
): SpeedPoint[] {
  const mirrored: SpeedPoint[] = [];
  for (let i = points.length - 1; i >= 0; i--) {
    mirrored.push({ t: aboutMs - points[i].t, v: points[i].v });
  }
  return mirrored;
}
