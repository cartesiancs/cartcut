import type { Hit } from "../timeline/layout";
import type { SurfaceMode } from "./touchGesture";

/**
 * What a finger landing on the timeline canvas does.
 *
 * Clips cover most of a phone's timeline, so if every press on one started a
 * move, scrolling would be impossible without dragging something by accident.
 * Phone editors settle it the same way: a drag scrolls, a tap selects, and the
 * selected clip is the one a drag moves or trims. So a press is the mouse only
 * on what is already selected; anywhere else it pans, and a tap there is
 * replayed as a click, which is what selects.
 *
 * A bare cut stays a pan: its click (offering a transition) still arrives as
 * the replayed tap, and a drag across it scrolls like any other.
 */
export function timelineTouchMode(
  hit: Hit,
  selection: readonly string[],
): SurfaceMode {
  if (hit.kind === "clip") {
    return selection.includes(hit.elementId) ? "mouse" : "pan";
  }
  if (hit.kind === "transition") {
    return selection.includes(hit.transitionId) ? "mouse" : "pan";
  }
  return "pan";
}

/**
 * The timeline wheel delta that zooms by `scale`.
 *
 * Inverts `zoom.ts#pinchRange`, `range - deltaY * range / 75`, so a pinch that
 * doubles the finger spread doubles the range, which is how far in it is.
 */
export function timelinePinchDeltaY(scale: number): number {
  return 75 * (1 - scale);
}

/**
 * The preview wheel delta that zooms by `scale`.
 *
 * Inverts `previewCanvas._handleWheel`'s `zoom * exp(-deltaY * 0.01)`.
 */
export function previewPinchDeltaY(scale: number): number {
  return -Math.log(scale) / 0.01;
}
