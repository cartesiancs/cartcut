/**
 * What a contact sheet decodes: every video it will draw, and nothing else.
 *
 * The sheet owns its decoders, as the export does (`asset/videoScope.ts`). It
 * used to seek the preview's shared handles, and the preview repaints whenever
 * a graphic's raster lands, which is exactly what happens while an agent edits
 * a graphic and checks the result: each repaint put the handles back at the
 * playhead between the sheet's seek and its draw (measured: a four-frame sheet
 * differed from the same sheet taken in quiet by 67,148 pixels).
 *
 * A decoder costs a file open and a seek, so a video no requested instant
 * shows is left out. Visibility is `isElementVisibleAtTime`, the one the
 * compositor and the seek both use, so a clip a transition holds on screen
 * past its out-point is decoded too. Everything that is not a video is kept:
 * images and gifs go to the shared cache, keyed by path, where nothing can
 * move them.
 *
 * Pure, so the rule is tested without a document or a decoder.
 */

import { isVisualTimelineElement, type Timeline } from "../../../@types/timeline";
import { isElementVisibleAtTime } from "../../element/time";

export function sheetAssets(assets: Timeline, times: number[]): { assets: Timeline; videos: number } {
  const kept: Timeline = {};
  let videos = 0;
  for (const [id, element] of Object.entries(assets)) {
    if (element.filetype !== "video") {
      kept[id] = element;
      continue;
    }
    if (isVisualTimelineElement(element) && times.some((t) => isElementVisibleAtTime(t, assets, element))) {
      kept[id] = element;
      videos += 1;
    }
  }
  return { assets: kept, videos };
}
