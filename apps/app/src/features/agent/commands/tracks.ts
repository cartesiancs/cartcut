/**
 * Track management, which is also layer-order management.
 *
 * These go through the pure ops and `commit()` rather than the store's own
 * `addTrack` / `removeTrackById` / `moveTrackTo`. Those three do call
 * `withCheckpoint`, but they skip `ensureUndoBaseline` — so the agent's first
 * edit after a project loads would not be undoable — and they return nothing,
 * so there would be no way to tell a caller what happened.
 */

import { v4 as uuidv4 } from "uuid";
import {
  appendTrackOfKind,
  clipsOnTrack,
  insertTrackAt,
  moveTrack,
  removeTrack,
  trackById,
  type TrackKind,
} from "../../timeline/tracks";
import { commit, declined } from "../commit";
import { currentDoc, requireTrack } from "../context";
import { registerCommands } from "../registry";
import { trackRow } from "../serialize";

/** Every track, top row first, as compact rows. */
function trackList() {
  const doc = currentDoc();
  return [...doc.tracks]
    .sort((a, b) => a.index - b.index)
    .map((track) => trackRow(track, clipsOnTrack(doc, track.id).length));
}

registerCommands({
  add_track: (params: { kind: TrackKind; index?: number }) => {
    if (params.kind == null) {
      throw new Error("add_track needs a `kind`: video, audio or text.");
    }

    const trackId = uuidv4();
    const result = commit(
      (d) =>
        params.index != null
          ? insertTrackAt(d, params.index, params.kind, trackId)
          : appendTrackOfKind(d, params.kind, trackId),
      "That track could not be added.",
    );

    return { ...result, trackId, allTracks: trackList() };
  },

  remove_track: (params: { trackId: string; deleteClips?: boolean }) => {
    const doc = currentDoc();
    const track = requireTrack(doc, params.trackId);
    const clips = clipsOnTrack(doc, params.trackId);
    const deleteClips = params.deleteClips === true;

    // Reported rather than left to `removeTrack`'s silent identity return: the
    // agent needs to know *why* nothing happened, and "3 clips" is the fact
    // that decides whether it should move them or pass the flag.
    if (!deleteClips && clips.length > 0) {
      return declined(
        `Track ${track.name} still holds ${clips.length} clip${clips.length === 1 ? "" : "s"}. ` +
          `Move them first with move_clips, or pass deleteClips:true to remove them with the track.`,
      );
    }

    const result = commit(
      (d) =>
        removeTrack(
          d,
          params.trackId,
          deleteClips ? "delete-clips" : "reject-if-nonempty",
        ),
      "That track could not be removed.",
    );

    return { ...result, allTracks: trackList() };
  },

  move_track: (params: { trackId: string; toIndex: number }) => {
    const doc = currentDoc();
    requireTrack(doc, params.trackId);

    if (typeof params.toIndex !== "number" || !Number.isFinite(params.toIndex)) {
      throw new Error("move_track needs a numeric `toIndex`.");
    }

    const result = commit(
      (d) => moveTrack(d, params.trackId, Math.max(0, Math.floor(params.toIndex))),
      "That track is already at that position.",
    );

    // The name is derived from kind and order, so it may well have changed —
    // worth handing back rather than leaving the agent with a stale "V2".
    const after = currentDoc();
    return {
      ...result,
      track: trackById(after, params.trackId)?.name,
      allTracks: trackList(),
    };
  },
});
