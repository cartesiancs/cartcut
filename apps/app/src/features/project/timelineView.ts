/**
 * The `.ngt` entry that keeps how the timeline is laid out: the height of every
 * row someone has resized, and the notes pinned to the rows
 * (`features/note/notes.ts`). Either key is left out when it has nothing in it.
 *
 * Not part of `TimelineDocument`, for the reason `trackHeights.ts` gives: it is
 * view state, so it stays out of the undo history. It is saved with the project
 * and it makes the project dirty, exactly like `extensions.json`, whose shape
 * this copies. An added entry never moves `SCHEMA_VERSION`; the archive reader
 * asks for its five entries by name, so a build without this one opens the file
 * with every row at the default.
 *
 * `null` from the serializer means "write no entry at all", and that is what a
 * project with every row at the default and no notes produces, so it stays
 * byte-identical to one saved before rows could be resized.
 *
 * Parsing fails closed, the way every read guard here does: a truncated or
 * hand-edited entry costs the user their row heights, never the project.
 */

import {
  DEFAULT_TRACK_HEIGHT,
  coerceTrackHeight,
  heightsFor,
  type TrackHeights,
} from "../timeline/trackHeights";
import { parseNotes, savedNotes, type TimelineNote } from "../note/notes";

export const TIMELINE_VIEW_ENTRY = "timelineView.json";

/** Bumped only if the envelope changes shape. */
export const TIMELINE_VIEW_ENTRY_VERSION = 1;

/**
 * The entry's text, or `null` when there is nothing to write.
 *
 * Only rows in `trackIds` are written, and keys are sorted, so the same heights
 * always produce the same bytes: `projectDigest.ts` hashes this text, and an
 * order that followed insertion would make an unchanged project read as edited.
 * Notes keep the order they were made in, each rebuilt with its keys in one
 * order for the same reason.
 */
export function serializeTimelineViewEntry(
  heights: TrackHeights,
  trackIds: Iterable<string>,
  notes: readonly TimelineNote[] = [],
): string | null {
  const ids = [...trackIds];
  const saved = heightsFor(heights, ids);
  const kept = savedNotes(notes, ids);
  const hasHeights = Object.keys(saved).length > 0;
  if (!hasHeights && kept.length === 0) {
    return null;
  }
  return JSON.stringify({
    v: TIMELINE_VIEW_ENTRY_VERSION,
    ...(hasHeights ? { trackHeights: saved } : {}),
    ...(kept.length > 0
      ? {
          notes: kept.map(({ id, trackId, atMs, text }) => ({
            id,
            trackId,
            atMs,
            text,
          })),
        }
      : {}),
  });
}

/**
 * The heights an entry describes, for the tracks the project actually has.
 *
 * Each value is coerced into range rather than dropped, so a file written by a
 * build with a wider range still opens near the height it was left at. A value
 * that is not a number, a row at the default, and an id no track has are all
 * left out.
 */
export function parseTimelineViewEntry(
  text: string | null | undefined,
  trackIds: Iterable<string>,
): TrackHeights {
  const stored = readEnvelope(text)?.trackHeights;
  if (stored == null || typeof stored !== "object" || Array.isArray(stored)) {
    return {};
  }

  const known = new Set(trackIds);
  const entries: [string, number][] = [];
  for (const [id, value] of Object.entries(stored)) {
    if (!known.has(id) || typeof value !== "number") {
      continue;
    }
    const px = coerceTrackHeight(value);
    if (px !== DEFAULT_TRACK_HEIGHT) {
      entries.push([id, px]);
    }
  }
  return heightsFor(Object.fromEntries(entries), known);
}

/** The notes an entry holds, for the tracks the project actually has. */
export function parseTimelineViewNotes(
  text: string | null | undefined,
  trackIds: Iterable<string>,
): TimelineNote[] {
  return parseNotes(readEnvelope(text)?.notes, trackIds);
}

/** A version 1 envelope, or `null` for anything else. */
function readEnvelope(
  text: string | null | undefined,
): { trackHeights?: unknown; notes?: unknown } | null {
  if (typeof text !== "string" || text.trim() === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const envelope = parsed as { v?: unknown; trackHeights?: unknown; notes?: unknown };
  return envelope.v === TIMELINE_VIEW_ENTRY_VERSION ? envelope : null;
}
