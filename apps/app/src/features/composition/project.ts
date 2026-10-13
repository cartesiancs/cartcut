/**
 * A project as several timelines: the main one, and the templates it owns.
 *
 * A placed `template` element normally names an installed `.cttpl` by its
 * folder id, and its contents belong to the template's author. Expanding one
 * (`expandTemplate.ts`) forks those contents into the project as a
 * **composition**: a timeline of its own, edited with the same timeline UI,
 * saved in the `.ngt`, and named from the element as
 * `templateId: "project:<compositionId>"`. The model is a folder: a
 * composition is a folder holding a timeline, and every template element that
 * names it is a reference to that folder.
 *
 * Code says "composition" for the project-owned copy so it never reads as the
 * installed kind. The UI still says "Template".
 *
 * Everything here is pure, DOM-free and store-free, so it runs in the `node`
 * suite. The store (`states/timelineStore.ts`) holds a `ProjectTimelines` in a
 * different shape (the timeline being edited is live, the rest are parked)
 * and converts through `projectOf`.
 */

import type {
  TemplateElementType,
  Timeline,
  TimelineElement,
} from "../../@types/timeline";
import { spanEnd } from "../timeline/geometry";
import type { TimelineTrack } from "../timeline/tracks";

/** The id of the project's own timeline. Never a composition id. */
export const MAIN_TIMELINE = "main";

/**
 * The `templateId` prefix that names a composition rather than an installed
 * folder.
 *
 * `electron/lib/templateScan.ts` refuses an installed folder whose name starts
 * with it, so the two namespaces cannot collide; its copy of the string is
 * pinned against this one by `templateScan.test.ts`.
 */
export const PROJECT_TEMPLATE_PREFIX = "project:";

export type TimelineContent = {
  tracks: TimelineTrack[];
  elements: Timeline;
};

/**
 * What a composition is, apart from its content.
 *
 * Its **length is not stored**. It is the extent of its content, the rule an
 * installed template already follows (`templateDocument.ts#templateDurationOf`),
 * so a composition saved back out as a `.cttpl` is as long installed as it was
 * in the project.
 */
export type CompositionMeta = {
  id: string;
  /** The tab's label. Starts as the template's name. */
  name: string;
  /** The frame its document is composed at, as an installed template's `size`. */
  size: { w: number; h: number };
  /** The installed template it was forked from, for the record. */
  source?: { templateId: string; name: string };
};

export type Composition = CompositionMeta & TimelineContent;

export type ProjectTimelines = {
  main: TimelineContent;
  compositions: Record<string, Composition>;
};

export function isProjectTemplateId(templateId: unknown): boolean {
  return (
    typeof templateId === "string" &&
    templateId.startsWith(PROJECT_TEMPLATE_PREFIX) &&
    templateId.length > PROJECT_TEMPLATE_PREFIX.length
  );
}

export function projectTemplateId(compositionId: string): string {
  return `${PROJECT_TEMPLATE_PREFIX}${compositionId}`;
}

/** The composition a template element names, or `null` for an installed one. */
export function compositionIdOf(templateId: unknown): string | null {
  return isProjectTemplateId(templateId)
    ? (templateId as string).slice(PROJECT_TEMPLATE_PREFIX.length)
    : null;
}

/** The composition this element names, or `null`. */
export function compositionOfElement(
  element: TimelineElement | null | undefined,
): string | null {
  if (element?.filetype !== "template") {
    return null;
  }
  return compositionIdOf((element as TemplateElementType).templateId);
}

/** Every composition `elements` names, in key order. */
export function referencedCompositionIds(elements: Timeline): Set<string> {
  const out = new Set<string>();
  for (const id of Object.keys(elements)) {
    const compositionId = compositionOfElement(elements[id]);
    if (compositionId != null) {
      out.add(compositionId);
    }
  }
  return out;
}

/**
 * How long a composition runs: the end of its last clip.
 *
 * `templateDocument.ts#templateDurationOf` with no render-options fallback,
 * because a composition has none: an empty one is zero long, and
 * `reconcile.ts` declines to shrink a bar to that.
 */
export function compositionExtentMs(elements: Timeline): number {
  let end = 0;
  for (const element of Object.values(elements)) {
    if (element == null || typeof element !== "object") {
      continue;
    }
    end = Math.max(end, spanEnd(element));
  }
  return end;
}

/** Every track in the project: main's, then each composition's in id order. */
export function allTracksOf(project: ProjectTimelines): TimelineTrack[] {
  const out = [...project.main.tracks];
  for (const id of Object.keys(project.compositions).sort()) {
    out.push(...project.compositions[id].tracks);
  }
  return out;
}

/**
 * The project as it would be written: compositions main does not name are
 * left out.
 *
 * An unreferenced composition is kept in memory, because the undo history can
 * bring its reference back, and is not saved, because a reloaded project has
 * no history to bring it back with.
 */
export function savedProject(project: ProjectTimelines): ProjectTimelines {
  const referenced = referencedCompositionIds(project.main.elements);
  const ids = Object.keys(project.compositions);
  if (ids.every((id) => referenced.has(id))) {
    return project;
  }
  const compositions: Record<string, Composition> = {};
  for (const id of ids) {
    if (referenced.has(id)) {
      compositions[id] = project.compositions[id];
    }
  }
  return { ...project, compositions };
}
