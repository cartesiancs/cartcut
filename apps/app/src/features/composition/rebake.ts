/**
 * A frame-rate change reaching every timeline in the project.
 *
 * `frameRate.ts#setProjectFps` used to re-bake the one document the store held.
 * With compositions parked beside it, that left every other timeline's lanes
 * at the old rate. Pure, and identity when nothing needed it.
 */

import { rebakeAnimations } from "../animation/keyframeOps";
import { SCHEMA_VERSION } from "../timeline/tracks";
import type { Composition, ProjectTimelines, TimelineContent } from "./project";

function rebaked<T extends TimelineContent>(content: T, hz: number): T {
  const doc = { schemaVersion: SCHEMA_VERSION, ...content };
  const next = rebakeAnimations(doc, hz);
  return next === doc ? content : { ...content, elements: next.elements };
}

export function rebakeProject(
  project: ProjectTimelines,
  hz: number,
): ProjectTimelines {
  const main = rebaked(project.main, hz);
  let compositions = project.compositions;
  for (const id of Object.keys(project.compositions)) {
    const next = rebaked<Composition>(project.compositions[id], hz);
    if (next !== project.compositions[id]) {
      if (compositions === project.compositions) {
        compositions = { ...compositions };
      }
      compositions[id] = next;
    }
  }
  if (main === project.main && compositions === project.compositions) {
    return project;
  }
  return { main, compositions };
}
