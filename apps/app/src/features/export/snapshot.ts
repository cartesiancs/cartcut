/**
 * What an export reads, detached from what the user is editing.
 *
 * The export's frame loop runs in the editor's own renderer and takes seconds
 * to minutes. Now that the progress modal no longer covers the window, the
 * document underneath it can change while it runs — which is the point of the
 * feature — so the loop has to be reading something the editor cannot reach.
 *
 * Most of that is free: `useTimelineStore` is immutable at the map level and
 * every pure op returns new element objects, so the click-time reference is
 * already a snapshot for anything that goes through `withCheckpoint`. These
 * two functions close the gaps that do not.
 */

import type { Timeline } from "../../@types/timeline";
import type { RenderOptions } from "../../states/renderOptionStore";
import type { ExportOptions } from "./types";

/**
 * The element map this export will draw.
 *
 * A shallow clone of the map **and of each element**, and deliberately not one
 * level deeper. `animation`, `filter`, `mask` and `lut` are safe to share by
 * reference because nothing mutates them in place, and cloning them would not
 * be safe at all: a baked lane runs to 36,000 samples per property, so a deep
 * clone of a real project is hundreds of megabytes allocated on the click that
 * starts an export.
 *
 * The element-level copy defends against the two places that still write a
 * field onto a live element rather than returning a new one:
 *
 *  - `element/elementTimeline.ts#patchElementInTimeline` sets `.blob`
 *  - `option/optionImage.ts` sets `.localpath` on a background removal
 *
 * The second is the dangerous one. The export resolves an image through
 * `_loadedImage[element.localpath]`, so a background removal mid-render would
 * make that clip vanish from the delivered file with nothing reporting it.
 */
export function snapshotTimeline(timeline: Timeline): Timeline {
  const snapshot: Timeline = {};
  for (const id of Object.keys(timeline)) {
    snapshot[id] = { ...timeline[id] };
  }
  return snapshot;
}

/**
 * The options this export will run with.
 *
 * `previewSize` and `exportSettings` are copied out because `ControlSetting`
 * edits the live objects in place before calling `updateOptions` — its own
 * setter's doc comment says so — and this object outlives the click by the
 * whole length of the render.
 *
 * `videoDuration` and `videoBitrate` are the legacy aliases `ffmpegArgs` still
 * reads; they are derived here rather than at the call site so there is one
 * place that knows which store field each one shadows.
 */
export function snapshotExportOptions(
  options: RenderOptions,
  videoDestination: string,
): ExportOptions {
  return {
    ...options,
    previewSize: { ...options.previewSize },
    exportSettings: { ...options.exportSettings },
    videoDestination,
    videoDuration: options.duration,
    videoBitrate: options.exportSettings.videoBitrate,
  };
}
