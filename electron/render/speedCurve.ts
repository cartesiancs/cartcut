/**
 * The speed ramp's arithmetic, for the main process.
 *
 * A hand copy of `apps/app/src/features/timeline/speedCurve.ts`, and copied for
 * the reason this file's neighbours already are: `.tsconfig/tsconfig.json` pins
 * `rootDir` to `electron/`, so one import from `apps/app/src` relocates the
 * build from `main/` to `main/electron/` and the app stops finding its entry
 * point. `ffmpegArgs.ts` carries copies of `speedOf`, `isAudible` and `gainOf`
 * on the same terms.
 *
 * Pre-digesting the curve in the renderer and shipping a table instead was the
 * alternative and is worse: the export's audio pre-pass needs the inverse map
 * about fifty thousand times a second of clip, so the table would be the size of
 * the audio it describes.
 *
 * `speedCurve.test.ts` imports **both** copies and requires bit equality over a
 * seeded fuzz. A divergence here is the worst failure this file can have: the
 * picture would be composited from one map and the sound stretched by another,
 * and the export would be the only place it showed.
 *
 * The curve itself needs no IPC work. `export/ipc.ts` already sends the whole
 * element map to `render.v2.start`, so `speedCurve` arrives by structured clone.
 */

export type SpeedPoint = { t: number; v: number };

export type SpeedCurve = {
  readonly points: readonly SpeedPoint[];
  readonly cum: readonly number[];
};

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
export const FLAT_SPEED_EPSILON = 1e-9;
export const MAX_CURVE_POINTS = 64;

function clampSpeed(value: number): number {
  return value < MIN_SPEED ? MIN_SPEED : value > MAX_SPEED ? MAX_SPEED : value;
}

function isFlatSegment(s0: number, s1: number): boolean {
  return Math.abs(s1 - s0) < FLAT_SPEED_EPSILON * s0;
}

function segmentSpan(s0: number, s1: number, d: number, w: number): number {
  if (isFlatSegment(s0, s1)) {
    return w / s0;
  }
  const m = (s1 - s0) / d;
  return Math.log1p((m * w) / s0) / m;
}

function segmentSource(s0: number, s1: number, d: number, u: number): number {
  if (isFlatSegment(s0, s1)) {
    return s0 * u;
  }
  const m = (s1 - s0) / d;
  return (s0 * Math.expm1(m * u)) / m;
}

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
  return from.t + segmentSource(from.v, to.v, to.t - from.t, u - curve.cum[i]);
}

function cleanPoints(value: unknown): SpeedPoint[] | null {
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
    kept.push({ t, v: clampSpeed(v) });
  }

  if (kept.length < 2) {
    return null;
  }

  kept.sort((left, right) => left.t - right.t);

  const spaced: SpeedPoint[] = [kept[0]];
  for (let i = 1; i < kept.length && spaced.length < MAX_CURVE_POINTS; i++) {
    if (kept[i].t - spaced[spaced.length - 1].t > 0) {
      spaced.push(kept[i]);
    }
  }

  if (spaced.length < 2) {
    return null;
  }

  const first = spaced[0].v;
  if (spaced.every((point) => Math.abs(point.v - first) < FLAT_SPEED_EPSILON)) {
    return null;
  }

  return spaced;
}

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

/** The read guard: an element's ramp, prepared, or `null` for a constant rate. */
export function speedCurveOf(element: unknown): SpeedCurve | null {
  if (element == null || typeof element !== "object") {
    return null;
  }
  const points = cleanPoints((element as { speedCurve?: unknown }).speedCurve);
  if (points == null) {
    return null;
  }
  return prepareSpeedCurve(points);
}

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

export function curveSpanLength(
  curve: SpeedCurve,
  fromSourceMs: number,
  toSourceMs: number,
): number {
  return (
    timelineFromFirst(curve, toSourceMs) - timelineFromFirst(curve, fromSourceMs)
  );
}

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
