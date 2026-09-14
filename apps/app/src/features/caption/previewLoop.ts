/**
 * The caption panel's frame clock, and its re-render gate.
 *
 * Two small things that survive from a preview the panel no longer has. It used
 * to run its own animation loop over its own canvas, playing its own copy of
 * the source file; the captions are on the real timeline now and the app's own
 * preview draws them, so the loop went with the canvas.
 *
 * What is left is what the rest of the feature turned out to need anyway:
 *
 * - **`FrameScheduler`**, which is how `captionSession.ts` paces its reveal.
 *   `window.requestAnimationFrame` is reached only through it, so that whole
 *   state machine runs under `environment: "node"` against a counter, the
 *   narrowing `ui/transientModal.ts` does to `bootstrap.Modal`.
 * - **`ChromeGate`**, which decides whether a playhead change is worth a
 *   re-render at all. The panel follows the app's cursor now, which moves at
 *   the display's rate, and the only things in its template that depend on it
 *   are the active line and the active word. Gating on exactly those is what
 *   keeps a 60Hz cursor from rebuilding a TemplateResult for every word of the
 *   transcript sixty times a second.
 *
 * `PreviewLoop` was the third thing here. It is gone, along with the two
 * animation-frame handles whose interaction it existed to pin.
 */

import { playheadLabel } from "../media/playback";
import { activeAt, type CaptionLine } from "./lines";

/** The part of `window` the loop needs. */
export type FrameScheduler = {
  request(callback: () => void): number;
  cancel(id: number): void;
};

/** `window`, as a scheduler. */
export function windowScheduler(): FrameScheduler {
  return {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (id) => window.cancelAnimationFrame(id),
  };
}

/**
 * What the caption list and the playhead readout are showing, as one string.
 *
 * The 60Hz loop used to call `requestUpdate()` every frame, rebuilding a
 * `TemplateResult` for every word of the whole transcript sixty times a second,
 * on the thread compositing the frame. Nothing in the template moves that fast:
 * only which word is highlighted, and a readout rounded to whole seconds.
 */
export function chromeKey(lines: CaptionLine[], timeSec: number): string {
  const { lineIndex, wordIndex } = activeAt(lines, timeSec);
  return `${lineIndex ?? -1}:${wordIndex ?? -1}`;
}

/**
 * Remembers what the template last showed, so an unchanged frame costs nothing.
 *
 * The label is gated on the **string the template actually renders**, not on a
 * rounded second. `formatPlayhead` floors, so gating on `Math.round` would hold
 * the re-render back across the very boundary where the readout changes and
 * leave it a second stale.
 */
export class ChromeGate {
  private shownActive = "";
  private shownLabel = "";

  /**
   * Whether anything the template shows has changed — and records it if so.
   *
   * Both strings start empty, which is not a state either argument can take
   * (`chromeKey` always has a colon in it), so the first call always answers
   * true.
   */
  changed(active: string, label: string): boolean {
    if (active === this.shownActive && label === this.shownLabel) {
      return false;
    }
    this.shownActive = active;
    this.shownLabel = label;
    return true;
  }
}

/** The gate's two inputs for one moment. */
export function chromeStateOf(
  lines: CaptionLine[],
  timeSec: number,
  durationSec: number,
): { active: string; label: string } {
  return {
    active: chromeKey(lines, timeSec),
    label: playheadLabel(timeSec, durationSec),
  };
}
