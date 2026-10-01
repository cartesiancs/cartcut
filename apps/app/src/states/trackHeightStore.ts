/**
 * How tall each timeline row is, while the project is open.
 *
 * A store of its own, not a field on `TimelineTrack`: a row's height is view
 * state (`features/timeline/trackHeights.ts` says why), so it is never undone,
 * and it is not `uiStore`, whose dozen subscribers listen without a selector
 * and would all wake on every pixel of a resize. Only the timeline canvas and
 * the header column read this, so a resize never wakes the preview.
 *
 * `heights` is what the project holds. `live` is the row being dragged right
 * now, drawn but not yet kept: Auto Save and the dirty digest read `heights`
 * only, so one resize is one change however many pixels it crossed, and Escape
 * is a matter of dropping `live`.
 *
 * Every write that changes nothing returns `state` by identity, so zustand
 * notifies nobody (a store that notified on no-op writes once defeated the
 * timeline's frame quantizer).
 */

import { createStore } from "zustand/vanilla";

import {
  DEFAULT_TRACK_HEIGHT,
  NO_TRACK_HEIGHTS,
  coerceTrackHeight,
  withTrackHeight,
  type TrackHeights,
} from "../features/timeline/trackHeights";
import {
  TIMELINE_VIEW_ENTRY,
  serializeTimelineViewEntry,
} from "../features/project/timelineView";
import type { TimelineTrack } from "../features/timeline/tracks";

export type LiveTrackHeight = { trackId: string; px: number };

export interface ITrackHeightStore {
  /**
   * Rows that differ from the default, by track id.
   *
   * A deleted track's entry is kept, so undoing the delete brings its height
   * back; the save path writes only rows that exist.
   */
  heights: TrackHeights;
  /** The row a resize is dragging, at the height it is drawn at. */
  live: LiveTrackHeight | null;

  /** Draw `trackId` at `px` without keeping it yet. */
  preview: (trackId: string, px: number) => void;
  /** Keep what `preview` drew. */
  commit: () => void;
  /** Drop what `preview` drew; the row goes back to its kept height. */
  cancel: () => void;
  /** Put one row back to the default. */
  reset: (trackId: string) => void;
  /** Load: replaces everything, for a project that was just opened. */
  replace: (heights: TrackHeights) => void;
}

export const trackHeightStore = createStore<ITrackHeightStore>((set) => ({
  heights: NO_TRACK_HEIGHTS,
  live: null,

  preview: (trackId, px) =>
    set((state) => {
      const next = coerceTrackHeight(px);
      if (state.live?.trackId === trackId && state.live.px === next) {
        return state;
      }
      return { ...state, live: { trackId, px: next } };
    }),

  commit: () =>
    set((state) => {
      if (state.live == null) {
        return state;
      }
      const heights = withTrackHeight(
        state.heights,
        state.live.trackId,
        state.live.px,
      );
      // `heights` keeps its identity when the drag ended where it began, and
      // Auto Save gates on that identity, so a resize that went nowhere is not
      // a change.
      return { ...state, heights, live: null };
    }),

  cancel: () =>
    set((state) => (state.live == null ? state : { ...state, live: null })),

  reset: (trackId) =>
    set((state) => {
      const heights = withTrackHeight(
        state.heights,
        trackId,
        DEFAULT_TRACK_HEIGHT,
      );
      const live = state.live?.trackId === trackId ? null : state.live;
      if (heights === state.heights && live === state.live) {
        return state;
      }
      return { ...state, heights, live };
    }),

  replace: (heights) =>
    set((state) => {
      if (
        state.live == null &&
        JSON.stringify(state.heights) === JSON.stringify(heights)
      ) {
        return state;
      }
      return { ...state, heights, live: null };
    }),
}));

let memoHeights: TrackHeights | null = null;
let memoLive: LiveTrackHeight | null = null;
let memoEffective: TrackHeights = NO_TRACK_HEIGHTS;

/**
 * The heights to draw with: what is kept, with the row being dragged on top.
 *
 * Memoised on the two inputs, so a repaint that changes neither hands the
 * layout the same object it had last frame.
 */
export function effectiveTrackHeights(
  state: Pick<ITrackHeightStore, "heights" | "live"> = trackHeightStore.getState(),
): TrackHeights {
  if (state.heights === memoHeights && state.live === memoLive) {
    return memoEffective;
  }
  memoHeights = state.heights;
  memoLive = state.live;
  memoEffective =
    state.live == null
      ? state.heights
      : withTrackHeight(state.heights, state.live.trackId, state.live.px);
  return memoEffective;
}

/** The `.ngt` entry, or `null` when every row is at the default. */
export function timelineViewEntryText(
  tracks: readonly Pick<TimelineTrack, "id">[],
): string | null {
  return serializeTimelineViewEntry(
    trackHeightStore.getState().heights,
    tracks.map((track) => track.id),
  );
}

/** What the save path passes to `buildNgtBlob`. Empty when there is nothing. */
export function timelineViewExtraEntries(
  tracks: readonly Pick<TimelineTrack, "id">[],
): Record<string, string> {
  const text = timelineViewEntryText(tracks);
  return text == null ? {} : { [TIMELINE_VIEW_ENTRY]: text };
}
