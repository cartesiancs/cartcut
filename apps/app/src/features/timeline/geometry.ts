/**
 * The single source of truth for timeline geometry.
 *
 * Before this module the codebase held three incompatible readings of `trim`:
 *
 *   A. the canvas compositor (`renderer/video.ts`, `element/time.ts`) treated a
 *      clip as `[startTime, startTime + duration/speed)` and ignored `trim`,
 *      documenting it as an FFmpeg `-ss` offset;
 *   B. the timeline UI and the FFmpeg audio path treated it as
 *      `[startTime + trim.startTime, startTime + trim.endTime)`;
 *   C. `loadedAssetStore.seek` ignored `trim` altogether when seeking the
 *      `<video>`, so a trimmed clip previewed the wrong source frame.
 *
 * Reading A wins, and it is now an invariant rather than a convention:
 *
 *   - `trim` is a window into the **source file**, measured in source ms.
 *   - `duration` is that window's length, so
 *     `duration === trim.endTime - trim.startTime` for dynamic elements.
 *   - the clip occupies `[startTime, startTime + duration/speed)` on the
 *     timeline, which is the same shape static elements already had.
 *
 * Keeping both readings straight is what makes a Final Cut style split work:
 * the two halves differ in `trim` *and* in `startTime`/`duration`, so they land
 * side by side instead of on top of each other.
 */

import type {
  AudioElementType,
  TimelineElement,
  VideoElementType,
} from "../../@types/timeline";
import { elementUtils } from "../../utils/element";

/** Elements that carry a source window: video and audio. */
export type DynamicElement = VideoElementType | AudioElementType;

/** Shortest source window a trim may leave behind, in source ms. */
export const MIN_SOURCE_MS = 10;

/** Shortest timeline span a static element may be trimmed to, in ms. */
export const MIN_TIMELINE_MS = 10;

export function isDynamicElement(
  element: TimelineElement,
): element is DynamicElement {
  return elementUtils.getElementType(element.filetype) === "dynamic";
}

/**
 * Playback rate, guarded.
 *
 * `speed` is absent on hand-authored fixtures and a zero would turn every span
 * into `Infinity`, so anything non-positive falls back to real time.
 */
export function speedOf(element: TimelineElement): number {
  if (!isDynamicElement(element)) {
    return 1;
  }
  const speed = element.speed;
  return typeof speed === "number" && speed > 0 ? speed : 1;
}

/**
 * Full length of the source file in source ms.
 *
 * Older elements predate the field, and `trim.endTime` was what stood in for it
 * — which is why dragging a trim handle back outwards used to be impossible
 * once it had been dragged in.
 */
export function sourceDurationOf(element: TimelineElement): number {
  if (!isDynamicElement(element)) {
    return element.duration;
  }
  const declared = (element as DynamicElement).sourceDuration;
  if (typeof declared === "number" && declared > 0) {
    return declared;
  }
  return Math.max(element.trim.endTime, element.duration);
}

/** Timeline ms at which the clip begins. */
export function spanStart(element: TimelineElement): number {
  return element.startTime;
}

/**
 * How much timeline the clip covers, in ms.
 *
 * `duration` is source ms for dynamic elements and timeline ms for static ones,
 * so only the former is divided by `speed`.
 */
export function spanLength(element: TimelineElement): number {
  return isDynamicElement(element)
    ? element.duration / speedOf(element)
    : element.duration;
}

export function spanEnd(element: TimelineElement): number {
  return spanStart(element) + spanLength(element);
}

export function spanOf(element: TimelineElement): {
  start: number;
  end: number;
  length: number;
} {
  const start = spanStart(element);
  const length = spanLength(element);
  return { start, end: start + length, length };
}

/**
 * Source-file ms shown at timeline time `t`.
 *
 * This is the formula `loadedAssetStore` was missing: without the `trim`
 * term a trimmed clip seeks to the untrimmed frame.
 */
export function sourceTimeAt(element: DynamicElement, t: number): number {
  return element.trim.startTime + (t - element.startTime) * speedOf(element);
}

/**
 * The inverse of `sourceTimeAt`: where a given source frame lands on the
 * timeline.
 *
 * Needed wherever something is authored against the source file rather than
 * against the timeline — transcription being the obvious case, since a
 * speech-to-text pass timestamps the media, not the edit.
 */
export function timelineTimeAt(
  element: DynamicElement,
  sourceMs: number,
): number {
  return (
    element.startTime + (sourceMs - element.trim.startTime) / speedOf(element)
  );
}

/**
 * The three numbers FFmpeg needs for one dynamic element: where to seek in the
 * source, how much to take, and how far to delay it on the output timeline.
 */
export function ffmpegWindow(element: DynamicElement): {
  ssSec: number;
  tSec: number;
  delayMs: number;
} {
  return {
    ssSec: element.trim.startTime / 1000,
    tSec: element.duration / 1000,
    delayMs: element.startTime,
  };
}

/**
 * Signed px/ms conversion for layout.
 *
 * `utils/time.millisecondsToPx` clamps negatives to zero, which is right for
 * the ruler and wrong for clips: a clip scrolled halfway off the left edge
 * would be pinned to x=0 and drawn at the wrong width. Rounding is deliberately
 * omitted — callers round once, where a pixel is actually written, instead of
 * accumulating a pixel of drift per `px -> ms -> px` round trip during a drag.
 */
export function msToPxSigned(ms: number, timelineRange: number): number {
  return (ms / 5) * (timelineRange / 4);
}

export function pxToMsSigned(px: number, timelineRange: number): number {
  return (px * 5) / (timelineRange / 4);
}

/**
 * Development-time check that an element still satisfies the source-window
 * invariant. Editing ops call this so a broken write surfaces at its origin
 * rather than as a mis-timed frame three subsystems later.
 */
export function assertTrimInvariant(
  element: TimelineElement,
  context = "element",
): void {
  if (!isDynamicElement(element)) {
    return;
  }
  const window = element.trim.endTime - element.trim.startTime;
  if (Math.abs(window - element.duration) > 0.5) {
    throw new Error(
      `${context}: duration ${element.duration} does not match trim window ` +
        `${element.trim.startTime}..${element.trim.endTime} (${window})`,
    );
  }
}

/** Whether an element currently satisfies the invariant, without throwing. */
export function hasValidTrim(element: TimelineElement): boolean {
  try {
    assertTrimInvariant(element);
    return true;
  } catch {
    return false;
  }
}
