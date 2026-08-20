/**
 * Where an element actually is on the preview canvas.
 *
 * The bug this exists for: `previewCanvas` had two answers to that question and
 * used a different one depending on what it was doing. Drawing sampled the
 * baked position track, so the element appeared wherever its animation put it.
 * `_handleMouseDown` read the static `element.location`, so hit-testing and the
 * drag's origin were taken from where the element would have been with no
 * animation at all.
 *
 * With `position.isActivate` on and the playhead anywhere the animation had
 * displaced the element, that meant clicking the element missed its real
 * rectangle, the drag origin was off by `animated − static`, and `_handleMouseUp`
 * wrote `location` into a keyframe — baking the offset in. The element jumped.
 *
 * One function, used by every one of those paths, is the fix: they cannot
 * disagree if they cannot ask separately.
 */

import { sampleTrackXY } from "../animation/keyframes";

/**
 * The subset of an element this needs — structural, not nominal.
 *
 * `animation` is loose because not every visual element declares a `position`
 * track in its type: a shape's animation block carries `opacity` alone. Asking
 * for an exact shape here would reject the very callers that need this, and the
 * function already treats a missing track as "not animated".
 */
type Positionable = {
  location?: { x?: number; y?: number };
  startTime?: number;
  animation?: Record<string, any>;
};

/**
 * The element's on-canvas position at `timelineCursor`.
 *
 * Falls back to the static `location` when the track is off, when the element
 * has not started yet, or when there is nothing baked — the same three cases
 * `sampleTrackXY` already handles, kept here so callers need no guards of their
 * own.
 */
export function displayPosition(
  element: Positionable | null | undefined,
  timelineCursor: number,
): { x: number; y: number } {
  const staticX = element?.location?.x ?? 0;
  const staticY = element?.location?.y ?? 0;

  const track = element?.animation?.position;
  if (track?.isActivate !== true) {
    return { x: staticX, y: staticY };
  }

  return sampleTrackXY(
    track,
    element?.startTime ?? 0,
    timelineCursor,
    staticX,
    staticY,
  );
}

/** Whether a drag of this element should write keyframes rather than `location`. */
export function isPositionAnimated(
  element: Positionable | null | undefined,
): boolean {
  return element?.animation?.position?.isActivate === true;
}
