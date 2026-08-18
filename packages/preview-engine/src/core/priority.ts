/**
 * Z-order sorting by `priority`.
 *
 * Every renderer did `Object.entries(timeline).sort((a,b) => a.priority - b.priority)`
 * before compositing. Extracted here as pure helpers.
 */

import type { RenderTimeline } from "../model/timeline.types";

/** Ids sorted ascending by `priority` (lower priority drawn first / underneath). */
export function sortIdsByPriority(
  timeline: RenderTimeline,
  ids: string[] = Object.keys(timeline),
): string[] {
  return [...ids].sort(
    (a, b) =>
      (Number(timeline[a]?.priority) || 0) -
      (Number(timeline[b]?.priority) || 0),
  );
}

/** A new timeline object whose keys are ordered by ascending `priority`. */
export function sortTimelineByPriority(
  timeline: RenderTimeline,
): RenderTimeline {
  return Object.fromEntries(
    Object.entries(timeline).sort(
      ([, a], [, b]) =>
        (Number(a?.priority) || 0) - (Number(b?.priority) || 0),
    ),
  );
}
