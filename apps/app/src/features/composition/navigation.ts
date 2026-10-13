/**
 * Moving between timelines, from the UI.
 *
 * The store's `switchTimeline` is the mechanism; this is the doorway every
 * user-facing path goes through, so the two things that must come first
 * always do:
 *
 *  - **Refused while the caption session holds the timeline.** The session
 *    paints a projection of its own baseline onto whatever timeline is live,
 *    so a switch under it would have it paint over the other one.
 *  - **Every gesture still held is ended first** (`gestureCancel.ts`), while
 *    the timeline it belongs to is still the live one.
 */

import { useTimelineStore, type TimelineView } from "../../states/timelineStore";
import { cancelActiveGestures } from "../editor/gestureCancel";
import { refusesEdit } from "../editor/timelineLock";
import { MAIN_TIMELINE } from "./project";

/** Show `timelineId`. Answers whether the switch was allowed. */
export function requestTimelineSwitch(
  timelineId: string,
  firstView?: Partial<TimelineView>,
): boolean {
  if (refusesEdit()) {
    return false;
  }
  cancelActiveGestures();
  useTimelineStore.getState().switchTimeline(timelineId, firstView);
  return true;
}

/** Close a template's tab. Its timeline stays in the project. */
export function requestCloseTimelineTab(timelineId: string): void {
  if (timelineId === MAIN_TIMELINE) {
    return;
  }
  if (useTimelineStore.getState().activeTimelineId === timelineId) {
    if (refusesEdit()) {
      return;
    }
    cancelActiveGestures();
  }
  useTimelineStore.getState().closeTimelineTab(timelineId);
}
