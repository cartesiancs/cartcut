/**
 * Where a newly added element lands.
 *
 * Everything used to go to `startTime: 0` with `priority = max + 1`, which
 * meant a brand-new row every single time. Forty caption lines became forty
 * rows; adding a second clip never continued the first one's track.
 *
 * The rule now is: reuse a track of the right kind if the requested moment is
 * free on one, and only add a track when none of them can take it. Because
 * captions arrive with distinct, non-overlapping times, that single rule is
 * what collapses a whole transcript onto one text track.
 */

import type { TimelineElement } from "../../@types/timeline";
import { spanLength } from "./geometry";
import { findCollisions } from "./overlap";
import {
  appendTrackOfKind,
  defaultTrackKindFor,
  normalizeDocument,
  tracksOfKind,
  type TimelineDocument,
} from "./tracks";

/**
 * Pick a track for `element` at `startMs`, creating one if it has to.
 *
 * Tracks are tried bottom-up so the lowest row fills first, the way V1 does
 * before V2. Returns the chosen track id and the document that holds it —
 * which is a new document only when a track had to be added.
 */
export function chooseTrackFor(
  doc: TimelineDocument,
  element: TimelineElement,
  startMs: number,
  newTrackId: string,
): { doc: TimelineDocument; trackId: string } {
  const kind = defaultTrackKindFor(element.filetype);
  const span = { start: startMs, end: startMs + spanLength(element) };

  // Descending index == bottom row first.
  const candidates = [...tracksOfKind(doc, kind)].sort(
    (a, b) => b.index - a.index,
  );

  for (const track of candidates) {
    if (findCollisions(doc, track.id, span).length === 0) {
      return { doc, trackId: track.id };
    }
  }

  return {
    doc: appendTrackOfKind(doc, kind, newTrackId),
    trackId: newTrackId,
  };
}

/**
 * Add `element` to the document at `startMs`, on a suitable track.
 *
 * The element's own `startTime` is overwritten with `startMs`: callers decide
 * the moment — the playhead for an asset the user just added, the transcript's
 * own timing for a caption — and this decides only the row.
 */
export function placeNewElement(
  doc: TimelineDocument,
  elementId: string,
  element: TimelineElement,
  startMs: number,
  newTrackId: string,
): TimelineDocument {
  const start = Math.max(0, startMs);
  const placed = { ...element, startTime: start };
  const { doc: withTrack, trackId } = chooseTrackFor(
    doc,
    placed,
    start,
    newTrackId,
  );

  return normalizeDocument({
    ...withTrack,
    elements: {
      ...withTrack.elements,
      [elementId]: { ...placed, trackId },
    },
  });
}
