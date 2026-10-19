/**
 * Everything a composite needs loaded before its first frame, in one place.
 *
 * The export did this inline and the contact sheet did none of it, so an
 * agent's contact sheet could show a template as empty space and a graded clip
 * ungraded while the exported file showed both. Shared now, so a frame looks the
 * same in the sheet as in the file.
 *
 * Templates first: their contents are what the expanded map holds, and the
 * LUTs a template's clips name are only visible after expansion.
 *
 * Then every face a text clip names. A canvas asked for a family that has not
 * loaded draws the fallback without a word, and the preview only ever loaded
 * the faces at the playhead, so a clip later in the timeline came out of the
 * export in the wrong typeface for its first frames.
 */

import type { Timeline } from "../../@types/timeline";
import { documentFontEntries, faceReady } from "../font/fontFaces";
import { loadFontLibrary } from "../font/fontLibrary";
import { preloadLutsForDocument } from "../lut/lutRegistry";
import { assetTimeline } from "../template/assetTimeline";
import type { TemplateResolver } from "../renderer/template";
import {
  preloadTemplatesForDocument,
  templateFor,
} from "../template/templateRegistry";

export async function preloadForComposite(
  timeline: Timeline,
  resolve: TemplateResolver = templateFor,
): Promise<Timeline> {
  await preloadTemplatesForDocument(timeline);
  const expanded = assetTimeline(timeline, resolve);
  await Promise.all([
    preloadLutsForDocument(expanded),
    loadFontLibrary(),
    ...documentFontEntries(expanded).map(faceReady),
  ]);
  return expanded;
}
