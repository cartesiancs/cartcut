/**
 * Element-level editing primitives: trim and split, as pure functions.
 *
 * Every one of these returns a fresh element (nested `trim` included) and
 * preserves the source-window invariant from `geometry.ts`:
 *
 *   duration === trim.endTime - trim.startTime
 *
 * That coupling is the whole point. The old trim handles in
 * `elementTimelineCanvas` wrote `trim` and nothing else, so `duration` stayed
 * at the full source length and the export happily emitted the untrimmed clip.
 * Splitting had the same shape of bug: it adjusted `trim` without moving
 * `startTime`, so both halves drew a full-width bar at the same x and could
 * only be told apart by which shoulder was shaded — which is exactly why a cut
 * needed a second row to be visible at all.
 *
 * `clipOps` (document level) builds on these; keeping them separate means the
 * arithmetic can be tested without a track model around it.
 */

import type { TimelineElement } from "../../@types/timeline";
import {
  MIN_SOURCE_MS,
  MIN_TIMELINE_MS,
  isDynamicElement,
  sourceDurationOf,
  spanLength,
  speedOf,
  type DynamicElement,
} from "./geometry";
import { rebaseAnimation, sliceAnimation } from "../animation/keyframes";

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function withTrim<T extends DynamicElement>(
  element: T,
  startTime: number,
  duration: number,
  trimStart: number,
  trimEnd: number,
): T {
  return {
    ...element,
    startTime,
    duration,
    trim: { startTime: trimStart, endTime: trimEnd },
  };
}

/**
 * Drag the clip's left edge by `deltaMs` of **timeline** time.
 *
 * Positive shortens from the left. The move is clamped by three things at
 * once: the start of the source file, the start of the timeline, and the
 * minimum window — so the returned element is always valid, and a drag that
 * runs past a limit simply stops there instead of inverting the clip.
 */
export function trimStart(
  element: TimelineElement,
  deltaMs: number,
): TimelineElement {
  if (!isDynamicElement(element)) {
    const room = element.duration - MIN_TIMELINE_MS;
    const applied = clamp(deltaMs, -element.startTime, room);
    // Keyframe times are relative to `startTime`, so moving the left edge
    // without rebasing slides the whole animation against the content it was
    // drawn on. Rebase only — never slice: a trim is reversible, so a keyframe
    // pushed outside the visible window has to survive being pulled back in.
    return rebaseAnimation(
      {
        ...element,
        startTime: element.startTime + applied,
        duration: element.duration - applied,
      },
      applied,
    );
  }

  const speed = speedOf(element);
  const { startTime: srcStart, endTime: srcEnd } = element.trim;

  // Leftward travel is bounded by whichever runs out first: source head room,
  // or the timeline's own zero.
  const maxLeftSource = Math.min(srcStart, element.startTime * speed);
  const maxRightSource = srcEnd - srcStart - MIN_SOURCE_MS;
  const appliedSource = clamp(deltaMs * speed, -maxLeftSource, maxRightSource);

  const nextSrcStart = srcStart + appliedSource;
  // `appliedSource` is source ms; the timeline edge moves by that over speed,
  // and keyframes live in timeline ms, so that is the rebase distance.
  return rebaseAnimation(
    withTrim(
      element,
      element.startTime + appliedSource / speed,
      srcEnd - nextSrcStart,
      nextSrcStart,
      srcEnd,
    ),
    appliedSource / speed,
  );
}

/**
 * Drag the clip's right edge by `deltaMs` of **timeline** time.
 *
 * Positive lengthens. A dynamic clip stops at the end of its source file —
 * which is what `sourceDuration` exists for. Before that field, `trim.endTime`
 * doubled as the source length and was destroyed by the first inward drag, so
 * a trim could never be undone by dragging back out.
 */
export function trimEnd(
  element: TimelineElement,
  deltaMs: number,
): TimelineElement {
  if (!isDynamicElement(element)) {
    const applied = Math.max(deltaMs, MIN_TIMELINE_MS - element.duration);
    return { ...element, duration: element.duration + applied };
  }

  const speed = speedOf(element);
  const { startTime: srcStart, endTime: srcEnd } = element.trim;

  const minSource = MIN_SOURCE_MS - (srcEnd - srcStart);
  const maxSource = sourceDurationOf(element) - srcEnd;
  const appliedSource = clamp(deltaMs * speed, minSource, maxSource);

  const nextSrcEnd = srcEnd + appliedSource;
  return withTrim(
    element,
    element.startTime,
    nextSrcEnd - srcStart,
    srcStart,
    nextSrcEnd,
  );
}

/**
 * Cut the clip at timeline time `atMs`.
 *
 * Returns `null` when the cut would produce an empty half, so callers can treat
 * "playhead sitting on a clip boundary" as a no-op rather than creating a
 * zero-length clip that is permanently invisible (spans are half-open).
 *
 * Both halves keep the element's `trackId`; the caller assigns the right half a
 * fresh id. Adjacency is exact — `left` ends precisely where `right` begins —
 * which is what lets the two pieces sit side by side on one track and be
 * rejoined without drift.
 */
export function splitAt(
  element: TimelineElement,
  atMs: number,
): { left: TimelineElement; right: TimelineElement } | null {
  const offset = atMs - element.startTime;
  if (offset <= 0 || offset >= spanLength(element)) {
    return null;
  }

  // `offset` is timeline ms and so are keyframe times, so the same window
  // serves both branches — the source-ms `cut` below is the wrong measure for
  // animation and using it here would misplace every keyframe on a sped-up clip.
  const span = spanLength(element);

  if (!isDynamicElement(element)) {
    return {
      left: sliceAnimation({ ...element, duration: offset }, 0, offset),
      right: rebaseAnimation(
        sliceAnimation(
          {
            ...element,
            startTime: element.startTime + offset,
            duration: element.duration - offset,
          },
          offset,
          span,
        ),
        offset,
      ),
    };
  }

  const speed = speedOf(element);
  const { startTime: srcStart, endTime: srcEnd } = element.trim;
  const cut = srcStart + offset * speed;

  return {
    left: sliceAnimation(
      withTrim(element, element.startTime, cut - srcStart, srcStart, cut),
      0,
      offset,
    ),
    right: rebaseAnimation(
      sliceAnimation(
        withTrim(
          element,
          element.startTime + offset,
          srcEnd - cut,
          cut,
          srcEnd,
        ),
        offset,
        span,
      ),
      offset,
    ),
  };
}
