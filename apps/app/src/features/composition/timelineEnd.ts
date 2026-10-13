/**
 * Where the timeline being edited ends.
 *
 * Main ends where the project's length says (`renderOptions.duration`, set by
 * the user, the length an export runs to). A template the project owns has no
 * such setting: it is as long as its content (`project.ts#compositionExtentMs`),
 * the rule an installed template follows. So the three things that asked
 * "how long is the project" ask here instead:
 *
 *  - **the end marker** on the timeline: main's length, or the template's own,
 *    which is where the clip that places it ends;
 *  - **how far the timeline scrolls**: at least the project's length in a
 *    template too, so there is room past its last clip to make it longer;
 *  - **how long a new null is**: the whole of the timeline it lands in.
 *
 * The pure answers take their inputs; the store-reading ones are for the
 * components.
 */

import type { Timeline } from "../../@types/timeline";
import { renderOptionStore } from "../../states/renderOptionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { MAIN_TIMELINE, compositionExtentMs } from "./project";

export function timelineEndOf(
  activeTimelineId: string,
  live: Timeline,
  projectDurationSec: number,
): number {
  return activeTimelineId === MAIN_TIMELINE
    ? projectDurationSec * 1000
    : compositionExtentMs(live);
}

export function timelineScrollEndOf(
  activeTimelineId: string,
  live: Timeline,
  projectDurationSec: number,
): number {
  return Math.max(
    projectDurationSec * 1000,
    timelineEndOf(activeTimelineId, live, projectDurationSec),
  );
}

export function nullLengthOf(
  activeTimelineId: string,
  live: Timeline,
  projectDurationSec: number,
): number {
  const end = timelineEndOf(activeTimelineId, live, projectDurationSec);
  return end > 0 ? end : projectDurationSec * 1000;
}

function inputs(): [string, Timeline, number] {
  const state = useTimelineStore.getState();
  return [
    state.activeTimelineId,
    state.timeline,
    Number(renderOptionStore.getState().options.duration) || 0,
  ];
}

export const activeTimelineEndMs = () => timelineEndOf(...inputs());
export const activeTimelineScrollEndMs = () => timelineScrollEndOf(...inputs());
export const newNullLengthMs = () => nullLengthOf(...inputs());
