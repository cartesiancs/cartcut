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
  let best: SnapResult = { startMs, hit: null, edge: null };
  let bestScore = Infinity;

  for (const point of points) {
    for (const edge of ["start", "end"] as const) {
      const edgeMs = edge === "start" ? startMs : startMs + lengthMs;
      const distancePx = Math.abs(
        msToPxSigned(point.ms - edgeMs, range),
      );

      if (distancePx > tolerancePx) {
        continue;
      }

      // A same-track point wins any tie; the nudge keeps it from beating a
      // point that is genuinely closer.
      const score =
        preferTrackId != null && point.trackId === preferTrackId
          ? distancePx - 0.001
          : distancePx;

      if (score < bestScore) {
        bestScore = score;
        best = {
          startMs: edge === "start" ? point.ms : point.ms - lengthMs,
          hit: point,
          edge,
        };
      }
    }
  }

  return best;
}
