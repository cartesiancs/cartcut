/**
 * Cut-editing commands.
 *
 * Every one of these is a thin adapter: validate what the pure op cannot,
 * translate the agent's vocabulary into the op's, and hand the result to
 * `withCheckpoint`. That is deliberate — routing agent edits through the same
 * `withCheckpoint(pureOp)` path the user's own mouse takes is what makes an AI
 * edit undoable with a single Cmd+Z, and it means these commands inherit the
 * track model's guarantees rather than restating them.
 *
 * The agent speaks in absolute timeline milliseconds. The ops speak in deltas
 * for trims and moves. Converting here rather than exposing deltas is not
 * politeness: an agent that has just read `list_clips` knows where things are,
 * not how far they should travel, and asking it to subtract is asking it to be
 * wrong occasionally.
 *
 * Those absolute times are snapped to frames, exactly as the mouse's are. An
 * agent asking for 1988ms is not asking for something the timeline can express
 * — nothing renders between frames — and letting it through would mean the one
 * path that bypasses the grid is the automated one, quietly reintroducing the
 * off-grid clips the rest of the feature exists to eliminate.
 */

import { v4 as uuidv4 } from "uuid";
import {
  deleteClips,
  moveClips,
  pasteClips,
  removeRanges,
  rippleDelete,
  splitClip,
  trimClipEnd,
  trimClipStart,
  type TimeRange,
} from "../../timeline/clipOps";
import { spanOf } from "../../timeline/geometry";
import { withDescendants } from "../../timeline/hierarchy";
import { MAX_SPEED, MIN_SPEED, setClipSpeed } from "../../timeline/speedOps";
import { trackById } from "../../timeline/tracks";
import type { TimelineElement } from "../../../@types/timeline";
import { commit, declined } from "../commit";
import { currentDoc, onFrame, requireElement } from "../context";
import { registerCommands } from "../registry";

registerCommands({
  split_clip: (params: { elementId: string; atMs: number[] }) => {
    const doc = currentDoc();
    requireElement(doc, params.elementId);

    // Snapped before deduplicating: two requested times inside the same frame
    // are one cut, and `splitClip` would decline the second anyway.
    const cuts = [...new Set((params.atMs ?? []).map(onFrame))].sort(
      (a, b) => b - a,
    );
    if (cuts.length === 0) {
      throw new Error("split_clip needs at least one time in `atMs`.");
    }

    return commit(
      (d) => {
        let next = d;
        // Descending, so each cut lands in coordinates the earlier cuts have
        // not disturbed — and the left half always keeps the id we know.
        for (const at of cuts) {
          next = splitClip(next, params.elementId, at, uuidv4());
        }
        return next;
      },
      "None of those times fall strictly inside the clip, so there was nothing to cut.",
    );
  },

  remove_ranges: (params: {
    elementId: string;
    ranges: TimeRange[];
    ripple?: boolean;
  }) => {
    const doc = currentDoc();
    const element = requireElement(doc, params.elementId);
    const span = spanOf(element);
    const ripple = params.ripple !== false;

    // The edges these ranges leave behind are clip edges like any other.
    const ranges = (params.ranges ?? []).map((range) => ({
      startMs: onFrame(range.startMs),
      endMs: onFrame(range.endMs),
    }));

    const result = commit(
      (d) => removeRanges(d, params.elementId, ranges, ripple, uuidv4),
      `None of those ranges overlap the clip, which spans ${Math.round(span.start)}–${Math.round(span.end)}ms.`,
    );

    return { ...result, ripple };
  },

  trim_clip: (params: {
    elementId: string;
    startMs?: number;
    endMs?: number;
  }) => {
    const doc = currentDoc();
    const element = requireElement(doc, params.elementId);
    const span = spanOf(element);

    if (params.startMs == null && params.endMs == null) {
      throw new Error("trim_clip needs `startMs`, `endMs`, or both.");
    }

    // Deltas are measured against the clip as it stands now. Both edges are
    // applied in one transform so a two-sided trim is one undo step; the end
    // delta is computed first because trimming the start moves the end.
    const startDelta =
      params.startMs != null ? onFrame(params.startMs) - span.start : 0;
    const endDelta = params.endMs != null ? onFrame(params.endMs) - span.end : 0;

    return commit(
      (d) => {
        let next = d;
        if (endDelta !== 0) {
          next = trimClipEnd(next, params.elementId, endDelta);
        }
        if (startDelta !== 0) {
          next = trimClipStart(next, params.elementId, startDelta);
        }
        return next;
      },
      "The clip is already at those bounds, or the trim was blocked by a neighbouring clip.",
    );
  },

  move_clips: (params: {
    elementIds: string[];
    toMs?: number;
    deltaMs?: number;
    trackId?: string;
  }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("move_clips needs at least one id in `elementIds`.");
    }
    for (const id of ids) {
      requireElement(doc, id);
    }

    if (params.toMs == null && params.deltaMs == null && params.trackId == null) {
      throw new Error("move_clips needs `toMs`, `deltaMs`, or a different `trackId`.");
    }

    // `toMs` places the *earliest* clip of the selection and carries the rest
    // along, so a multi-clip move keeps the shape the agent read. Either way it
    // is that anchor that lands on a frame; the others keep their offsets.
    const anchor = Math.min(...ids.map((id) => spanOf(doc.elements[id]).start));
    const requested =
      params.toMs != null ? params.toMs : anchor + (params.deltaMs ?? 0);
    const deltaMs =
      params.toMs != null || params.deltaMs != null
        ? onFrame(Math.max(0, requested)) - anchor
        : 0;

    let deltaTrackIndex = 0;
    if (params.trackId != null) {
      const destination = trackById(doc, params.trackId);
      if (destination == null) {
        throw new Error(
          `No track with id "${params.trackId}". Use get_project_overview to see tracks.`,
        );
      }
      const from = trackById(doc, doc.elements[ids[0]].trackId);
      deltaTrackIndex = destination.index - (from?.index ?? 0);
    }

    if (deltaMs === 0 && deltaTrackIndex === 0) {
      // Reported rather than thrown: the parameters were well formed, the move
      // just rounded to nothing. `moveClips` builds a fresh document even for a
      // zero delta, so without this an undo step would be recorded for an edit
      // that changed nothing.
      return declined(
        "That move is smaller than one frame, so the clips are already there.",
      );
    }

    return commit(
      (d) => moveClips(d, ids, deltaMs, deltaTrackIndex),
      "That destination is occupied or out of bounds. Moves are atomic: if one clip cannot land, none move.",
    );
  },

  delete_clips: (params: { elementIds: string[]; ripple?: boolean }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("delete_clips needs at least one id in `elementIds`.");
    }
    for (const id of ids) {
      requireElement(doc, id);
    }

    const ripple = params.ripple === true;

    return commit(
      (d) => {
        if (!ripple) {
          return deleteClips(d, ids);
        }
        // Ripple one at a time and from the end, so each gap closes against a
        // timeline the later deletions have already finished with.
        const ordered = [...ids].sort(
          (a, b) => spanOf(d.elements[b]).start - spanOf(d.elements[a]).start,
        );
        let next = d;
        for (const id of ordered) {
          next = rippleDelete(next, id);
        }
        return next;
      },
      "Those clips are already gone.",
    );
  },

  duplicate_clips: (params: {
    elementIds: string[];
    toMs?: number;
    deltaMs?: number;
    repeat?: number;
  }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("duplicate_clips needs at least one id in `elementIds`.");
    }
    for (const id of ids) {
      requireElement(doc, id);
    }

    // A group's children come along whether or not the caller listed them.
    // `pasteClips` remaps `parentId` across a paste, so the copies re-parent to
    // the *copied* group — but only for clips that are in the same paste. Leave
    // a child behind and it stays bound to the original group.
    const withChildren = withDescendants(doc.elements, ids);
    const picked: Record<string, TimelineElement> = {};
    for (const id of withChildren) {
      picked[id] = doc.elements[id];
    }

    const spans = withChildren.map((id) => spanOf(doc.elements[id]));
    const selectionStart = Math.min(...spans.map((s) => s.start));
    const selectionEnd = Math.max(...spans.map((s) => s.end));
    const selectionLength = selectionEnd - selectionStart;

    const repeat = Math.max(1, Math.min(50, Math.floor(params.repeat ?? 1)));
    // Default: butt the first copy up against the end of what was copied, which
    // is what "duplicate this" means when no destination is given.
    const first = params.toMs != null ? Math.max(0, params.toMs) : selectionEnd;
    const step = params.deltaMs ?? selectionLength;

    return commit((d) => {
      let next = d;
      for (let index = 0; index < repeat; index++) {
        next = pasteClips(next, picked, onFrame(first + step * index), uuidv4);
      }
      return next;
    }, "There was no room to place the copies.");
  },

  set_clip_speed: (params: {
    elementIds: string[];
    speed: number;
    ripple?: boolean;
  }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_clip_speed needs at least one id in `elementIds`.");
    }

    const wrongType = ids
      .map((id) => requireElement(doc, id))
      .filter((element) => element.filetype !== "video" && element.filetype !== "audio");

    if (wrongType.length > 0) {
      throw new Error(
        `Only video and audio clips have a playback speed; got ${wrongType
          .map((element) => element.filetype)
          .join(", ")}.`,
      );
    }

    if (
      typeof params.speed !== "number" ||
      params.speed < MIN_SPEED ||
      params.speed > MAX_SPEED
    ) {
      throw new Error(
        `speed must be between ${MIN_SPEED} and ${MAX_SPEED} (got ${params.speed}).`,
      );
    }

    const ripple = params.ripple !== false;

    return commit(
      (d) =>
        ids.reduce(
          (next, id) => setClipSpeed(next, id, params.speed, { ripple }),
          d,
        ),
      ripple
        ? "Those clips are already at that speed."
        : "Those clips are already at that speed, or the new length would overlap the next clip. Pass ripple:true to push it along.",
    );
  },
});
