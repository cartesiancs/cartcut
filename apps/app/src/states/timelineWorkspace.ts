/**
 * How the timeline store holds a project of several timelines.
 *
 * **The timeline being edited lives in exactly one place.** `timeline` and
 * `tracks` are the active timeline, as they always were, and every one of the
 * hundred-odd modules that reads them reads the active timeline without
 * knowing others exist. Every other timeline is *parked* under its id in
 * `parked`, and `parked` never has the active id as a key. Nothing is kept in
 * two places, so nothing can disagree with itself; the whole project, when
 * something needs it, is `projectOfState`, which lays the live timeline over
 * the parked ones.
 *
 * Composition **meta** (name, size, where it came from) is complete in
 * `compositions` whichever timeline is active, because it is small and never
 * edited by the timeline UI.
 *
 * Pure: these take and return plain values. The store composes them.
 */

import type { Timeline } from "../@types/timeline";
import { compositionTemplateData } from "../features/composition/templateData";
import type { TemplateData } from "../features/template/compose";
import {
  MAIN_TIMELINE,
  isProjectTemplateId,
  projectTemplateId,
  referencedCompositionIds,
  type Composition,
  type CompositionMeta,
  type ProjectTimelines,
  type TimelineContent,
} from "../features/composition/project";
import type { TimelineTrack } from "../features/timeline/tracks";

/** The part of the store's state this module reads and writes. */
export type WorkspaceState = {
  timeline: Timeline;
  tracks: TimelineTrack[];
  activeTimelineId: string;
  parked: Record<string, TimelineContent>;
  compositions: Record<string, CompositionMeta>;
};

/**
 * One undo step: the whole project after an edit.
 *
 * `tracks`/`elements` are the timeline that was active when it was recorded,
 * under the names they always had, so a project with no compositions records
 * exactly the two fields it always did and every reader of an entry keeps
 * working. The three optional fields are the rest of the project; absent
 * means "main was active and there was nothing else", which is how an entry
 * written that way is read back.
 */
export type HistoryEntry = {
  tracks: TimelineTrack[];
  elements: Timeline;
  active?: string;
  parked?: Record<string, TimelineContent>;
  compositions?: Record<string, CompositionMeta>;
};

export const NO_PARKED: Record<string, TimelineContent> = Object.freeze(
  {},
) as Record<string, TimelineContent>;
export const NO_COMPOSITIONS: Record<string, CompositionMeta> = Object.freeze(
  {},
) as Record<string, CompositionMeta>;

export function liveContent(state: WorkspaceState): TimelineContent {
  return { tracks: state.tracks, elements: state.timeline };
}

/** A timeline's content wherever it lives, or `null` for no such timeline. */
export function contentOfState(
  state: WorkspaceState,
  timelineId: string,
): TimelineContent | null {
  if (timelineId === state.activeTimelineId) {
    return liveContent(state);
  }
  return state.parked[timelineId] ?? null;
}

/** Whether a project in this state has anything beyond its main timeline. */
export function isSingleTimeline(state: WorkspaceState): boolean {
  return (
    state.activeTimelineId === MAIN_TIMELINE &&
    Object.keys(state.compositions).length === 0
  );
}

/** The whole project: the live timeline laid over the parked ones. */
export function projectOfState(state: WorkspaceState): ProjectTimelines {
  const compositions: Record<string, Composition> = {};
  for (const id of Object.keys(state.compositions)) {
    const content = contentOfState(state, id);
    if (content == null) {
      continue;
    }
    compositions[id] = {
      ...state.compositions[id],
      tracks: content.tracks,
      elements: content.elements,
    };
  }
  return {
    main: contentOfState(state, MAIN_TIMELINE) ?? { tracks: [], elements: {} },
    compositions,
  };
}

function sameMeta(a: CompositionMeta, b: CompositionMeta): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.size.w === b.size.w &&
    a.size.h === b.size.h &&
    a.source?.templateId === b.source?.templateId &&
    a.source?.name === b.source?.name
  );
}

function metaOf(composition: Composition): CompositionMeta {
  return {
    id: composition.id,
    name: composition.name,
    size: { w: composition.size.w, h: composition.size.h },
    ...(composition.source == null
      ? {}
      : {
          source: {
            templateId: composition.source.templateId,
            name: composition.source.name,
          },
        }),
  };
}

/**
 * A project back in the store's shape, with `preferredActive` live.
 *
 * The preferred timeline is kept when the project still has it and main is
 * taken otherwise: undoing past the Expand that created a composition, while
 * looking at it, lands on main.
 *
 * Objects are reused wherever nothing changed, so a subscriber comparing
 * `parked` or `compositions` by identity is woken only by a real change:
 * a parked content whose two arrays are the ones already parked keeps its
 * wrapper, and a meta equal field for field keeps its object.
 */
export function stateOfProject(
  project: ProjectTimelines,
  preferredActive: string,
  previous: Pick<WorkspaceState, "parked" | "compositions">,
): Pick<
  WorkspaceState,
  "timeline" | "tracks" | "activeTimelineId" | "parked" | "compositions"
> {
  const active =
    preferredActive === MAIN_TIMELINE ||
    project.compositions[preferredActive] == null
      ? MAIN_TIMELINE
      : preferredActive;

  const reuse = (id: string, content: TimelineContent): TimelineContent => {
    const held = previous.parked[id];
    return held != null &&
      held.tracks === content.tracks &&
      held.elements === content.elements
      ? held
      : { tracks: content.tracks, elements: content.elements };
  };

  const ids = Object.keys(project.compositions);
  const parked: Record<string, TimelineContent> = {};
  let parkedCount = 0;
  if (active !== MAIN_TIMELINE) {
    parked[MAIN_TIMELINE] = reuse(MAIN_TIMELINE, project.main);
    parkedCount += 1;
  }
  const compositions: Record<string, CompositionMeta> = {};
  let metaChanged = ids.length !== Object.keys(previous.compositions).length;
  for (const id of ids) {
    const composition = project.compositions[id];
    const held = previous.compositions[id];
    const meta = held != null && sameMeta(held, composition) ? held : metaOf(composition);
    if (meta !== held) {
      metaChanged = true;
    }
    compositions[id] = meta;
    if (id !== active) {
      parked[id] = reuse(id, composition);
      parkedCount += 1;
    }
  }

  const live =
    active === MAIN_TIMELINE ? project.main : project.compositions[active];

  const parkedSame =
    parkedCount === Object.keys(previous.parked).length &&
    Object.keys(parked).every((id) => parked[id] === previous.parked[id]);

  return {
    timeline: live.elements,
    tracks: live.tracks,
    activeTimelineId: active,
    parked:
      parkedSame ? previous.parked : parkedCount === 0 ? NO_PARKED : parked,
    compositions: !metaChanged
      ? previous.compositions
      : ids.length === 0
        ? NO_COMPOSITIONS
        : compositions,
  };
}

/** The undo step for this state. */
export function entryOfState(state: WorkspaceState): HistoryEntry {
  if (isSingleTimeline(state)) {
    return { tracks: state.tracks, elements: state.timeline };
  }
  return {
    tracks: state.tracks,
    elements: state.timeline,
    active: state.activeTimelineId,
    parked: state.parked,
    compositions: state.compositions,
  };
}

/** The project an undo step holds. */
export function projectOfEntry(entry: HistoryEntry): ProjectTimelines {
  return projectOfState({
    timeline: entry.elements,
    tracks: entry.tracks,
    activeTimelineId: entry.active ?? MAIN_TIMELINE,
    parked: entry.parked ?? NO_PARKED,
    compositions: entry.compositions ?? NO_COMPOSITIONS,
  });
}

/** Main's element map, wherever main is. */
export function mainElementsOf(state: WorkspaceState): Timeline {
  return contentOfState(state, MAIN_TIMELINE)?.elements ?? {};
}

/**
 * The tabs to draw, in order: main, then each opened composition that still
 * exists and that main still names, then the active one if it is neither.
 *
 * Derived on every read rather than kept tidy by every writer. Deleting the
 * last clip that names a composition takes its tab away, and undoing the
 * delete brings it back, without any edit having to know tabs exist.
 */
export function visibleTimelineTabs(
  state: WorkspaceState & { openCompositionIds: string[] },
): string[] {
  const named = referencedCompositionIds(mainElementsOf(state));
  const out = [MAIN_TIMELINE];
  for (const id of state.openCompositionIds) {
    if (state.compositions[id] != null && named.has(id) && !out.includes(id)) {
      out.push(id);
    }
  }
  if (!out.includes(state.activeTimelineId)) {
    out.push(state.activeTimelineId);
  }
  return out;
}

/**
 * A composition as the template renderer reads one, or `null`.
 *
 * Stable by identity while its content is (`templateData.ts`), so the
 * renderer's memo holds across frames.
 */
export function compositionDataOf(
  state: WorkspaceState,
  compositionId: string,
): TemplateData | null {
  const meta = state.compositions[compositionId];
  const content = contentOfState(state, compositionId);
  if (meta == null || content == null) {
    return null;
  }
  return compositionTemplateData(meta, content);
}

/**
 * A resolver that answers every composition as it stands now, and keeps
 * answering that after the store moves on. Anything else goes to `installed`.
 *
 * What an export and a contact sheet draw templates from: the project as it
 * was when they began (`renderer/template.ts#withTemplateResolver`).
 */
export function snapshotTemplateResolver(
  state: WorkspaceState,
  installed: (templateId: string) => TemplateData | null,
): (templateId: string) => TemplateData | null {
  const captured = new Map<string, TemplateData>();
  for (const id of Object.keys(state.compositions)) {
    const data = compositionDataOf(state, id);
    if (data != null) {
      captured.set(projectTemplateId(id), data);
    }
  }
  return (templateId) =>
    isProjectTemplateId(templateId)
      ? (captured.get(templateId) ?? null)
      : installed(templateId);
}
