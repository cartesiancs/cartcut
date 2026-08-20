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
 */

import { v4 as uuidv4 } from "uuid";
import { useTimelineStore } from "../../../states/timelineStore";
import {
  deleteClips,
  moveClips,
  removeRanges,
  rippleDelete,
  splitClip,
  trimClipEnd,
  trimClipStart,
  type TimeRange,
} from "../../timeline/clipOps";
import { spanOf } from "../../timeline/geometry";
import { trackById, type TimelineDocument } from "../../timeline/tracks";
import { ensureUndoBaseline } from "../checkpoint";
import { registerCommands } from "../registry";
import { clipRow } from "../serialize";

type EditResult = {
  ok: boolean;
  reason?: string;
  created: string[];
  removed: string[];
  changed: string[];
  clips?: unknown[];
};

/**
 * Run a pure transform, record one undo step, and report what moved.
 *
 * The diff is computed here rather than by the ops because `withCheckpoint`
 * deliberately tells its caller nothing: it signals "declined" by identity and
 * otherwise just swaps the document. An agent needs more than that — it has to
 * know which ids exist now — but it must not be handed the whole timeline to
 * find out, so the answer is a list of ids plus rows for what was created.
 */
function commit(
  fn: (doc: TimelineDocument) => TimelineDocument,
  declineReason: string,
): EditResult {
  const store = useTimelineStore.getState();
  const before = store.getDocument();

  // Probe before committing anything. `withCheckpoint` would tell us the same
  // thing by identity, but `ensureUndoBaseline` has to run *first* to be any
  // use — and recording a baseline for an edit that then declines would leave
  // a history entry behind for an edit that never happened, breaking the rule
  // that a declined edit costs the user nothing. The ops are pure, so asking
  // twice is safe; the ids minted by the discarded run are simply not used.
  if (fn(before) === before) {
    return {
      ok: false,
      reason: declineReason,
      created: [],
      removed: [],
      changed: [],
    };
  }

  ensureUndoBaseline();
  useTimelineStore.getState().withCheckpoint(fn);

  const after = useTimelineStore.getState().getDocument();

  const created: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const id of Object.keys(after.elements)) {
    if (before.elements[id] == null) {
      created.push(id);
    } else if (before.elements[id] !== after.elements[id]) {
      changed.push(id);
    }
  }
  for (const id of Object.keys(before.elements)) {
    if (after.elements[id] == null) {
      removed.push(id);
    }
  }

  const names = new Map(after.tracks.map((t) => [t.id, t.name]));

  return {
    ok: true,
    created,
    removed,
    changed,
    clips: created.map((id) =>
      clipRow(id, after.elements[id], names.get(after.elements[id].trackId)),
    ),
  };
}

function requireElement(doc: TimelineDocument, elementId: string) {
  const element = doc.elements[elementId];
  if (element == null) {
    throw new Error(
      `No clip with id "${elementId}". Use list_clips to see current ids.`,
    );
  }
  return element;
}

function currentDoc(): TimelineDocument {
  return useTimelineStore.getState().getDocument();
}

registerCommands({
  split_clip: (params: { elementId: string; atMs: number[] }) => {
    const doc = currentDoc();
    requireElement(doc, params.elementId);

    const cuts = [...new Set(params.atMs ?? [])].sort((a, b) => b - a);
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

    const result = commit(
      (d) => removeRanges(d, params.elementId, params.ranges ?? [], ripple, uuidv4),
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
      params.startMs != null ? params.startMs - span.start : 0;
    const endDelta = params.endMs != null ? params.endMs - span.end : 0;

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

    let deltaMs = params.deltaMs ?? 0;
    if (params.toMs != null) {
      // `toMs` places the *earliest* clip of the selection and carries the
      // rest along, so a multi-clip move keeps the shape the agent read.
      const anchor = Math.min(...ids.map((id) => spanOf(doc.elements[id]).start));
      deltaMs = params.toMs - anchor;
    }

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
      throw new Error("move_clips needs `toMs`, `deltaMs`, or a different `trackId`.");
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
});
