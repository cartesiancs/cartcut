import { createStore } from "zustand/vanilla";
import { Timeline } from "../@types/timeline";
import { setIn } from "../utils/immutable";
import {
  SCHEMA_VERSION,
  appendTrackOfKind,
  derivePriorities,
  moveTrack,
  normalizeDocument,
  removeTrack,
  type TimelineDocument,
  type TimelineTrack,
  type TrackKind,
} from "../features/timeline/tracks";

type TimelineCursorType = "pointer" | "text" | "shape" | "lockKeyboard";

/**
 * One undo step.
 *
 * Track state belongs here as much as the elements do: without it, undoing
 * "move this clip to another track" would restore the clip but not the row it
 * came from.
 */
export type HistoryEntry = {
  tracks: TimelineTrack[];
  elements: Timeline;
};

/**
 * Checkpoints used to be taken per element-add and per delete only, so a whole
 * drag was one step — or none at all. Now that every edit is one checkpoint,
 * ten steps is not enough history to be useful.
 */
export const HISTORY_LIMIT = 50;

export interface ITimelineStore {
  timeline: Timeline;
  tracks: TimelineTrack[];
  range: number;
  scroll: number;
  cursor: number;
  canvasWidth: number;
  control: {
    isPlay: boolean;
    cursorType: TimelineCursorType;
  };
  history: {
    timelineHistory: HistoryEntry[];
    historyNow: number;
  };

  addTimeline: (key: string, timeline: any) => void;
  clearTimeline: () => void;
  removeTimeline: (targetId: string) => void;
  patchTimeline: (timeline: any) => void;
  checkPointTimeline: () => void;
  rollbackTimelineFromCheckPoint: (cursor: number) => void;
  setRange: (range: number) => void;
  setScroll: (scroll: number) => void;
  setCursor: (cursor: number) => void;
  setCanvasWidth: (canvasWidth: number) => void;

  increaseCursor: (dt: number) => void;
  decreaseCursor: (dt: number) => void;
  switchPlay: () => void;
  setPlay: (isPlay: boolean) => void;
  setCursorType: (cursorType: TimelineCursorType) => void;
  updateTimeline: (targetId: any, targetArray: string[], value: any) => void;

  /** The tracks and elements as one value, for the pure timeline modules. */
  getDocument: () => TimelineDocument;
  /** Replace both, re-deriving indices, names and priorities. */
  patchDocument: (doc: TimelineDocument) => void;
  /**
   * Apply a pure document transform and record one undo step — but only if the
   * transform actually changed something. The pure ops return their input
   * unchanged when they decline (an out-of-bounds split, a rejected drop), so
   * identity is a reliable "nothing happened" signal.
   */
  withCheckpoint: (fn: (doc: TimelineDocument) => TimelineDocument) => void;

  addTrack: (kind: TrackKind, id: string) => void;
  removeTrackById: (
    trackId: string,
    mode?: "delete-clips" | "reject-if-nonempty",
  ) => void;
  moveTrackTo: (trackId: string, index: number) => void;
}

function documentOf(state: {
  tracks: TimelineTrack[];
  timeline: Timeline;
}): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: state.tracks,
    elements: state.timeline,
  };
}

/**
 * Push one entry, dropping any redo branch and holding the cap.
 *
 * Both halves were broken before: pushing after an undo left the abandoned
 * future in place, and `shift()` at the cap silently invalidated `historyNow`
 * so every later undo landed one step off.
 */
function pushHistory(
  history: { timelineHistory: HistoryEntry[]; historyNow: number },
  entry: HistoryEntry,
): { timelineHistory: HistoryEntry[]; historyNow: number } {
  const kept = history.timelineHistory.slice(0, history.historyNow + 1);
  kept.push(entry);

  const overflow = Math.max(0, kept.length - HISTORY_LIMIT);
  const trimmed = overflow > 0 ? kept.slice(overflow) : kept;

  return { timelineHistory: trimmed, historyNow: trimmed.length - 1 };
}

export const useTimelineStore = createStore<ITimelineStore>((set, get) => ({
  timeline: {},
  tracks: [],
  range: 0.9,
  scroll: 0,
  cursor: 0,
  canvasWidth: 500,
  control: {
    isPlay: false,
    cursorType: "pointer",
  },
  history: {
    timelineHistory: [],
    // -1 means "nothing recorded yet", so the first push lands at 0.
    historyNow: -1,
  },

  addTimeline: (key: string, timeline: any) =>
    set((state) => ({ timeline: { ...state.timeline, [key]: timeline } })),

  clearTimeline: () =>
    set(() => ({
      timeline: {},
      tracks: [],
      history: { timelineHistory: [], historyNow: -1 },
    })),

  removeTimeline: (targetId: string) =>
    set((state) => {
      const { [targetId]: _removed, ...rest } = state.timeline;
      return { timeline: rest };
    }),

  patchTimeline: (timeline: any) =>
    set((state) => ({
      // Once tracks exist, `priority` is derived rather than authored, so it is
      // recomputed on every write. With no tracks yet this is a plain replace,
      // which is what every existing caller expects.
      timeline:
        state.tracks.length > 0
          ? derivePriorities({
              schemaVersion: SCHEMA_VERSION,
              tracks: state.tracks,
              elements: timeline,
            })
          : { ...timeline },
    })),

  checkPointTimeline: () =>
    set((state) => ({
      history: pushHistory(state.history, {
        tracks: state.tracks,
        elements: state.timeline,
      }),
    })),

  rollbackTimelineFromCheckPoint: (cursor: number) =>
    set((state) => {
      const target = state.history.historyNow + cursor;
      if (target < 0 || target >= state.history.timelineHistory.length) {
        return {};
      }

      const entry = state.history.timelineHistory[target];
      return {
        timeline: entry.elements,
        tracks: entry.tracks,
        history: { ...state.history, historyNow: target },
      };
    }),

  updateTimeline: (targetId: any, targetArray: string[], value: any) =>
    set((state) => ({
      // Immutable path update: clone only root -> changed leaf, share the rest.
      // Replaces the old in-place mutation that leaked nested references across
      // the store snapshot, component aliases, and every undo-history entry.
      timeline: {
        ...state.timeline,
        [targetId]: setIn(state.timeline[targetId], targetArray, value),
      },
    })),

  getDocument: () => documentOf(get()),

  patchDocument: (doc: TimelineDocument) =>
    set(() => {
      const normalized = normalizeDocument(doc);
      return { timeline: normalized.elements, tracks: normalized.tracks };
    }),

  withCheckpoint: (fn) =>
    set((state) => {
      const before = documentOf(state);
      const after = fn(before);
      if (after === before) {
        return {};
      }

      const normalized = normalizeDocument(after);
      return {
        timeline: normalized.elements,
        tracks: normalized.tracks,
        history: pushHistory(state.history, {
          tracks: normalized.tracks,
          elements: normalized.elements,
        }),
      };
    }),

  addTrack: (kind: TrackKind, id: string) =>
    get().withCheckpoint((doc) => appendTrackOfKind(doc, kind, id)),

  removeTrackById: (trackId, mode = "reject-if-nonempty") =>
    get().withCheckpoint((doc) => removeTrack(doc, trackId, mode)),

  moveTrackTo: (trackId, index) =>
    get().withCheckpoint((doc) => moveTrack(doc, trackId, index)),

  setRange: (range: number) =>
    set((state) => ({
      range: range,
      scroll:
        (state.cursor / 5) * (range / 4) - state.canvasWidth / 2 <= 0
          ? 0
          : (state.cursor / 5) * (range / 4) - state.canvasWidth / 2,
    })),
  setScroll: (scroll: number) => set(() => ({ scroll: scroll })),
  setCursor: (cursor: number) => set(() => ({ cursor: cursor })),
  setCanvasWidth: (canvasWidth: number) =>
    set(() => ({ canvasWidth: canvasWidth })),

  increaseCursor: (dt: number) =>
    set((state) => ({ cursor: state.cursor + dt })),

  decreaseCursor: (dt: number) =>
    set((state) => ({ cursor: state.cursor - dt })),

  switchPlay: () =>
    set((state) => ({
      control: { ...state.control, ["isPlay"]: !state.control.isPlay },
    })),

  setPlay: (isPlay: boolean) =>
    set((state) => ({ control: { ...state.control, ["isPlay"]: isPlay } })),

  setCursorType: (cursorType: TimelineCursorType) =>
    set((state) => ({
      control: { ...state.control, ["cursorType"]: cursorType },
    })),
}));
