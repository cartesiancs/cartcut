import { createStore } from "zustand/vanilla";
import {
  EDITING,
  exitPlaybackPreview,
  togglePlaybackPreview,
  type PlaybackPreviewState,
} from "../features/preview/playbackPreview";
import type { Viewport } from "../features/preview/viewport";

/**
 * Whether the preview is being watched rather than edited.
 *
 * Session-only, exactly as `previewViewportStore` is and for the same reason:
 * this is what the user is doing, not part of the project, so
 * `functions/project.ts` does not serialise it into the `.ngt`.
 *
 * There is a second reason here, though, and it is the sharper one. A mode that
 * blocks mouse input everywhere but the timeline must never be *restored* into
 * — reopening a project to a window that will not answer the mouse is
 * indistinguishable from a hung app. `record/recordSettings.ts` writes
 * `drawing` like any other field and then refuses to read it back, for this
 * exact case; not persisting at all is the same decision one step earlier.
 *
 * All the arithmetic lives in `features/preview/playbackPreview.ts`, which is
 * where it can be tested. This store is wiring.
 */
export interface IPlaybackPreviewStore {
  state: PlaybackPreviewState;
  /**
   * Flip the mode, and answer with the viewport the caller must now install.
   *
   * The caller writes it to `previewViewportStore` rather than this store doing
   * it, so the two stores stay independent and the transition stays one pure
   * function that a suite can drive without either of them.
   */
  toggle: (current: Viewport, frameW: number, frameH: number) => Viewport;
  /** Leave, if we are in it. Same contract as `toggle`. */
  exit: (current: Viewport) => Viewport;
}

export const playbackPreviewStore = createStore<IPlaybackPreviewStore>(
  (set, get) => ({
    state: EDITING,

    toggle: (current: Viewport, frameW: number, frameH: number) => {
      const next = togglePlaybackPreview(get().state, current, frameW, frameH);
      set(() => ({ state: next.state }));
      return next.viewport;
    },

    exit: (current: Viewport) => {
      const next = exitPlaybackPreview(get().state, current);
      set(() => ({ state: next.state }));
      return next.viewport;
    },
  }),
);
