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
import { repairHierarchy } from "./hierarchy";
import { repairTransitions } from "./transitionRepair";

export type TrackKind = "video" | "audio" | "text" | "group" | "effect";

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
  group: "G",
  effect: "E",
};

/**
 * Where a kind belongs in the stack when the document holds none of it yet.
 *
 * Lower is nearer the front. This decides only the *first* row of a kind: once
 * one exists, `appendTrackOfKind` stacks on top of it, and the user is free to
 * drag rows anywhere afterwards. It exists because "append at the end" is right
 * for audio and wrong for text — a caption behind the picture is not a caption,
 * and a project has video rows and no text row before its first title, so the
 * end is exactly where a title must not go.
 */
const KIND_STACK_ORDER: Record<TrackKind, number> = {
  effect: 0, // an adjustment layer applies to everything painted beneath it
  text: 1, // titles and captions read over the picture, never under it
  video: 2,
  group: 3, // draws nothing: a row for the bar, not for the composite
  audio: 4, // carries no z-order, but the rows read below the picture
};

/** Which kind of track a newly added element belongs on. */
export function defaultTrackKindFor(filetype: string): TrackKind {
  if (filetype === "audio") {
    return "audio";
  }
  if (filetype === "text") {
    return "text";
  }
  // Groups get rows of their own so that a group bar never competes with a real
  // clip for a slot. Their row carries no z-order meaning — they draw nothing —
  // so where the rows land in the stack does not matter.
  if (filetype === "group") {
    return "group";
  }
  // An effect row's position in the stack is the whole point of it: an effect
  // applies to everything painted beneath it, so dragging its track up or down
  // is how the user chooses what it touches. Unlike a group row, this one
  // carries real z-order meaning.
  if (filetype === "effect") {
    return "effect";
  }
  // A transition never reaches this function. It is not placed by
  // `placeNewElement` — `transitionOps.addTransition` puts it on the track its
  // two clips already share, because a transition that sat anywhere else would
  // not be between them.
  //
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

/**
 * Re-derives indices, names, priorities, parent links and transitions. Every
 * mutation below ends here.
 *
 * Both repairs are imported lazily-shaped — as plain function calls, but from
 * modules that import nothing from here at runtime — to keep the cycles
 * `tracks -> hierarchy -> tracks` and `tracks -> transitionRepair -> tracks`
 * type-only. Each returns its input by identity when the feature it guards is
 * unused: no element carrying a `parentId`, no element being a transition. That
 * is the case for most projects, so the cost on the common path is two passes
 * over the element keys.
 *
 * `repairTransitions` running here is what makes transitions cost nothing
 * elsewhere. Deleting a clip, dragging one to another row, trimming one until a
 * gap opens — every op in `clipOps.ts` already funnels through this function,
 * so none of them needs to know transitions exist.
 */
export function normalizeDocument(doc: TimelineDocument): TimelineDocument {
  const tracks = nameTracks(doc.tracks);
  const withTracks: TimelineDocument = { ...doc, tracks };
  const repaired = repairTransitions(repairHierarchy(withTracks));
  return { ...repaired, elements: derivePriorities(repaired) };
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

/**
 * Appends a track of `kind` directly above the topmost track of that kind.
 *
 * With no row of that kind to stack on, `KIND_STACK_ORDER` decides instead: the
 * new row lands above the topmost row that belongs *behind* it. That is what
 * puts a project's first text track in front of the picture rather than at the
 * bottom of the stack, where it would be painted first and covered.
 */
export function appendTrackOfKind(
  doc: TimelineDocument,
  kind: TrackKind,
  id: string,
): TimelineDocument {
  const sameKind = tracksOfKind(doc, kind);
  if (sameKind.length > 0) {
    return insertTrackAt(
      doc,
      Math.min(...sameKind.map((track) => track.index)),
      kind,
      id,
    );
  }

  // Above the highest row ranked behind this kind, so anything ranked in front
  // stays in front and a row the user dragged to the top is never jumped over.
  const behind = doc.tracks.filter(
    (track) => KIND_STACK_ORDER[track.kind] > KIND_STACK_ORDER[kind],
  );
  const index =
    behind.length > 0
      ? Math.min(...behind.map((track) => track.index))
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
