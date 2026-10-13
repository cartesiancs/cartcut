/**
 * "Expand Template": open a template clip's own timeline.
 *
 * The first time, the installed template behind the clip is forked into the
 * project (`fork.ts`) as one undo step, then its tab opens. After that the
 * clip names a composition, and expanding it opens that composition again.
 * Opening lands the template's playhead on the instant main's was showing,
 * so the picture does not jump.
 */

import { v4 as uuidv4 } from "uuid";
import type { TemplateElementType } from "../../@types/timeline";
import { useTimelineStore } from "../../states/timelineStore";
import { ensureUndoBaseline } from "../agent/checkpoint";
import { refusesEdit } from "../editor/timelineLock";
import { projectBakeHz } from "../editor/frameRate";
import { innerCursorOf } from "../renderer/template";
import { loadTemplate, templateFor } from "../template/templateRegistry";
import { forkTemplate } from "./fork";
import { requestTimelineSwitch } from "./navigation";
import {
  MAIN_TIMELINE,
  compositionIdOf,
  type ProjectTimelines,
} from "./project";

export type ExpandOutcome =
  | { ok: true; compositionId: string; forked: boolean }
  | { ok: false; reason: string };

function mainElement(elementId: string): TemplateElementType | null {
  const state = useTimelineStore.getState();
  const elements =
    state.activeTimelineId === MAIN_TIMELINE
      ? state.timeline
      : state.parked[MAIN_TIMELINE]?.elements;
  const element = elements?.[elementId];
  return element?.filetype === "template" ? (element as TemplateElementType) : null;
}

/** Where the template's own playhead should start, given main's. */
function firstCursor(element: TemplateElementType, templateId: string): number {
  const durationMs = templateFor(templateId)?.durationMs ?? element.duration;
  return innerCursorOf(element, useTimelineStore.getState().cursor, durationMs);
}

export async function expandTemplate(elementId: string): Promise<ExpandOutcome> {
  if (refusesEdit()) {
    return { ok: false, reason: "locked" };
  }
  const element = mainElement(elementId);
  if (element == null) {
    return { ok: false, reason: "That clip is not a template." };
  }

  const existing = compositionIdOf(element.templateId);
  if (existing != null) {
    if (useTimelineStore.getState().compositions[existing] == null) {
      return { ok: false, reason: "This template is not in the project." };
    }
    const cursor = firstCursor(element, element.templateId);
    requestTimelineSwitch(existing, { cursor });
    return { ok: true, compositionId: existing, forked: false };
  }

  const data = await loadTemplate(element.templateId);
  if (data == null) {
    return {
      ok: false,
      reason: `${element.name || "This template"} is not installed, so it cannot be opened.`,
    };
  }

  // Probed before anything is recorded, as `agent/commit.ts` does: the clip
  // may have changed or gone while the template loaded, and a decline must
  // cost nothing, not even an undo baseline.
  const compositionId = uuidv4();
  const fork = (project: ProjectTimelines) =>
    forkTemplate(project, elementId, data, {
      compositionId,
      idGen: uuidv4,
      bakeHz: projectBakeHz(),
    });
  const before = useTimelineStore.getState().getProject();
  if (fork(before) === before) {
    return { ok: false, reason: "That clip changed while the template loaded." };
  }

  const cursor = firstCursor(element, element.templateId);
  // What makes the Expand undoable straight after a project is opened, when
  // nothing has recorded the state it would undo back to.
  ensureUndoBaseline();
  useTimelineStore.getState().withProjectCheckpoint(fork);
  if (useTimelineStore.getState().compositions[compositionId] == null) {
    return { ok: false, reason: "That clip changed while the template loaded." };
  }
  requestTimelineSwitch(compositionId, { cursor });
  return { ok: true, compositionId, forked: true };
}
