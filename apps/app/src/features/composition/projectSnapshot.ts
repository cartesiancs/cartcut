/**
 * The project as it would be saved or exported, whichever timeline is showing.
 *
 * The one place that answers "the project" rather than "the timeline being
 * edited". The store's `timeline`/`tracks` and the render options'
 * `previewSize` describe the timeline being edited, which is what the editor
 * and its hundred-odd readers want. The save, Auto Save, the dirty digest,
 * the recovery guard and the export want the project, and read it here: main's
 * document, the compositions main names, and the project's own frame.
 */

import {
  renderOptionStore,
  type RenderOptions,
} from "../../states/renderOptionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { projectOfState } from "../../states/timelineWorkspace";
import type { TimelineTrack } from "../timeline/tracks";
import { parkedMainFrame } from "./mainFrame";
import { allTracksOf, savedProject, type ProjectTimelines } from "./project";

/** The render options with the project's frame, not a composition's. */
export function projectRenderOptions(): RenderOptions {
  const options = renderOptionStore.getState().options;
  const frame = parkedMainFrame();
  return frame == null ? options : { ...options, previewSize: { ...frame } };
}

export type ProjectSnapshot = {
  /** Main and only the compositions it names: what a save writes. */
  project: ProjectTimelines;
  options: RenderOptions;
  /** Every row in `project`, main's first, for the per-row view state. */
  tracks: TimelineTrack[];
};

export function projectSnapshot(): ProjectSnapshot {
  const project = savedProject(projectOfState(useTimelineStore.getState()));
  return {
    project,
    options: projectRenderOptions(),
    tracks: allTracksOf(project),
  };
}
