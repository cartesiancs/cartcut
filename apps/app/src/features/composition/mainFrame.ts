/**
 * The project's own frame size, while a template's timeline is showing.
 *
 * `renderOptionStore.options.previewSize` is read by thirty-odd modules as
 * "the frame being edited": the preview's frame, where a new clip is centred,
 * how big a title lands, the agent's framing. While a composition is showing
 * that frame is the composition's, so the switch puts the composition's size
 * there (`switchEffects.ts`) and keeps the project's here until main comes
 * back. Everything that means "the project" rather than "the frame being
 * edited" (the save, Auto Save, the dirty digest, the export) reads
 * `projectRenderOptions` instead, which puts this back.
 *
 * Held outside any store because it is never undone, never saved by itself,
 * and only ever written by the switch effect, in the same synchronous step as
 * the store's change of timeline.
 */

let parked: { w: number; h: number } | null = null;

export function parkedMainFrame(): { w: number; h: number } | null {
  return parked;
}

export function setParkedMainFrame(frame: { w: number; h: number } | null): void {
  parked = frame == null ? null : { w: frame.w, h: frame.h };
}
