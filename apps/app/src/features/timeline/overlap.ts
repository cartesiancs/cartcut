/**
 * Occupancy arithmetic for a single track.
 *
 * A track holds clips that never overlap in time. That invariant is what makes
 * "many clips on one row" legible: the row reads left to right as a sequence,
 * and z-order within a track never has to be decided.
 *
 * Intervals are half-open, `[start, end)`, matching `utils/time.isTimeInRange`.
 * Back-to-back clips therefore meet without colliding, which is exactly what a
 * split produces and what re-joining two halves has to preserve.
 */

import { spanOf } from "./geometry";
import { clipsOnTrack, type TimelineDocument } from "./tracks";

export type Interval = { start: number; end: number };

export function overlaps(a: Interval, b: Interval): boolean {
  // A half-open interval of zero width contains no instant, so it cannot
  // collide with anything — the same reason `isTimeInRange(5, 5, 5)` is false.
  if (a.end <= a.start || b.end <= b.start) {
    return false;
  }
  return a.start < b.end && b.start < a.end;
}

/** Every occupied stretch of a track, in order, excluding the given ids. */
export function occupiedIntervals(
  doc: TimelineDocument,
  trackId: string,
  excludeIds: string[] = [],
): Interval[] {
  const excluded = new Set(excludeIds);
  return clipsOnTrack(doc, trackId)
    .filter(([id]) => !excluded.has(id))
    .map(([, element]) => {
      const { start, end } = spanOf(element);
      return { start, end };
    });
}

/** Ids on `trackId` that `span` would collide with. */
export function findCollisions(
  doc: TimelineDocument,
  trackId: string,
  span: Interval,
  excludeIds: string[] = [],
): string[] {
  const excluded = new Set(excludeIds);
  return clipsOnTrack(doc, trackId)
    .filter(([id]) => !excluded.has(id))
    .filter(([, element]) => {
      const { start, end } = spanOf(element);
      return overlaps(span, { start, end });
    })
    .map(([id]) => id);
}

/**
 * The empty stretches of a track, in order.
 *
 * The final gap runs to `Infinity` — a track has no right-hand end, and the
 * red project-duration marker is a render setting, not a boundary on placement.
 */
export function freeGaps(
  doc: TimelineDocument,
  trackId: string,
  excludeIds: string[] = [],
): Interval[] {
  const occupied = occupiedIntervals(doc, trackId, excludeIds);
  const gaps: Interval[] = [];
  let cursor = 0;

  for (const interval of occupied) {
    if (interval.start > cursor) {
      gaps.push({ start: cursor, end: interval.start });
    }
    cursor = Math.max(cursor, interval.end);
  }

  gaps.push({ start: cursor, end: Infinity });
  return gaps;
}

/**
 * The earliest start at or after `notBefore` where `length` fits.
 *
 * Used when placing something new: an added clip lands at the playhead if the
 * track is free there, and otherwise slides to the next opening rather than
 * being refused or silently stacked on top of what is already there.
 */
export function firstFreeStart(
  doc: TimelineDocument,
  trackId: string,
  notBefore: number,
  length: number,
  excludeIds: string[] = [],
): number | null {
  for (const gap of freeGaps(doc, trackId, excludeIds)) {
    const start = Math.max(gap.start, notBefore);
    if (start + length <= gap.end) {
      return start;
    }
  }
  return null;
}

/**
 * Resolve a drop: the nearest start to `desiredStart` that does not collide.
 *
 * Returns `desiredStart` unchanged when it already fits, snaps to a gap edge
 * when the drop is within `toleranceMs` of one, and returns `null` when there
 * is no room — the caller then reverts the drag rather than overwriting, which
 * keeps a mis-aimed drop from destroying footage.
 */
export function fitInto(
  doc: TimelineDocument,
  trackId: string,
  desiredStart: number,
  length: number,
  excludeIds: string[] = [],
  toleranceMs = 0,
): number | null {
  const desired: Interval = {
    start: desiredStart,
    end: desiredStart + length,
  };

  if (findCollisions(doc, trackId, desired, excludeIds).length === 0) {
    return desiredStart;
  }

  // Candidate positions are the gap edges: flush against a neighbour's end, or
  // flush against the next neighbour's start.
  let best: number | null = null;
  let bestDistance = Infinity;

  for (const gap of freeGaps(doc, trackId, excludeIds)) {
    if (gap.end - gap.start < length) {
      continue;
    }

    const candidates = [gap.start];
    if (Number.isFinite(gap.end)) {
      candidates.push(gap.end - length);
    }

    for (const candidate of candidates) {
      if (candidate < gap.start || candidate + length > gap.end) {
        continue;
      }
      const distance = Math.abs(candidate - desiredStart);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
  }

  if (best == null || bestDistance > toleranceMs) {
    return null;
  }
  return best;
}
