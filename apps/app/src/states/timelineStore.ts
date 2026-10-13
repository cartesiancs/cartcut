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
import { ingestDocument } from "../features/timeline/ingest";
import { count as perfCount } from "../features/debug/frameStats";
import {
  MAIN_TIMELINE,
  type CompositionMeta,
  type ProjectTimelines,
  type TimelineContent,
} from "../features/composition/project";
import { reconcileTemplateSpans } from "../features/composition/reconcile";
import {
  NO_COMPOSITIONS,
  NO_PARKED,
  entryOfState,
  liveContent,
  projectOfEntry,
  projectOfState,
  stateOfProject,
  type HistoryEntry,
} from "./timelineWorkspace";

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
  | "crop"
  | "lockKeyboard";

/**
 * One undo step: the project after an edit.
 *
 * Track state belongs here as much as the elements do: without it, undoing
 * "move this clip to another track" would restore the clip but not the row it
 * came from. Defined beside the rest of the multi-timeline arithmetic in
 * `timelineWorkspace.ts`; one history covers every timeline in the project.
 */
export type { HistoryEntry } from "./timelineWorkspace";

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

  /**
   * Which timeline `timeline`/`tracks` are: `MAIN_TIMELINE`, or the id of a
   * composition (a template expanded into the project).
   */
  activeTimelineId: string;
  /** Every other timeline's content, by id. Never holds the active one. */
  parked: Record<string, TimelineContent>;
  /** Every composition's name and frame, whichever timeline is active. */
  compositions: Record<string, CompositionMeta>;
  /**
   * The compositions opened as tabs, in the order they were opened. View
   * state, never undone; `timelineWorkspace.ts#visibleTimelineTabs` derives
   * what is drawn from it.
   */
  openCompositionIds: string[];
  /**
   * Bumped on every change of the active timeline. A gesture that started
   * before a switch compares it and does not commit into the timeline it did
   * not start in (`option/gestureCommit.ts`).
   */
  switchEpoch: number;
  /** Bumped when the whole project is replaced: a clear, a load. */
  projectEpoch: number;
  /**
   * Every other timeline's playhead, zoom and scroll, by id; never the active
   * one's, which is `cursor`/`range`/`scroll`. View state: not undone, not
   * saved. Swapped in the same `set` as the timeline itself, so no subscriber
   * ever sees one timeline's document under another's playhead.
   */
  views: Record<string, TimelineView>;
  /**
   * The live content as of the last commit, load, undo or switch. When the
   * live content is anything else, something wrote it without recording a
   * step (`previewDocument`, `patchTimeline`), and a switch records one before
   * parking it, so what was on screen is never parked unrecorded.
   */
  settled: TimelineContent;

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
  /**
   * `withCheckpoint` for an edit to the project rather than to one timeline:
   * expanding a template, re-baking every timeline for a new frame rate.
   * Declines by identity.
   */
  withProjectCheckpoint: (
    fn: (project: ProjectTimelines) => ProjectTimelines,
  ) => void;
  /**
   * `withCheckpoint` against a named timeline, live or parked. For work that
   * started in one timeline and finishes after the user may have switched to
   * another: a reverse, a TTS clip, an agent's media import. The result lands
   * where the work began. Declines when that timeline no longer exists.
   */
  withCheckpointOn: (
    timelineId: string,
    fn: (doc: TimelineDocument) => TimelineDocument,
  ) => void;
  /** The whole project, live timeline included. */
  getProject: () => ProjectTimelines;
  /**
   * Make another timeline the one being edited. Not an undo step. What is on
   * screen is recorded first if it was never committed.
   */
  switchTimeline: (timelineId: string, firstView?: Partial<TimelineView>) => void;
  /** Re-clamp every parked view, for a frame-rate change made elsewhere. */
  reframeParkedViews: (fn: (view: TimelineView) => TimelineView) => void;
  /** Close a composition's tab, going back to main first if it is the active one. */
  closeTimelineTab: (timelineId: string) => void;
  /**
   * Replace the project, every timeline through the same ingress
   * `patchDocument` uses. Main becomes active.
   */
  loadProject: (project: ProjectTimelines, options?: PatchOptions) => void;

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

/** A timeline's playhead, zoom and horizontal scroll. */
export type TimelineView = { cursor: number; range: number; scroll: number };

/**
 * The view fields of a state moving from timeline `from` to `to`.
 *
 * Parks `from`'s view, restores `to`'s (or opens `to` at `firstView`, or at
 * the start with the current zoom), and stops playback and drops the modal
 * tool, all in the one `set` the change of timeline is made in. These are
 * this store's own fields, so they cannot follow from a subscriber: a write
 * made inside this store's listener loop reaches the listeners after it with
 * the outer, older state last, and a canvas registered after it would be left
 * showing the old playhead.
 */
function viewSwap(
  state: ITimelineStore,
  from: string,
  to: string,
  firstView?: Partial<TimelineView>,
): Partial<ITimelineStore> {
  if (from === to) {
    return {};
  }
  const views = {
    ...state.views,
    [from]: { cursor: state.cursor, range: state.range, scroll: state.scroll },
  };
  const restored: TimelineView = views[to] ?? {
    cursor: firstView?.cursor ?? 0,
    range: firstView?.range ?? state.range,
    scroll: firstView?.scroll ?? 0,
  };
  delete views[to];
  return {
    cursor: restored.cursor,
    range: restored.range,
    scroll: restored.scroll,
    views,
    control: { ...state.control, isPlay: false, cursorType: "pointer" },
  };
}

function contentDoc(content: TimelineContent): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: content.tracks,
    elements: content.elements,
  };
}

function normalizeContent(content: TimelineContent): TimelineContent {
  const normalized = normalizeDocument(contentDoc(content));
  return { tracks: normalized.tracks, elements: normalized.elements };
}

function isSettled(state: ITimelineStore): boolean {
  return (
    state.settled.elements === state.timeline &&
    state.settled.tracks === state.tracks
  );
}

/**
 * The state after the live timeline became `normalized`, with its undo step.
 *
 * A project with only main takes the path it always took. Otherwise an edit
 * to the active composition re-fits every main clip that names it
 * (`reconcile.ts`), in this same step, which is why there is one history for
 * the whole project rather than one per timeline.
 */
function commitLive(
  state: ITimelineStore,
  normalized: TimelineDocument,
): Partial<ITimelineStore> {
  const live: TimelineContent = {
    tracks: normalized.tracks,
    elements: normalized.elements,
  };
  let parked = state.parked;
  const active = state.activeTimelineId;
  const main = parked[MAIN_TIMELINE];
  if (active !== MAIN_TIMELINE && main != null && state.compositions[active] != null) {
    const reconciled = reconcileTemplateSpans(
      {
        main,
        compositions: {
          [active]: { ...state.compositions[active], ...live },
        },
      },
      [active],
    );
    if (reconciled.main !== main) {
      parked = { ...parked, [MAIN_TIMELINE]: normalizeContent(reconciled.main) };
    }
  }

  const next = {
    ...state,
    timeline: live.elements,
    tracks: live.tracks,
    parked,
  };
  return {
    timeline: live.elements,
    tracks: live.tracks,
    parked,
    settled: live,
    history: pushHistory(state.history, entryOfState(next)),
  };
}

/** Which compositions' content differs between two projects. */
function changedCompositions(
  before: ProjectTimelines,
  after: ProjectTimelines,
): string[] {
  const out: string[] = [];
  for (const id of Object.keys(after.compositions)) {
    const a = after.compositions[id];
    const b = before.compositions[id];
    if (b == null || a.elements !== b.elements || a.tracks !== b.tracks) {
      out.push(id);
    }
  }
  return out;
}

/**
 * The state after the whole project became `after`, with its undo step.
 *
 * Every timeline the edit replaced is normalized, and main's template clips
 * are re-fitted to every composition whose content changed.
 */
function commitProject(
  state: ITimelineStore,
  before: ProjectTimelines,
  after: ProjectTimelines,
): Partial<ITimelineStore> {
  const changed = changedCompositions(before, after);
  let compositions = after.compositions;
  for (const id of changed) {
    if (compositions === after.compositions) {
      compositions = { ...compositions };
    }
    compositions[id] = { ...compositions[id], ...normalizeContent(compositions[id]) };
  }
  let main = after.main === before.main ? after.main : normalizeContent(after.main);
  const reconciled = reconcileTemplateSpans({ main, compositions }, changed);
  if (reconciled.main !== main) {
    main = normalizeContent(reconciled.main);
  }

  const split = stateOfProject(
    { main, compositions },
    state.activeTimelineId,
    state,
  );
  const next = { ...state, ...split };
  return {
    ...split,
    ...viewSwap(state, state.activeTimelineId, split.activeTimelineId),
    switchEpoch:
      split.activeTimelineId === state.activeTimelineId
        ? state.switchEpoch
        : state.switchEpoch + 1,
    settled: { tracks: split.tracks, elements: split.timeline },
    history: pushHistory(state.history, entryOfState(next)),
  };
}

const EMPTY_LIVE: TimelineContent = { tracks: [], elements: {} };

export const useTimelineStore = createStore<ITimelineStore>((set, get) => ({
  timeline: EMPTY_LIVE.elements,
  tracks: EMPTY_LIVE.tracks,
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
  activeTimelineId: MAIN_TIMELINE,
  parked: NO_PARKED,
  compositions: NO_COMPOSITIONS,
  openCompositionIds: [],
  switchEpoch: 0,
  projectEpoch: 0,
  views: {},
  settled: EMPTY_LIVE,

  addTimeline: (key: string, timeline: any) =>
    set((state) => ({ timeline: { ...state.timeline, [key]: timeline } })),

  clearTimeline: () =>
    set((state) => {
      const empty: TimelineContent = { tracks: [], elements: {} };
      return {
        ...viewSwap(state, state.activeTimelineId, MAIN_TIMELINE),
        views: {},
        timeline: empty.elements,
        tracks: empty.tracks,
        history: { timelineHistory: [], historyNow: -1 },
        activeTimelineId: MAIN_TIMELINE,
        parked: NO_PARKED,
        compositions: NO_COMPOSITIONS,
        openCompositionIds: [],
        switchEpoch:
          state.activeTimelineId === MAIN_TIMELINE
            ? state.switchEpoch
            : state.switchEpoch + 1,
        projectEpoch: state.projectEpoch + 1,
        settled: empty,
      };
    }),

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
      history: pushHistory(state.history, entryOfState(state)),
      settled: liveContent(state),
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

      // The whole project comes back, and the timeline being looked at stays
      // the one being looked at. When the restored project does not have it
      // (an undo past the Expand that created it), main is shown instead.
      const entry = state.history.timelineHistory[target];
      const split = stateOfProject(
        projectOfEntry(entry),
        state.activeTimelineId,
        state,
      );
      return {
        ...split,
        ...viewSwap(state, state.activeTimelineId, split.activeTimelineId),
        history: { ...state.history, historyNow: target },
        switchEpoch:
          split.activeTimelineId === state.activeTimelineId
            ? state.switchEpoch
            : state.switchEpoch + 1,
        settled: { tracks: split.tracks, elements: split.timeline },
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
      // Ingress: see `timeline/ingest.ts` for the four steps and why each is
      // here rather than in `normalizeDocument`.
      const normalized = ingestDocument(doc, options.bakeHz);
      return {
        timeline: normalized.elements,
        tracks: normalized.tracks,
        settled: { tracks: normalized.tracks, elements: normalized.elements },
      };
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

      return commitLive(state, normalizeDocument(after));
    }),

  withProjectCheckpoint: (fn) =>
    set((state) => {
      const before = projectOfState(state);
      const after = fn(before);
      if (after === before) {
        return state;
      }
      return commitProject(state, before, after);
    }),

  withCheckpointOn: (timelineId, fn) => {
    const state = get();
    if (timelineId === state.activeTimelineId) {
      state.withCheckpoint(fn);
      return;
    }
    if (state.parked[timelineId] == null) {
      return;
    }
    state.withProjectCheckpoint((project) => {
      const content =
        timelineId === MAIN_TIMELINE
          ? project.main
          : project.compositions[timelineId];
      if (content == null) {
        return project;
      }
      const doc = contentDoc(content);
      const next = fn(doc);
      if (next === doc) {
        return project;
      }
      const replaced = { tracks: next.tracks, elements: next.elements };
      return timelineId === MAIN_TIMELINE
        ? { ...project, main: replaced }
        : {
            ...project,
            compositions: {
              ...project.compositions,
              [timelineId]: { ...project.compositions[timelineId], ...replaced },
            },
          };
    });
  },

  getProject: () => projectOfState(get()),

  switchTimeline: (timelineId, firstView) =>
    set((state) => {
      if (timelineId === state.activeTimelineId) {
        return state;
      }
      if (state.parked[timelineId] == null) {
        return state;
      }
      // What is on screen and was never committed is recorded before it is
      // parked. Parked unrecorded, it would sit outside every undo step, and
      // the first undo after coming back would silently throw it away.
      const from: ITimelineStore = isSettled(state)
        ? state
        : { ...state, ...commitLive(state, normalizeDocument(documentOf(state))) };

      const parked = { ...from.parked, [from.activeTimelineId]: liveContent(from) };
      const target = parked[timelineId];
      delete parked[timelineId];

      return {
        ...(from === state ? {} : { history: from.history }),
        ...viewSwap(state, state.activeTimelineId, timelineId, firstView),
        timeline: target.elements,
        tracks: target.tracks,
        parked,
        activeTimelineId: timelineId,
        openCompositionIds:
          timelineId === MAIN_TIMELINE ||
          state.openCompositionIds.includes(timelineId)
            ? state.openCompositionIds
            : [...state.openCompositionIds, timelineId],
        switchEpoch: state.switchEpoch + 1,
        settled: target,
      };
    }),

  reframeParkedViews: (fn) =>
    set((state) => {
      const ids = Object.keys(state.views);
      if (ids.length === 0) {
        return state;
      }
      const views: Record<string, TimelineView> = {};
      for (const id of ids) {
        views[id] = fn(state.views[id]);
      }
      return { views };
    }),

  closeTimelineTab: (timelineId) => {
    if (timelineId === MAIN_TIMELINE) {
      return;
    }
    if (get().activeTimelineId === timelineId) {
      get().switchTimeline(MAIN_TIMELINE);
    }
    set((state) =>
      state.openCompositionIds.includes(timelineId)
        ? {
            openCompositionIds: state.openCompositionIds.filter(
              (id) => id !== timelineId,
            ),
          }
        : state,
    );
  },

  loadProject: (project, options = {}) =>
    set((state) => {
      const ingest = (content: TimelineContent): TimelineContent => {
        const doc = ingestDocument(contentDoc(content), options.bakeHz);
        return { tracks: doc.tracks, elements: doc.elements };
      };
      const compositions: ProjectTimelines["compositions"] = {};
      for (const id of Object.keys(project.compositions)) {
        compositions[id] = {
          ...project.compositions[id],
          ...ingest(project.compositions[id]),
        };
      }
      const split = stateOfProject(
        { main: ingest(project.main), compositions },
        MAIN_TIMELINE,
        { parked: NO_PARKED, compositions: NO_COMPOSITIONS },
      );
      return {
        ...split,
        ...viewSwap(state, state.activeTimelineId, MAIN_TIMELINE),
        views: {},
        openCompositionIds: [],
        switchEpoch:
          state.activeTimelineId === MAIN_TIMELINE
            ? state.switchEpoch
            : state.switchEpoch + 1,
        projectEpoch: state.projectEpoch + 1,
        settled: { tracks: split.tracks, elements: split.timeline },
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
