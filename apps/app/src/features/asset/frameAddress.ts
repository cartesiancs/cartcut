/**
 * Which source instant an export frame shows, for every decoder.
 *
 * Two decoders place a clip for a frame: the `<video>` seek in
 * `loadedAssetStore.ts#seekHandles` (the desktop export, the contact sheet) and
 * the WebCodecs cursor in `webMedia/webFrameSource.ts` (the browser export).
 * Both ask these two functions, so the two cannot pick different frames.
 *
 * DOM-free, so both rules run under `environment: "node"`.
 */

import {
  isVisualTimelineElement,
  type Timeline,
  type VideoElementType,
} from "../../@types/timeline";
import { isElementVisibleAtTime } from "../element/time";
import { sourceTimeAtFrame } from "../timeline/frames";
import { sourceBoundsSec } from "../timeline/playback";
import { isVisibleThroughTransition } from "../timeline/transitionWindow";

/**
 * Whether `elementId` is on screen at `time`, and so needs a frame decoded.
 *
 * The *unbiased* instant. Visibility is a question about the timeline moment,
 * and asking it half a frame late would let a clip appear or vanish one frame
 * off. Only the address inside a visible clip moves.
 */
export function needsFrameAt(
  timeline: Timeline,
  elementId: string,
  time: number,
): boolean {
  const element = timeline[elementId];
  return (
    element != null &&
    isVisualTimelineElement(element) &&
    isElementVisibleAtTime(time, timeline, element)
  );
}

/**
 * The source second a frame of `element` at timeline `time` shows.
 *
 * Deliberately NOT clamped to the trim window. Inside a transition this clip is
 * being asked for frames past its out-point, or before its in-point, which is
 * the whole mechanism. `sourceTimeAt` extrapolates there because a speed ramp
 * holds its end values outside its outermost points and an unramped clip is
 * linear everywhere; `maxTransitionMs` already guarantees the frames exist in
 * the file.
 *
 * The half-frame goes in on the *timeline* side of `sourceTimeAt`, not after
 * it. That is what makes it correct for a retimed clip: the conversion carries
 * timeline ms into source ms, so a 2x clip needs two source frames of offset
 * per timeline frame and a 0.25x clip a quarter of one. Adding a fixed offset
 * to the source time instead would be right only at speed 1, and on a ramped
 * clip it would be right nowhere, since the factor changes across the clip.
 *
 * Bounded exactly as `playback.ts#intentFor` bounds it, so the two paths cannot
 * disagree about the last frame of a clip. Widened to the whole file while a
 * transition is holding this clip, which is the case the unbounded version
 * existed for.
 */
export function frameAddressSec(
  element: VideoElementType,
  timeline: Timeline,
  time: number,
  fps: number,
): number {
  const [low, high] = sourceBoundsSec(
    element,
    isVisibleThroughTransition(time, timeline, element),
  );
  return Math.min(Math.max(sourceTimeAtFrame(element, time, fps) / 1000, low), high);
}
