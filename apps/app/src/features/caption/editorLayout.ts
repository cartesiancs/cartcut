/**
 * How the caption editor arranges itself for the width it has been given.
 *
 * It used to have one width, because it was a `modal-fullscreen`: the preview
 * column was a flat `flex: 0 0 42%` of the whole window and the canvas was
 * capped at `55vh`. Docked beside the preview it is a few hundred pixels wide
 * instead, and both of those numbers become wrong in a way nothing would catch
 * on a developer's 1600px display.
 *
 * The decision lives here rather than in the panel for the reason the whole of
 * `features/caption/` exists: `apps/automatic-caption/` is outside every vitest
 * include pattern, so a breakpoint written into a Lit template is a breakpoint
 * nothing can check.
 *
 * **The width that matters is the window's, never the viewport's.** A viewport
 * media query would answer about the screen, which is the one measurement that
 * does not change when the splitter moves. The panel therefore asks a container
 * query against the `appwindow` container that `_window.scss` establishes, and
 * this module is the same rule written as arithmetic so it can be tested and so
 * the panel can size its canvas from it.
 */

export type CaptionEditorColumns = "two" | "one";

export type CaptionEditorLayout = {
  columns: CaptionEditorColumns;
  /** The preview column's share of the width, 0 to 1. Meaningless when stacked. */
  previewShare: number;
  /** Cap on the drawn height of the preview canvas, px. */
  canvasMaxHeightPx: number;
};

/**
 * Below this the two columns stack, in px.
 *
 * Derived from the two things that have to fit side by side, and the preview is
 * the one that binds. A caption row is two 32px icon buttons, two 4px gaps and
 * a text input that stops being usable under about 180px, so the list needs
 * roughly 260px. A 16:9 frame under about 220px is too small to judge a
 * caption's position against, which is that column's entire job.
 *
 * The two are not free to trade, because the split is a fixed share: at 42% the
 * preview reaches 220px only at 524, while the list clears 260px from 476. So
 * the preview sets the floor, and 540 is that rounded up to a number that does
 * not look like a measurement pretending to be exact.
 *
 * The first draft put this at 520 and claimed both minimums were met. 520 times
 * 0.42 is 218.4, and `editorLayout.test.ts` is what said so.
 */
export const CAPTION_EDITOR_BREAKPOINT_PX = 540;

/** The preview column's share when there is room for two columns. */
const PREVIEW_SHARE = 0.42;

/**
 * The canvas's share of the available height.
 *
 * Lower when stacked, because then the canvas is directly above the list rather
 * than beside it: at the two-column share a stacked canvas pushes every caption
 * below the fold, so the panel opens on a picture with no words in it.
 */
const CANVAS_SHARE = { two: 0.55, one: 0.38 } as const;

/**
 * A floor, in px.
 *
 * A canvas capped at zero is a blank panel, which reads as a decode that
 * failed rather than as a window that is too short. Better to overflow the cap
 * by a few pixels than to vanish.
 */
const CANVAS_MIN_PX = 96;

export function captionEditorLayout(size: {
  width: number;
  height: number;
}): CaptionEditorLayout {
  const width = Math.max(0, size.width);
  const height = Math.max(0, size.height);
  const columns: CaptionEditorColumns =
    width >= CAPTION_EDITOR_BREAKPOINT_PX ? "two" : "one";

  return {
    columns,
    previewShare: PREVIEW_SHARE,
    canvasMaxHeightPx: Math.max(
      CANVAS_MIN_PX,
      Math.round(height * CANVAS_SHARE[columns]),
    ),
  };
}
