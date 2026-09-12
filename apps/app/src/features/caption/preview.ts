/**
 * The auto-caption panel's preview frame.
 *
 * One function, and the claim it exists to keep: **the panel draws the element
 * it will place.** The preview composites through the app's own
 * `renderElement` → `renderText`, over the same `captionStyle` that
 * `caption/rows.ts` emits, so parity with the export is structural rather than
 * something anyone maintains. `preview.parity.test.ts` is that claim as a test.
 *
 * It replaced a hand-rolled `drawCaption`/`drawTextBackground` that was out by a
 * font size vertically, used a line advance of 52 against the renderer's 62.4,
 * and padded the background band on one side only.
 *
 * ## The canvas and the frame are two sizes
 *
 * They are equal in the panel today, because the `<canvas>` element's
 * `width`/`height` attributes are bound to `previewSize` and CSS does the
 * downscale — the arrangement `templateThumbnail.ts` and the contact sheet use.
 * They are still separate parameters: the **fill** covers the backing store,
 * while the **layout** is computed from the project frame, and collapsing them
 * would quietly decide what happens when they differ instead of leaving it
 * visible. Scaling the context instead of sizing the backing store would leave
 * the wrap width, band padding and outline geometrically right but no longer
 * bit-identical to the export.
 *
 * ## The clip's picture is drawn in the clip's own box
 *
 * At the frame's size rather than the canvas's, so a 4K clip in a 1080p project
 * overflows here exactly as it will on the timeline instead of being silently
 * squashed to fit — which is information the user needs while positioning
 * captions over it.
 *
 * `sourceImage` is a plain `CanvasImageSource` rather than a media element: the
 * "is this a video" and "has a frame arrived" questions are four lines of DOM
 * interrogation with no logic in them, and they stay with the caller. That is
 * also what lets the suite hand this an ordinary canvas.
 */

import { createTextElement } from "../element/textElement";
import { renderElement } from "../renderer/element";
import { renderText } from "../renderer/text";
import { captionStyle, type CaptionFrame, type CaptionPlacement } from "./layout";
import { lineIndexAt, type CaptionLine } from "./lines";

/** The id the preview draws under. Not a timeline element, so it names itself. */
export const PREVIEW_ELEMENT_ID = "caption-preview";

export type CaptionPreviewState = {
  /** The canvas backing store, which the background fill covers. */
  canvasSize: { w: number; h: number };
  /** The project frame the caption is laid out in. */
  frame: CaptionFrame;
  backgroundColor: string;
  lines: CaptionLine[];
  /** Seconds into the source media — the media element's own clock. */
  progressSec: number;
  placement: CaptionPlacement;
  /** The clip's current frame, or null for audio and before one has arrived. */
  sourceImage: CanvasImageSource | null;
};

/**
 * The text element for one caption line.
 *
 * Exactly what `captionRows` will emit for that line, minus the timing — so the
 * parity suite can build both sides from the same two functions.
 */
export function captionElementAt(
  lines: CaptionLine[],
  index: number,
  frame: CaptionFrame,
  placement: CaptionPlacement,
) {
  return createTextElement({
    ...captionStyle(frame, placement),
    text: lines[index]?.text ?? "",
  });
}

/** The one place the preview writes pixels. */
export function paintCaptionPreview(
  ctx: CanvasRenderingContext2D,
  state: CaptionPreviewState,
): void {
  // Fill rather than clear, with the project's own background — what
  // `renderer/timeline.ts#paint` does before drawing anything. There was no
  // clear of any kind here before, so an audio-only clip stacked every caption
  // it had ever drawn on top of the last.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = state.backgroundColor;
  ctx.fillRect(0, 0, state.canvasSize.w, state.canvasSize.h);

  if (state.sourceImage != null) {
    ctx.drawImage(state.sourceImage, 0, 0, state.frame.w, state.frame.h);
  }

  const index = lineIndexAt(state.lines, state.progressSec);
  if (index == null) {
    return;
  }

  // The real path: `renderTimelineAtTime` → `paint` → `renderElement` →
  // `renderText`. `context` is omitted deliberately — it is only read for parent
  // lookups, and a caption that is not on the timeline yet has no parent. The
  // cursor is inert for a plain caption (every animation track is inactive and
  // there is no reveal), but it is passed honestly anyway.
  renderElement(
    ctx,
    PREVIEW_ELEMENT_ID,
    captionElementAt(state.lines, index, state.frame, state.placement),
    state.progressSec * 1000,
    false,
    renderText,
  );
}
