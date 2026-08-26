import type { Timeline, VisualTimelineElement } from "../../@types/timeline";
import { spanOf } from "../timeline/geometry";
import { isVisibleThroughTransition } from "../timeline/transitionWindow";
import { isTimeInRange } from "../../utils/time";

/**
 * Whether an element covers `timeInMs`.
 *
 * Visibility depends ONLY on timeline position, never on `trim`, which
 * addresses the source file — see `features/timeline/geometry.ts` for why three
 * subsystems used to disagree about that.
 *
 * `timeline` was dead for a while — text used to carry a `parentKey` and render
 * at `parent.startTime + own.startTime`, so placing a clip meant consulting its
 * neighbours, and captions moving to a text track made every clip answer for
 * itself. It is load-bearing again, for a different reason: a transition holds
 * the outgoing clip on screen past its out-point and the incoming clip before
 * its in-point, and only the document knows that.
 *
 * Widening it **here** rather than at each call site is the point. Three
 * subsystems ask this question — the compositor deciding what to paint,
 * `loadedAssetStore.seek` deciding which `<video>` to position, and
 * `playback.ts` deciding which handle should roll — and if any of them
 * disagreed, a transition would blend a frame nobody had seeked.
 */
export function isElementVisibleAtTime(
  timeInMs: number,
  timeline: Timeline,
  element: VisualTimelineElement,
): boolean {
  const { start, end } = spanOf(element);
  if (isTimeInRange(timeInMs, start, end)) {
    return true;
  }
  return isVisibleThroughTransition(timeInMs, timeline, element);
}
