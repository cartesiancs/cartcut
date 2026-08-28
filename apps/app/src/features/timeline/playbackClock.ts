/**
 * Where the playhead is, `elapsed` milliseconds into playback.
 *
 * The playback loop runs on `requestAnimationFrame` and reads the wall clock,
 * which means it samples time at the display's refresh rate and at instants
 * that have nothing to do with the project. It used to set the cursor to that
 * raw elapsed value, and the consequence was quiet but real: the frame the user
 * watched go by during playback was, in general, not a frame the exporter would
 * ever write. Pause on it and the preview jumped, because pausing does not
 * change the cursor but every downstream consumer floors it to a frame.
 *
 * Quantizing here makes "what is on screen" and "what will be rendered" the
 * same question at every instant, not merely when the playhead is parked. It
 * also decouples the preview from the panel: a 120Hz display showing a 30fps
 * project now advances the cursor once every four animation frames instead of
 * four times per frame, and `setCursor` drops the three repeats.
 *
 * **Floor, not round.** The same rule as `effectTimeOf` and `progressOf`, for
 * the same reason: frame `n` is on screen throughout `[n/fps, (n+1)/fps)`, and
 * rounding two thirds of the way through frame 70 would show frame 71 while the
 * playhead is still inside 70.
 *
 * **Recomputed from `elapsed`, never accumulated.** `elapsed` is
 * `Date.now() - startTime`, so it carries no error of its own, and flooring it
 * cannot drift the way `cursor += 1000 / fps` does — see the header of
 * `frames.ts` for the arithmetic behind that.
 *
 * This does not fight the drift tolerance in `playback.ts`. The largest shift a
 * floor can introduce is one frame — 16.7ms at 60fps, 8.3ms at 120 — against a
 * `PLAYING_DRIFT_TOLERANCE_SEC` of 250ms, so no additional media seek is
 * provoked. `playback.test.ts` holds that claim.
 */

import { frameStartMs } from "./frames";

/** The playhead position for `elapsedMs` into playback, on a frame boundary. */
export function cursorAtElapsed(elapsedMs: number, fps: number): number {
  return frameStartMs(Math.max(0, elapsedMs), fps);
}
