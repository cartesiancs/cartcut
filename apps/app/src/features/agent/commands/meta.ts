/**
 * Commands that move the editor rather than the document.
 *
 * Undo is exposed deliberately. Every other command routes through
 * `withCheckpoint`, so an agent that overshoots can take its own edit back
 * instead of trying to reconstruct the previous state by hand — which it would
 * do imperfectly, and which is how an agent turns one bad edit into three.
 */

import { useTimelineStore } from "../../../states/timelineStore";
import { documentDuration } from "../serialize";
import { registerCommands } from "../registry";

function historyDepths() {
  const { history } = useTimelineStore.getState();
  return {
    undoDepth: history.historyNow + 1,
    redoDepth: history.timelineHistory.length - history.historyNow - 1,
  };
}

registerCommands({
  set_playhead: (params: { atMs: number }) => {
    if (typeof params.atMs !== "number" || !Number.isFinite(params.atMs)) {
      throw new Error("set_playhead needs a numeric `atMs`.");
    }

    const state = useTimelineStore.getState();
    const duration = documentDuration(state.getDocument());
    const at = Math.max(0, Math.round(params.atMs));

    // No explicit repaint: `previewCanvas` and the timeline canvas both
    // subscribe to this store, and `setCursor` is a `set`.
    state.setCursor(at);

    return { playheadMs: at, timelineDurationMs: duration };
  },

  undo: () => {
    const before = historyDepths();
    if (before.undoDepth <= 0) {
      return { ok: false, reason: "Nothing to undo.", ...before };
    }

    useTimelineStore.getState().rollbackTimelineFromCheckPoint(-1);

    return { ok: true, ...historyDepths() };
  },

  redo: () => {
    const before = historyDepths();
    if (before.redoDepth <= 0) {
      return { ok: false, reason: "Nothing to redo.", ...before };
    }

    useTimelineStore.getState().rollbackTimelineFromCheckPoint(1);

    return { ok: true, ...historyDepths() };
  },

  select_clips: (params: { elementIds: string[] }) => {
    const ids = params.elementIds ?? [];
    const doc = useTimelineStore.getState().getDocument();
    const known = ids.filter((id) => doc.elements[id] != null);

    // Selection lives on the timeline canvas component rather than in a store,
    // so this is a DOM reach — the same one cross-component calls make
    // everywhere else in this codebase. Worth doing anyway: after an edit the
    // user needs to see *which* clips the agent touched, and a redraw has to
    // be asked for because `targetId` is a plain property, not store state.
    const timelineCanvas: any = document.querySelector(
      "element-timeline-canvas",
    );

    if (timelineCanvas == null) {
      return { ok: false, reason: "The timeline canvas is not mounted." };
    }

    timelineCanvas.targetId = known;
    timelineCanvas.drawCanvas?.();

    return { ok: true, selected: known };
  },
});
