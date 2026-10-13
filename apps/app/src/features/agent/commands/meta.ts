/**
 * Commands that move the editor rather than the document.
 *
 * Undo is exposed deliberately. Every other command routes through
 * `withCheckpoint`, so an agent that overshoots can take its own edit back
 * instead of trying to reconstruct the previous state by hand — which it would
 * do imperfectly, and which is how an agent turns one bad edit into three.
 */

import { isTimelineLocked } from "../../../states/timelineLockStore";
import { useTimelineStore } from "../../../states/timelineStore";
import { cancelActiveGestures } from "../../editor/gestureCancel";
import { LOCKED_REASON } from "../commit";
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

  // Refused while the caption session holds the timeline, as the editor's own
  // undo is: the session's writes record no history, so stepping back would
  // land on a state from before the session while the session went on
  // writing its projection over it.
  undo: () => {
    const before = historyDepths();
    if (isTimelineLocked()) {
      return { ok: false, reason: LOCKED_REASON, ...before };
    }
    if (before.undoDepth <= 0) {
      return { ok: false, reason: "Nothing to undo.", ...before };
    }

    cancelActiveGestures();
    useTimelineStore.getState().rollbackTimelineFromCheckPoint(-1);

    return { ok: true, ...historyDepths() };
  },

  redo: () => {
    const before = historyDepths();
    if (isTimelineLocked()) {
      return { ok: false, reason: LOCKED_REASON, ...before };
    }
    if (before.redoDepth <= 0) {
      return { ok: false, reason: "Nothing to redo.", ...before };
    }

    cancelActiveGestures();
    useTimelineStore.getState().rollbackTimelineFromCheckPoint(1);

    return { ok: true, ...historyDepths() };
  },

  select_clips: (params: { elementIds: string[] }) => {
    const ids = params.elementIds ?? [];
    const doc = useTimelineStore.getState().getDocument();
    const known = ids.filter((id) => doc.elements[id] != null);

    // `targetId` is now an accessor onto `selectionStore`, so this write goes
    // to the same place the canvas and the toolbar read from, and the canvas
    // repaints on its own subscription. The DOM reach and the explicit
    // `drawCanvas()` are kept: reaching through the element is how the rest of
    // this codebase makes cross-component calls, and asking for the redraw
    // costs one extra paint while guaranteeing the user sees which clips the
    // agent touched even if the component is mid-drag.
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
