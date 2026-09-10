/**
 * Edge snapping for a dragged clip.
 *
 * The version this replaces ran four independent `if` blocks — leading edge to
 * neighbour start, leading to end, trailing to start, trailing to end — and let
 * each one write the position. The **last** match won rather than the nearest,
 * so with two candidates in range the clip jumped to whichever happened to be
 * tested last. Here every candidate is scored and the closest wins.
 *
 * Tolerance is in pixels, not milliseconds: snapping should feel the same at
 * every zoom level, which means the time window has to narrow as you zoom in.
 */

import { msToPxSigned, spanOf } from "./geometry";
import type { TimelineDocument } from "./tracks";

export type SnapKind = "clipStart" | "clipEnd" | "playhead" | "origin";

export type SnapPoint = {
  ms: number;
  kind: SnapKind;
  /** The track the point came from, for preferring same-row alignment. */
  trackId?: string;
};

export type SnapResult = {
  startMs: number;
  hit: SnapPoint | null;
  /** Which edge of the dragged span did the snapping. */
  edge: "start" | "end" | null;
};

/** What `snapEdge` answers: where one edge lands, and what pulled it there. */
export type EdgeSnapResult = {
  ms: number;
  hit: SnapPoint | null;
};

/**
 * Everything a drag can snap to.
 *
 * The dragged clips are excluded so a clip cannot snap to where it already is,
 * which would pin it in place.
 */
export function collectSnapPoints(
  doc: TimelineDocument,
  opts: { excludeIds?: string[]; playheadMs?: number } = {},
): SnapPoint[] {
  const excluded = new Set(opts.excludeIds ?? []);
  const points: SnapPoint[] = [{ ms: 0, kind: "origin" }];

  if (opts.playheadMs != null) {
    points.push({ ms: opts.playheadMs, kind: "playhead" });
  }

  for (const [id, element] of Object.entries(doc.elements)) {
    if (excluded.has(id)) {
      continue;
    }
    const { start, end } = spanOf(element);
    points.push({ ms: start, kind: "clipStart", trackId: element.trackId });
    points.push({ ms: end, kind: "clipEnd", trackId: element.trackId });
  }

  return points;
}

/**
 * The nearest point to one edge, or `null` if none is within tolerance.
 *
 * The scoring core both public functions share. `score` comes back so a caller
 * weighing two edges against each other can compare them on the same footing —
 * which is the whole reason this is a separate function rather than inlined
 * twice.
 *
 * Ties go to the earliest point in the array, because the comparison is strict.
 */
function nearestPoint(
  edgeMs: number,
  points: SnapPoint[],
  range: number,
  tolerancePx: number,
  preferTrackId?: string,
): { point: SnapPoint; score: number } | null {
  let best: { point: SnapPoint; score: number } | null = null;

  for (const point of points) {
    const distancePx = Math.abs(msToPxSigned(point.ms - edgeMs, range));

    if (distancePx > tolerancePx) {
      continue;
    }

    // A same-track point wins any tie; the nudge keeps it from beating a
    // point that is genuinely closer.
    const score =
      preferTrackId != null && point.trackId === preferTrackId
        ? distancePx - 0.001
        : distancePx;

    if (best == null || score < best.score) {
      best = { point, score };
    }
  }

  return best;
}

/**
 * Snap one edge, leaving everything else alone.
 *
 * What a **trim** needs, and the reason `snapSpan` could not simply be reused
 * for it: that one moves a span of fixed length, so its answer is a `startMs`
 * and its trailing-edge branch computes `point.ms - lengthMs`. A trim pins one
 * edge and moves the other, and the length is a consequence rather than an
 * input.
 */
export function snapEdge(
  edgeMs: number,
  points: SnapPoint[],
  range: number,
  tolerancePx: number,
  preferTrackId?: string,
): EdgeSnapResult {
  const best = nearestPoint(edgeMs, points, range, tolerancePx, preferTrackId);
  return best == null
    ? { ms: edgeMs, hit: null }
    : { ms: best.point.ms, hit: best.point };
}

/**
 * Snap a span of `lengthMs` starting at `startMs`.
 *
 * Both edges are candidates. Ties prefer the leading edge, and a point on
 * `preferTrackId` beats an equally close one elsewhere — aligning to the row
 * you are dropping onto is almost always what was meant.
 */
export function snapSpan(
  startMs: number,
  lengthMs: number,
  points: SnapPoint[],
  range: number,
  tolerancePx: number,
  preferTrackId?: string,
): SnapResult {
  const leading = nearestPoint(
    startMs,
    points,
    range,
    tolerancePx,
    preferTrackId,
  );
  const trailing = nearestPoint(
    startMs + lengthMs,
    points,
    range,
    tolerancePx,
    preferTrackId,
  );

  // `<=` is the documented "ties prefer the leading edge" rule, now applied to
  // every tie rather than only to a tie on the same point. The loop this
  // replaces scored point-major and compared strictly, so an equal score on a
  // point earlier in the array beat the leading edge — array order deciding
  // what the docstring says the edge decides.
  if (leading != null && (trailing == null || leading.score <= trailing.score)) {
    return { startMs: leading.point.ms, hit: leading.point, edge: "start" };
  }
  if (trailing != null) {
    return {
      startMs: trailing.point.ms - lengthMs,
      hit: trailing.point,
      edge: "end",
    };
  }

  return { startMs, hit: null, edge: null };
}
