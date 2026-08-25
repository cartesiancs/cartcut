/**
 * Run a pure transform, record one undo step, and report what moved.
 *
 * This is the single seam every mutating command goes through, and it is what
 * makes an AI edit undoable with one Cmd+Z: the agent's edit takes the same
 * `withCheckpoint(pureOp)` path the user's own mouse takes, so it inherits the
 * track model's guarantees rather than restating them.
 *
 * It lived in `commands/edit.ts` while cutting was the only family of edits.
 * Moving it here is not tidying — the probe-before-baseline order below is a
 * contract, and a second command file that re-implemented `commit` by hand
 * would almost certainly get that order wrong and start leaving history entries
 * behind for edits that never happened.
 *
 * The diff is computed here rather than by the ops because `withCheckpoint`
 * deliberately tells its caller nothing: it signals "declined" by identity and
 * otherwise just swaps the document. An agent needs more than that — it has to
 * know which ids exist now — but it must not be handed the whole timeline to
 * find out, so the answer is a list of ids plus rows for what was created.
 */

import { useTimelineStore } from "../../states/timelineStore";
import type { TimelineDocument } from "../timeline/tracks";
import { ensureUndoBaseline } from "./checkpoint";
import { clipRow } from "./serialize";

export type EditResult = {
  ok: boolean;
  reason?: string;
  created: string[];
  removed: string[];
  changed: string[];
  /**
   * Present only when the track list itself changed.
   *
   * Track ops otherwise report an all-empty element diff and read to an agent
   * as "nothing happened" — which is the one thing `commit`'s return value
   * exists to disambiguate.
   */
  tracks?: { added: string[]; removed: string[]; order: string[] };
  clips?: unknown[];
};

export function commit(
  fn: (doc: TimelineDocument) => TimelineDocument,
  declineReason: string,
): EditResult {
  const before = useTimelineStore.getState().getDocument();

  // Probe before committing anything. `withCheckpoint` would tell us the same
  // thing by identity, but `ensureUndoBaseline` has to run *first* to be any
  // use — and recording a baseline for an edit that then declines would leave
  // a history entry behind for an edit that never happened, breaking the rule
  // that a declined edit costs the user nothing. The ops are pure, so asking
  // twice is safe; the ids minted by the discarded run are simply not used.
  if (fn(before) === before) {
    return declined(declineReason);
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

  const result: EditResult = {
    ok: true,
    created,
    removed,
    changed,
    clips: created.map((id) =>
      clipRow(id, after.elements[id], names.get(after.elements[id].trackId)),
    ),
  };

  const trackDiff = diffTracks(before, after);
  if (trackDiff != null) {
    result.tracks = trackDiff;
  }

  return result;
}

/** What `commit` returns for an edit that turned out to be a no-op. */
export function declined(reason: string): EditResult {
  return { ok: false, reason, created: [], removed: [], changed: [] };
}

/**
 * Track ids added and removed, plus the resulting top-to-bottom order.
 *
 * `null` when nothing about the track list moved — including a reorder, which
 * changes no ids but does change `order`, and which is the whole point of
 * `move_track`. Index 0 is the top row and the front-most layer.
 */
function diffTracks(
  before: TimelineDocument,
  after: TimelineDocument,
): EditResult["tracks"] | null {
  const wasOrder = [...before.tracks]
    .sort((a, b) => a.index - b.index)
    .map((t) => t.id);
  const order = [...after.tracks]
    .sort((a, b) => a.index - b.index)
    .map((t) => t.id);

  const was = new Set(wasOrder);
  const now = new Set(order);
  const added = order.filter((id) => !was.has(id));
  const removed = wasOrder.filter((id) => !now.has(id));

  const reordered =
    wasOrder.length !== order.length ||
    wasOrder.some((id, index) => order[index] !== id);

  if (added.length === 0 && removed.length === 0 && !reordered) {
    return null;
  }

  return { added, removed, order };
}
