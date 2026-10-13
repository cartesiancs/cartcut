/**
 * A template's own timeline cannot hold a template.
 *
 * The renderer composites a template one level deep and strips anything
 * deeper (`template/compose.ts#bakeFills`), so a template placed inside one
 * would show in its own tab and vanish from main, and a composition naming
 * itself would recurse. The rule is held where a template is placed, with a
 * message, rather than by the store refusing an edit: a refusal there would
 * reach an agent as a success that changed nothing, and would also refuse
 * every later edit of a composition that somehow held one.
 */

import type { TimelineElement } from "../../@types/timeline";
import { MAIN_TIMELINE } from "./project";

export const NESTED_TEMPLATE_MESSAGE =
  "A template cannot be placed inside another template.";

/** Whether a template may be placed in this timeline. */
export function canHoldTemplates(timelineId: string): boolean {
  return timelineId === MAIN_TIMELINE;
}

/**
 * Clipboard contents without their template clips, and how many were left
 * out. The input by identity when there were none.
 */
export function withoutTemplateClips<T extends Record<string, TimelineElement>>(
  clips: T,
): { clips: T; dropped: number } {
  const ids = Object.keys(clips).filter((id) => clips[id]?.filetype === "template");
  if (ids.length === 0) {
    return { clips, dropped: 0 };
  }
  const kept = { ...clips };
  for (const id of ids) {
    delete kept[id];
  }
  return { clips: kept, dropped: ids.length };
}
