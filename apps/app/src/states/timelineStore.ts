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
import {
  normalizeAnimations,
  rebakeAnimations,
} from "../features/animation/keyframeOps";
import { count as perfCount } from "../features/debug/frameStats";

/**
 * The editor's modal tool.
 *
 * Exported because `features/mask/penSession.ts` and the guards that keep the
 * pen from fighting the timeline's own bindings all have to name it, and a
 * second copy of the union is a second thing to keep in step.
 *
 * `"shape"` is the polygon tool, which click-appends straight segments to a new
 * `shape` element. It is *not* the pen: `"pen"` masks the clip that is already
 * selected and creates nothing. The two were briefly both called a pen in the
 * UI, which is the "two things called a filter" problem this codebase already
 * has a rule about.
 *
 * Anything other than `"pointer"` disables playback and the playhead-stepping
 * arrow keys — see `ui/timeline/Timeline.ts` and
 * `elementTimelineCanvas.stepCursor`/`moveSelectionByTrack`. That is the
 * mechanism by which a modal tool does not have to enumerate the bindings it is
 * not using.
 */
export type TimelineCursorType =
  | "pointer"
  | "text"
  | "shape"
  | "pen"
  | "lockKeyboard";

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

/** Extra instructions for a document arriving from outside the store. */
export type PatchOptions = {
  /**
   * Samples per second to re-derive baked animation lanes at.
   *
   * Omitted means "leave the bakes alone", which is what a caller that has no
   * project frame rate to hand should do. The app passes
   * `bakeRateFor(renderOptionStore.options.fps)`.
   */
  bakeHz?: number;
};

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
  patchDocument: (doc: TimelineDocument, options?: PatchOptions) => void;
  /**
   * Show a document without normalising it or recording an undo step.
   *
   * For the preview frames of a drag, which arrive at pointer rate. The
   * document must already be well-formed — in practice it came from a pure op
   * applied to one that was — because none of the repair work runs. `patchDocument`
   * would re-walk every keyframe array in the project on every mousemove.
   */
  previewDocument: (doc: TimelineDocument) => void;
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
      // Same rule as `withCheckpoint`: `state` by identity so an undo past the
      // start of history — which the toolbar and Cmd-Z can both ask for
      // repeatedly — notifies nobody.
      if (target < 0 || target >= state.history.timelineHistory.length) {
        return state;
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

  patchDocument: (doc: TimelineDocument, options: PatchOptions = {}) =>
    set(() => {
      // Ingress, and the only place animation blocks are validated: this is
      // what a loaded `.ngt` comes through, and projects written by older
      // builds carry `ax: [[], []]` where a list of `[t, value]` pairs belongs.
      // `normalizeDocument` would be the wrong home — it runs on every
      // checkpoint and every clip op, and re-walking keyframe arrays at pointer
      // rate to re-check data that was checked on the way in is pure cost.
      const validated = normalizeAnimations(doc);
      // A project saved at one frame rate and opened at another carries baked
      // lanes at the old rate. Ingress is the cheap moment to fix that: the
      // arrays are being walked anyway, and doing it here rather than on the
      // first edit means no undo step and no window where the preview steps at
      // a rate the project no longer runs at.
      const rebaked =
        options.bakeHz == null
          ? validated
          : rebakeAnimations(validated, options.bakeHz);
      const normalized = normalizeDocument(rebaked);
      return { timeline: normalized.elements, tracks: normalized.tracks };
    }),

  previewDocument: (doc: TimelineDocument) =>
    set(() => ({ timeline: doc.elements, tracks: doc.tracks })),

  withCheckpoint: (fn) =>
    set((state) => {
      const before = documentOf(state);
      const after = fn(before);
      // `state` itself, not `{}`. A pure op that declines returns its input by
      // identity, and this is where that becomes "the edit cost the user
      // nothing" — zustand compares the updater's result with `Object.is` and
      // does not notify when they match, so a declined split records no history
      // *and* repaints nothing. `{}` would have been a fresh object, i.e. a
      // full repaint of every subscriber for an edit that did not happen.
      if (after === before) {
        return state;
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
  setScroll: (scroll: number) => {
    if (get().scroll === scroll) {
      return;
    }
    set({ scroll });
  },
  // Guarded against a write of the value already held. Playback quantizes the
  // cursor to the project's frame grid, so on a display faster than the project
  // — a 120Hz panel showing a 30fps timeline — three out of every four animation
  // frames ask for the instant that is already set. Without this, each of them
  // wakes every subscriber to redraw a picture that cannot have changed.
  //
  // The guard has to run *before* `set`, and this is the part that is easy to
  // get wrong: it used to be `set((state) => state.cursor === cursor ? {} : …)`,
  // which does not work. Zustand skips its listeners only when the updater's
  // result is `Object.is` the current state; `{}` is a fresh object, so it
  // merges into a new state and notifies every subscriber anyway. The quantizer
  // above was therefore buying nothing at all, and the whole app repainted at
  // the display's refresh rate rather than the project's frame rate.
  // `selectionStore` states the same rule at its own writers.
  setCursor: (cursor: number) => {
    perfCount("store.setCursor");
    if (get().cursor === cursor) {
      return;
    }
    perfCount("store.setCursor:changed");
    set({ cursor });
  },
  // Guarded for the same reason as `setCursor`, and it turned out to matter as
  // much: `elementTimelineCanvas.render()` calls this with the measured width
  // on every Lit update, which during playback is every cursor tick. The width
  // is the same number every time — the window is not being resized — so this
  // was a second full notification of every subscriber per frame, doubling the
  // wake-up rate that fixing `setCursor` had just halved.
  setCanvasWidth: (canvasWidth: number) => {
    if (get().canvasWidth === canvasWidth) {
      return;
    }
    set({ canvasWidth });
  },

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
