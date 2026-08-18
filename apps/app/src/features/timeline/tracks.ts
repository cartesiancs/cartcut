/**
 * The track registry: the thing this codebase never had.
 *
 * A row used to be the enumeration index of an element within the
 * priority-sorted timeline — a loop counter, not stored state — so one element
 * always occupied exactly one row. Splitting a clip therefore *had* to invent a
 * new row, and forty caption lines produced forty of them.
 *
 * Now a track is a real object and `trackId` says which one a clip belongs to.
 * Many clips share a track; the row is a property of the track, not of the
 * clip.
 *
 * Z-order is derived from track order rather than stored per element:
 * **index 0 is the topmost row and the front-most layer**, matching Premiere
 * and Final Cut. `derivePriorities` writes that ordering back into the legacy
 * `priority` field so the compositor, the preview and both FFmpeg export paths
 * keep working untouched while the UI migrates.
 */

import type { Timeline, TimelineElement } from "../../@types/timeline";

export type TrackKind = "video" | "audio" | "text";

export type TimelineTrack = {
  id: string;
  kind: TrackKind;
  /** Display name, e.g. "V1". Derived by `nameTracks`, not authored. */
  name: string;
  /** 0 is the top row and the front of the composite. */
  index: number;
};

export type TimelineDocument = {
  schemaVersion: 2;
  tracks: TimelineTrack[];
  elements: Timeline;
};

export const SCHEMA_VERSION = 2 as const;

const KIND_PREFIX: Record<TrackKind, string> = {
  video: "V",
  audio: "A",
  text: "T",
};

/** Which kind of track a newly added element belongs on. */
export function defaultTrackKindFor(filetype: string): TrackKind {
  if (filetype === "audio") {
    return "audio";
  }
  if (filetype === "text") {
    return "text";
  }
  // Images, GIFs and shapes are visual overlays and live on video tracks, as
  // they do in every NLE.
  return "video";
}

export function emptyDocument(): TimelineDocument {
  return { schemaVersion: SCHEMA_VERSION, tracks: [], elements: {} };
}

export function createTrack(
  id: string,
  kind: TrackKind,
  index: number,
): TimelineTrack {
  return { id, kind, name: `${KIND_PREFIX[kind]}1`, index };
}

/**
 * Close gaps in `index` and re-sort, so indices are always `0..n-1` with no
 * holes. Every mutation ends here, which is what lets layout treat the index
 * as a row number directly.
 */
export function normalizeTrackIndices(
  tracks: TimelineTrack[],
): TimelineTrack[] {
  return [...tracks]
    .sort((a, b) => a.index - b.index)
    .map((track, index) => ({ ...track, index }));
}

/**
 * Number tracks within their kind from the bottom up, so the visual stack reads
 * V1, V2, V3 upward — the convention every editor uses, and the reason the
 * highest-numbered video track is the front-most.
 */
export function nameTracks(tracks: TimelineTrack[]): TimelineTrack[] {
  const ordered = normalizeTrackIndices(tracks);
  const counters: Record<string, number> = {};

  // Walk bottom to top so the lowest row of each kind gets number 1.
  for (let i = ordered.length - 1; i >= 0; i--) {
    const track = ordered[i];
    const next = (counters[track.kind] ?? 0) + 1;
    counters[track.kind] = next;
    ordered[i] = { ...track, name: `${KIND_PREFIX[track.kind]}${next}` };
  }

  return ordered;
}

export function trackById(
  doc: TimelineDocument,
  trackId: string,
): TimelineTrack | null {
  return doc.tracks.find((track) => track.id === trackId) ?? null;
}

export function trackIndexOf(doc: TimelineDocument, trackId: string): number {
  return trackById(doc, trackId)?.index ?? Number.MAX_SAFE_INTEGER;
}

export function tracksOfKind(
  doc: TimelineDocument,
  kind: TrackKind,
): TimelineTrack[] {
  return doc.tracks.filter((track) => track.kind === kind);
}

/**
 * Every clip on one track, ordered by time.
 *
 * Ties break on element id so the order is deterministic — a track is not
 * supposed to hold overlapping clips, but ordering must not become
 * hash-dependent if one slips through.
 */
export function clipsOnTrack(
  doc: TimelineDocument,
  trackId: string,
): Array<[string, TimelineElement]> {
  return Object.entries(doc.elements)
    .filter(([, element]) => element.trackId === trackId)
    .sort(
      ([idA, a], [idB, b]) =>
        a.startTime - b.startTime || idA.localeCompare(idB),
    );
}

/**
 * Element ids back to front — the order the compositor should paint in.
 *
 * The bottom row paints first and the top row paints last, so the top row ends
 * up in front. Elements whose track has gone missing sort to the very back
 * rather than disappearing.
 */
export function paintOrder(doc: TimelineDocument): string[] {
  return Object.entries(doc.elements)
    .sort(([idA, a], [idB, b]) => {
      const indexA = trackIndexOf(doc, a.trackId);
      const indexB = trackIndexOf(doc, b.trackId);
      // Descending index: the highest index is the bottom row, painted first.
      return (
        indexB - indexA ||
        a.startTime - b.startTime ||
        idA.localeCompare(idB)
      );
    })
    .map(([id]) => id);
}

/**
 * Write the derived paint rank back into `priority`.
 *
 * `priority` is no longer authored — it exists so that everything still reading
 * it (`renderer/timeline.ts`, `export/renderTimeline.ts`, `ControlRender`,
 * `elementControlAsset`'s `z-index`, `renderMain`'s insertion order) keeps
 * producing identical output while the UI moves onto tracks. It is removed in
 * the final cleanup phase.
 */
export function derivePriorities(doc: TimelineDocument): Timeline {
  const order = paintOrder(doc);
  const next: Timeline = {};

  // Insertion order matters: `renderMain` iterates with `for..in` and relies on
  // it for overlay stacking.
  order.forEach((elementId, rank) => {
    next[elementId] = { ...doc.elements[elementId], priority: rank + 1 };
  });

  return next;
}

/** Re-derives indices, names and priorities. Every mutation below ends here. */
export function normalizeDocument(doc: TimelineDocument): TimelineDocument {
  const tracks = nameTracks(doc.tracks);
  const withTracks: TimelineDocument = { ...doc, tracks };
  return { ...withTracks, elements: derivePriorities(withTracks) };
}

export function insertTrackAt(
  doc: TimelineDocument,
  index: number,
  kind: TrackKind,
  id: string,
): TimelineDocument {
  const clampedIndex = Math.max(0, Math.min(index, doc.tracks.length));

  // Shift everything at or below the insertion point down one row.
  const shifted = doc.tracks.map((track) =>
    track.index >= clampedIndex ? { ...track, index: track.index + 1 } : track,
  );

  return normalizeDocument({
    ...doc,
    tracks: [...shifted, createTrack(id, kind, clampedIndex)],
  });
}

/** Appends a track of `kind` directly below the last track of that kind. */
export function appendTrackOfKind(
  doc: TimelineDocument,
  kind: TrackKind,
  id: string,
): TimelineDocument {
  const sameKind = tracksOfKind(doc, kind);
  const index =
    sameKind.length > 0
      ? Math.min(...sameKind.map((track) => track.index))
      : doc.tracks.length;

  return insertTrackAt(doc, index, kind, id);
}

/**
 * Remove a track.
 *
 * `"reject-if-nonempty"` is the default for user-facing deletion: silently
 * dropping a track's clips is not something a keystroke should be able to do.
 */
export function removeTrack(
  doc: TimelineDocument,
  trackId: string,
  mode: "delete-clips" | "reject-if-nonempty" = "reject-if-nonempty",
): TimelineDocument {
  if (trackById(doc, trackId) == null) {
    return doc;
  }

  const clips = clipsOnTrack(doc, trackId);
  if (clips.length > 0 && mode === "reject-if-nonempty") {
    return doc;
  }

  const elements: Timeline = {};
  for (const [id, element] of Object.entries(doc.elements)) {
    if (element.trackId !== trackId) {
      elements[id] = element;
    }
  }

  return normalizeDocument({
    ...doc,
    tracks: doc.tracks.filter((track) => track.id !== trackId),
    elements,
  });
}

/** Move a track to a new row, sliding the rows between it and its target. */
export function moveTrack(
  doc: TimelineDocument,
  trackId: string,
  toIndex: number,
): TimelineDocument {
  const track = trackById(doc, trackId);
  if (track == null) {
    return doc;
  }

  const ordered = normalizeTrackIndices(doc.tracks);
  const from = ordered.findIndex((candidate) => candidate.id === trackId);
  const to = Math.max(0, Math.min(toIndex, ordered.length - 1));
  if (from === to) {
    return doc;
  }

  const reordered = [...ordered];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);

  // Renumber from array position: normalization sorts on `index`, so leaving
  // the old indices in place would simply undo the splice.
  return normalizeDocument({
    ...doc,
    tracks: reordered.map((track, index) => ({ ...track, index })),
  });
}
