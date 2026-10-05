/**
 * A note pinned to the timeline: a time on a row, and some text.
 *
 * Not part of `TimelineDocument`, for the reason a row's height is not: it is
 * never drawn into the picture, so it stays out of the undo history, the
 * export and the agent's view of the edit. It is saved with the project inside
 * `timelineView.json` and it makes the project dirty, exactly like the heights.
 *
 * Pinned to a time and a track rather than to a clip, so it stays where it was
 * put when the clips around it move. A note whose track is deleted is kept in
 * memory, so undoing the delete brings it back; the save path writes only notes
 * whose track exists.
 */

export type TimelineNote = {
  id: string;
  trackId: string;
  /** Timeline ms, absolute from the start of the project. */
  atMs: number;
  text: string;
};

/** Long enough for a paragraph; short enough that a pasted file is not a note. */
export const NOTE_TEXT_MAX = 2000;

export const NO_NOTES: readonly TimelineNote[] = Object.freeze([]);

export function coerceNoteText(text: string): string {
  return text.trim().slice(0, NOTE_TEXT_MAX);
}

/**
 * The notes worth writing to the file, in the order they were made.
 *
 * An empty note is the composer still open on a new pin, so it is left out:
 * opening one must not make the project dirty.
 */
export function savedNotes(
  notes: readonly TimelineNote[],
  trackIds: Iterable<string>,
): TimelineNote[] {
  const known = new Set(trackIds);
  return notes.filter((note) => known.has(note.trackId) && note.text !== "");
}

/**
 * The notes a stored value describes, for the tracks the project has.
 *
 * Fails closed one note at a time: a malformed note is dropped and the rest
 * survive, and anything that is not an array reads as no notes at all.
 */
export function parseNotes(
  raw: unknown,
  trackIds: Iterable<string>,
): TimelineNote[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const known = new Set(trackIds);
  const seen = new Set<string>();
  const notes: TimelineNote[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") {
      continue;
    }
    const { id, trackId, atMs, text } = item as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      id === "" ||
      seen.has(id) ||
      typeof trackId !== "string" ||
      !known.has(trackId) ||
      typeof atMs !== "number" ||
      !Number.isFinite(atMs) ||
      typeof text !== "string"
    ) {
      continue;
    }
    const kept = coerceNoteText(text);
    if (kept === "") {
      continue;
    }
    seen.add(id);
    notes.push({ id, trackId, atMs: Math.max(0, Math.round(atMs)), text: kept });
  }
  return notes;
}
