import type { Timeline, VisualTimelineElement } from "../../@types/timeline";
import { spanOf } from "../timeline/geometry";
import { isTimeInRange } from "../../utils/time";

/**
 * Whether an element covers `timeInMs`.
 *
 * Visibility depends ONLY on timeline position, never on `trim`, which
 * addresses the source file — see `features/timeline/geometry.ts` for why three
 * subsystems used to disagree about that.
 *
 * `timeline` is no longer read. It is still in the signature because text used
 * to carry a `parentKey` and render at `parent.startTime + own.startTime`, so
 * placing a clip meant consulting its neighbours. Captions now sit on a text
 * track holding absolute times like everything else, so every clip answers for
 * itself; the parameter stays so this change does not also churn a dozen call
 * sites.
 */
export function isElementVisibleAtTime(
  timeInMs: number,
  _timeline: Timeline,
  element: VisualTimelineElement,
): boolean {
  const { start, end } = spanOf(element);
  return isTimeInRange(timeInMs, start, end);
}
