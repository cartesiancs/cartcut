/**
 * How far into an effect the playhead is, in seconds.
 *
 * The `time` uniform every effect shader receives, and the thing that makes an
 * animated effect possible at all. Without it a shader has no way to differ
 * between one frame and the next: the shipped `film-grain` computed its noise
 * from `gl_FragCoord` alone, so the "grain" was a fixed stain that never moved.
 *
 * Two decisions, both of which have bitten this codebase before in other forms.
 *
 * **Element-local.** Measured from the effect's own `startTime`, not from the
 * timeline origin. An effect therefore behaves identically wherever it is
 * dragged to — a flicker that starts on its first frame keeps starting on its
 * first frame. Timeline-absolute time would make an effect look different for
 * no reason the user could see.
 *
 * **Frame-snapped, by exactly the rule `progressOf` uses.** The preview's
 * playback loop drives the cursor from the wall clock (`Date.now()` in
 * `elementControl.step`) while export walks frame indices, so the same frame
 * reaches the two paths as different millisecond values. Feeding that straight
 * into a shader means the grain pattern in the render is not the one the user
 * approved in the preview — invisible until they compare, and impossible to
 * explain afterwards. Flooring to the frame grid with the exporter's own
 * expression makes the two bit-identical.
 *
 * See `transitionGeometry.ts#progressOf`, which carries the long version of
 * this reasoning; this is the same fix for the other animated uniform.
 */

import type { EffectElementType } from "../../../@types/timeline";
import { frameToMs, msToFrameFloor } from "../../timeline/frames";

/**
 * Seconds since the effect began, snapped to the frame grid.
 *
 * Never negative: before the effect starts there is nothing to animate, and a
 * negative time fed to a `fract`/`mod` noise function produces a discontinuity
 * exactly at the clip's first frame.
 */
export function effectTimeOf(
  element: EffectElementType,
  timeInMs: number,
  fps: number,
): number {
  const snapped = frameToMs(msToFrameFloor(timeInMs, fps), fps);
  return Math.max(0, (snapped - element.startTime) / 1000);
}
