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
 */

import type { Timeline } from "../../@types/timeline";
import { loadFontLibrary } from "../font/fontLibrary";
import { preloadLutsForDocument } from "../lut/lutRegistry";
import { assetTimeline } from "../template/assetTimeline";
import { preloadTemplatesForDocument } from "../template/templateRegistry";

export async function preloadForComposite(timeline: Timeline): Promise<Timeline> {
  await preloadTemplatesForDocument(timeline);
  const expanded = assetTimeline(timeline);
  await Promise.all([preloadLutsForDocument(expanded), loadFontLibrary()]);
  return expanded;
}
