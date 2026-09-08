/**
 * The preview's two modes, and everything that differs between them.
 *
 * The editing preview earns its chrome: elements parked outside the frame are
 * drawn dimmed so they can still be found and grabbed, a hairline marks where
 * the rendered frame actually ends, the selection carries an outline and eight
 * grips, and `FIT_PADDING_PX` leaves a margin so a clip flush to the edge is
 * still visible. Every one of those is in the way when the point is to *watch*
 * the cut rather than to change it.
 *
 * So there is a second mode, and it is defined here as data — one `PreviewChrome`
 * record that `previewCanvas` branches on — rather than as a `playbackPreview`
 * boolean tested in six places. Six independent tests are six chances for one
 * of them to be missed, and the one that gets missed is invisible until someone
 * enters the mode with a clip selected and finds a grip floating over the
 * picture.
 *
 * Pure and DOM-free.
 */

import { FIT_PADDING_PX, fitViewport, type Viewport } from "./viewport";

/** The infinite plane the frame floats on, while editing. */
export const CANVAS_BG = "#101112";

/**
 * What surrounds the frame while presenting, and it is not `CANVAS_BG`.
 *
 * Letterbox bars are meant to disappear, and a near-black that is *nearly* the
 * same as the picture's own black reads as a panel edge instead — the one thing
 * a presentation view must not have.
 */
export const PRESENTATION_BG = "#000000";

export type PreviewChrome = {
  /** The hairline rectangle marking the rendered resolution. */
  frameGuide: boolean;
  /** The dimmed blit that shows what is hanging outside the frame. */
  dimOutside: boolean;
  /** Selection outline, grips, pen and shape overlays, snap guides. */
  selection: boolean;
  /** What fills the canvas behind everything. */
  background: string;
  /** CSS px of breathing room left around the frame at zoom 100. */
  fitPadding: number;
  /** Whether the canvas answers the mouse, the wheel and its own keys. */
  pointerInput: boolean;
};

const EDITING_CHROME: PreviewChrome = {
  frameGuide: true,
  dimOutside: true,
  selection: true,
  background: CANVAS_BG,
  fitPadding: FIT_PADDING_PX,
  pointerInput: true,
};

/**
 * Presenting turns all of it off at once.
 *
 * `dimOutside: false` is what satisfies "nothing outside the frame may be
 * seen": `drawCanvas` blits the scene twice, once dimmed and unclipped and once
 * at full opacity clipped to the frame, so dropping the first leaves the second
 * against the background and nothing else.
 *
 * `fitPadding: 0` is what satisfies "dead centre, at 100%": `zoom` is already
 * defined as a percentage *of the fit scale*, so with no padding to subtract,
 * zoom 100 is exactly the frame filling the viewport on its tight axis.
 */
const PRESENTING_CHROME: PreviewChrome = {
  frameGuide: false,
  dimOutside: false,
  selection: false,
  background: PRESENTATION_BG,
  fitPadding: 0,
  pointerInput: false,
};

export function chromeFor(active: boolean): PreviewChrome {
  return active ? PRESENTING_CHROME : EDITING_CHROME;
}

export type PlaybackPreviewState = {
  active: boolean;
  /**
   * Where the user was looking before the mode was entered.
   *
   * Null while editing. This is the whole reason the mode needs a state object
   * rather than a boolean: presenting overwrites the shared
   * `previewViewportStore`, and a zoom and pan the user spent time arranging is
   * not something a view toggle may spend.
   */
  restore: Viewport | null;
};

export const EDITING: PlaybackPreviewState = { active: false, restore: null };

/**
 * The whole transition one click makes, as one function.
 *
 * Both halves are here rather than in the store because they are two ends of
 * one invariant — whatever entering saves, leaving must give back — and split
 * across two methods that invariant is something a reader has to reconstruct.
 *
 * **Entering while already active returns the state by identity**, the repo's
 * decline convention, and it is doing real work: a second enter would write the
 * *presentation* viewport into `restore` and the user's zoom and pan would be
 * gone for good. The store is shared and the button is not the only thing that
 * could ask twice, so the guard belongs at the transition rather than at the
 * caller.
 *
 * Leaving while already inactive declines the same way and hands back the
 * viewport it was given, so the caller's write is a no-op rather than a jump.
 */
export function togglePlaybackPreview(
  state: PlaybackPreviewState,
  current: Viewport,
  frameW: number,
  frameH: number,
): { state: PlaybackPreviewState; viewport: Viewport } {
  if (state.active) {
    return {
      state: EDITING,
      // A state that says `active` with no `restore` cannot be produced by this
      // module, but it can be produced by a hand-edited store or a future
      // caller, and dropping the user somewhere arbitrary is worse than
      // leaving them where they are.
      viewport: state.restore ?? current,
    };
  }

  return {
    state: { active: true, restore: current },
    viewport: fitViewport(frameW, frameH),
  };
}

/** Enter only, for callers that mean "on" rather than "the other one". */
export function enterPlaybackPreview(
  state: PlaybackPreviewState,
  current: Viewport,
  frameW: number,
  frameH: number,
): { state: PlaybackPreviewState; viewport: Viewport } {
  if (state.active) {
    return { state, viewport: current };
  }
  return togglePlaybackPreview(state, current, frameW, frameH);
}

/** Leave only. Declines by identity when already editing. */
export function exitPlaybackPreview(
  state: PlaybackPreviewState,
  current: Viewport,
): { state: PlaybackPreviewState; viewport: Viewport } {
  if (!state.active) {
    return { state, viewport: current };
  }
  return { state: EDITING, viewport: state.restore ?? current };
}
