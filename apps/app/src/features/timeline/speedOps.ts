/**
 * Changing a clip's playback rate.
 *
 * Speed sits between the two invariants `geometry.ts` states, and only one of
 * them mentions it:
 *
 *  - `duration === trim.endTime - trim.startTime`, in **source** ms. `speed`
 *    does not appear, so changing it cannot break `assertTrimInvariant`. None
 *    of the footage is gained or lost.
 *  - the clip occupies `[startTime, startTime + duration/speed)` on the
 *    **timeline**. `speed` is the divisor, so changing it *resizes the clip
 *    where it sits*.
 *
 * That second one is why this is not a field `update_clip` may write. Halving
 * the speed of a ten-second clip makes it occupy twenty and overlap whatever
 * is next to it — and "clips on a track never overlap" is the one rule every
 * other op in `clipOps.ts` checks with `findCollisions` and declines on.
 * `update_clip` has no collision check and no ripple, and bolting one onto a
 * generic property patcher would make its contract incoherent.
 *
 * Keyframes are deliberately left at their own times. They are stored in
 * timeline ms relative to the clip's start, so speeding a clip up leaves its
 * animation running past the new end. Rescaling them is a defensible choice
 * and so is not rescaling them; there is no UI precedent either way, and
 * silently rewriting curves the user authored is the worse failure. The tool
 * description says which one this is.
 */

import type { TimelineElement } from "../../@types/timeline";
import { isDynamicElement, spanOf, speedOf } from "./geometry";
import { findCollisions } from "./overlap";
import { clipsOnTrack, normalizeDocument, type TimelineDocument } from "./tracks";

/** The range the UI would offer, if it had a speed control. */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

/** Below this, a difference in span is not worth an undo step. */
const EPSILON_MS = 0.5;

/**
 * Set one clip's playback rate.
 *
 * Returns the document unchanged, **by identity**, when the clip is missing,
 * carries no source window, the speed is out of range or unchanged, or the new
 * span would overlap a neighbour and `ripple` is off.
 */
export function setClipSpeed(
  doc: TimelineDocument,
  elementId: string,
  speed: number,
  options: { ripple?: boolean } = {},
): TimelineDocument {
  const element = doc.elements[elementId];
  if (element == null || !isDynamicElement(element)) {
    return doc;
  }

  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
    return doc;
  }

  const current = speedOf(element);
  if (Math.abs(current - speed) < 1e-9) {
    return doc;
  }

  const before = spanOf(element);
  const newLength = element.duration / speed;
  const delta = newLength - before.length;

  if (Math.abs(delta) < EPSILON_MS) {
    return doc;
  }

  const resized = { ...element, speed } as TimelineElement;
  const newEnd = before.start + newLength;

  const ripple = options.ripple === true;

  if (!ripple) {
    const withResized = { ...doc.elements, [elementId]: resized };
    const collisions = findCollisions(
      { ...doc, elements: withResized },
      element.trackId,
      { start: before.start, end: newEnd },
      [elementId],
    );
    if (collisions.length > 0) {
      return doc;
    }
    return normalizeDocument({ ...doc, elements: withResized });
  }

  // Lane-local, exactly like `rippleDelete`: only clips after this one on the
  // same track move, and only by the amount this clip grew or shrank. A
  // magnetic timeline that pulled every track along would be a different
  // feature, and not one this editor has anywhere else.
  const elements: Record<string, TimelineElement> = {
    ...doc.elements,
    [elementId]: resized,
  };

  for (const [id, clip] of clipsOnTrack(doc, element.trackId)) {
    if (id === elementId) {
      continue;
    }
    if (spanOf(clip).start < before.end) {
      continue;
    }
    elements[id] = {
      ...clip,
      startTime: Math.max(0, clip.startTime + delta),
    } as TimelineElement;
  }

  return normalizeDocument({ ...doc, elements });
}
