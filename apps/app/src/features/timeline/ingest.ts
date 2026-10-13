/**
 * The one way a document from outside the store becomes one the store holds.
 *
 * What `timelineStore.patchDocument` has always done to a loaded `.ngt`, lifted
 * out so the two other ways a document now arrives go through the same steps:
 * a template forked into the project (`composition/fork.ts`), whose
 * `template.ngt` was only ever run through `normalizeDocument`, and each
 * composition read back from a saved project.
 *
 * In order:
 *  1. `normalizeAnimations`: the only place animation blocks are validated.
 *     Projects written by older builds carry `ax: [[], []]` where a list of
 *     `[t, value]` pairs belongs. `normalizeDocument` is the wrong home: it
 *     runs on every checkpoint and every clip op, and re-walking keyframe
 *     arrays at pointer rate to re-check data checked on the way in is cost.
 *  2. `normalizeSpeedCurves`: `speed` is authored on a clip with no ramp and
 *     derived on one with one, and a file can arrive disagreeing with itself.
 *  3. `rebakeAnimations`, when a rate is given: lanes baked at another frame
 *     rate are re-derived here, where the arrays are being walked anyway,
 *     rather than on the first edit (no undo step, and no window where the
 *     preview steps at a rate the project no longer runs at).
 *  4. `normalizeDocument`: indices, names, priorities, parents, transitions.
 *
 * Pure: no store, no DOM.
 */

import {
  normalizeAnimations,
  rebakeAnimations,
} from "../animation/keyframeOps";
import { normalizeSpeedCurves } from "./speedOps";
import { normalizeDocument, type TimelineDocument } from "./tracks";

export function ingestDocument(
  doc: TimelineDocument,
  bakeHz?: number,
): TimelineDocument {
  const validated = normalizeSpeedCurves(normalizeAnimations(doc));
  const rebaked =
    bakeHz == null ? validated : rebakeAnimations(validated, bakeHz);
  return normalizeDocument(rebaked);
}
