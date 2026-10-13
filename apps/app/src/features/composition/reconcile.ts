/**
 * Keeping a template clip as long as the composition it names.
 *
 * A template clip's length belongs to the template (`geometry.ts#isDurationLocked`),
 * which for an installed one is fixed. A composition is edited, so its length
 * moves, and every clip naming it has to follow or it would cut the end off
 * (`renderer/template.ts#innerCursorOf` clamps) or run on blank.
 *
 * The rule:
 *  - only for compositions whose content changed in this edit. A clip clamped
 *    by a neighbour does not spring back because something else on the main
 *    timeline moved; it is re-fitted the next time its content changes.
 *  - shrinking always applies.
 *  - growing stops at the next clip on the same row. A neighbour is never
 *    moved: the edit happened in another timeline, and pushing clips the user
 *    cannot see from there would be an edit nobody asked for.
 *  - an empty composition (extent 0) leaves its clips as they are, or a clip
 *    would become a zero-length bar nothing can right-click to open again.
 *
 * Runs inside the same undo step as the edit that changed the composition,
 * which is the reason the project keeps one history.
 *
 * Pure, DOM-free and store-free. Returns its input by identity when no clip
 * changes.
 */

import type { Timeline, TimelineElement } from "../../@types/timeline";
import { occupiedIntervals } from "../timeline/overlap";
import { SCHEMA_VERSION, type TimelineDocument } from "../timeline/tracks";
import {
  compositionExtentMs,
  compositionOfElement,
  type ProjectTimelines,
} from "./project";

/** Where the next clip on this row starts, at or after `start`. */
function roomEnd(
  doc: TimelineDocument,
  trackId: string,
  start: number,
  ownId: string,
): number {
  let end = Infinity;
  for (const interval of occupiedIntervals(doc, trackId, [ownId])) {
    if (interval.start >= start && interval.start < end) {
      end = interval.start;
    }
  }
  return end;
}

export function reconcileTemplateSpans(
  project: ProjectTimelines,
  changedCompositionIds: Iterable<string>,
): ProjectTimelines {
  const changed = new Set(changedCompositionIds);
  if (changed.size === 0) {
    return project;
  }

  // Earliest first, so two clips of one composition on one row grow in turn
  // and the first never takes the second's room.
  const targets = Object.entries(project.main.elements)
    .filter(([, element]) => {
      const id = compositionOfElement(element);
      return id != null && changed.has(id) && project.compositions[id] != null;
    })
    .sort(([, a], [, b]) => (a.startTime || 0) - (b.startTime || 0));
  if (targets.length === 0) {
    return project;
  }

  let elements: Timeline = project.main.elements;
  let touched = false;
  for (const [id] of targets) {
    const element = elements[id];
    const composition = project.compositions[compositionOfElement(element)!];
    const natural = compositionExtentMs(composition.elements);
    if (!(natural > 0)) {
      continue;
    }
    const current = Number(element.duration) || 0;
    let duration = natural;
    if (natural > current) {
      const doc: TimelineDocument = {
        schemaVersion: SCHEMA_VERSION,
        tracks: project.main.tracks,
        elements,
      };
      const start = Number(element.startTime) || 0;
      duration = Math.max(
        current,
        Math.min(natural, roomEnd(doc, element.trackId, start, id) - start),
      );
    }
    if (duration === current) {
      continue;
    }
    if (!touched) {
      elements = { ...elements };
      touched = true;
    }
    elements[id] = { ...element, duration } as TimelineElement;
  }

  if (!touched) {
    return project;
  }
  return { ...project, main: { ...project.main, elements } };
}
