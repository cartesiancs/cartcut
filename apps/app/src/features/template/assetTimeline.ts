/**
 * The element map the *asset layer* works from.
 *
 * `loadedAssetStore` answers one question — which files does this project need
 * decoded, and when — and a template's contents are files it needs. They are
 * not in `doc.elements`, because a template stores a reference rather than a
 * copy, so every consumer of that question has to be handed the expansion
 * instead.
 *
 * **Only the asset layer, and the export's audio.** Handing this to the
 * renderer would draw every inner clip twice: once inside its template's own
 * layer, where it belongs, and once loose on the project frame. The picture is
 * drawn from the nested composition and nothing else.
 *
 * Returns its input **by identity** for a project with no templates, which is
 * what keeps the `WeakMap` caches downstream — the priority sort, the blend
 * layer table — working exactly as they did.
 */

import type { Timeline } from "../../@types/timeline";
import { expandTemplates } from "./compose";
import { templateFor } from "./templateRegistry";

export function assetTimeline(elements: Timeline): Timeline {
  return expandTemplates(elements, templateFor);
}
