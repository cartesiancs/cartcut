/**
 * Making the agent's first edit undoable.
 *
 * `withCheckpoint` records the state *after* each edit, and `historyNow` starts
 * at -1, so after one edit there is exactly one entry and `historyNow` is 0.
 * Undo asks for entry -1, finds nothing, and declines. The consequence is that
 * **the first edit made after a project is loaded cannot be undone** — nothing
 * calls `checkPointTimeline` on load, so the opening state was never recorded.
 *
 * That is a pre-existing limitation of the store rather than something the
 * agent introduced, but the agent is where it hurts most: "open a project, ask
 * for a cut, dislike it, press Cmd+Z" is the first thing anyone will try, and
 * an AI edit that cannot be taken back is worse than no AI edit.
 *
 * Rather than change `withCheckpoint` for the whole app — three existing tests
 * pin its current behaviour, and the user's own first edit is a separate
 * decision — every mutating command records the pre-edit state first, but only
 * when the history is genuinely empty. After that the normal mechanism carries
 * on unchanged, and the baseline costs one entry of a fifty-entry cap.
 */

import { useTimelineStore } from "../../states/timelineStore";

export function ensureUndoBaseline() {
  const state = useTimelineStore.getState();
  if (state.history.timelineHistory.length === 0) {
    state.checkPointTimeline();
  }
}
