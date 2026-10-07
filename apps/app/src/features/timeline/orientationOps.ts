/**
 * Orientation as one thing: the two mirrors and the playback direction, which
 * the option panel's Orientation section shows together and takes off together.
 *
 * Nothing new is stored. Each half keeps its own field and its own op
 * (`mirrorOps.ts`, `reverseOps.ts`); this answers whether any of them is set,
 * and folds the three clears into one document so the section's `×` is one
 * undo step rather than three.
 */

import type { TimelineElement } from "../../@types/timeline";
import { mirrorOf, setClipMirror } from "./mirrorOps";
import { isReversed, unreverse } from "./reverseOps";
import type { TimelineDocument } from "./tracks";

/** Whether the clip is mirrored, flipped or playing a reversed copy. */
export function isReoriented(
  element: TimelineElement | undefined | null,
): boolean {
  const { h, v } = mirrorOf(element);
  return h || v || isReversed(element);
}

/**
 * Put the clip back the right way round and playing forwards.
 *
 * Declines by identity when there is nothing to put back, because each op it
 * folds does: a clip already at rest costs the user no undo step, and neither
 * does an id that is not in the document.
 */
export function resetClipOrientation(
  doc: TimelineDocument,
  elementId: string,
): TimelineDocument {
  let next = setClipMirror(doc, elementId, "h", false);
  next = setClipMirror(next, elementId, "v", false);
  return unreverse(next, elementId);
}
