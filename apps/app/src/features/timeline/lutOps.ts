/**
 * Document-level edits to a clip's colour grade.
 *
 * Deliberately shaped like `blendOps.ts`, because the same three rules apply
 * and only one of them is obvious:
 *
 *  1. **Not every element can carry a grade.** Audio has no picture; a group
 *     paints nothing; an effect and a transition are whole-frame operations
 *     rather than layers. Writing the field onto one of those would put it in
 *     the saved project, through every undo snapshot and into the agent's
 *     serialiser, where nothing would ever read it.
 *  2. **Clearing deletes the key rather than storing a null.** A `.ngt` is
 *     written by `JSON.stringify`, and a stored default is a field that then
 *     differs between a project saved before the feature and the same project
 *     saved after it, for no visible change.
 *  3. **Declining returns the document by identity**, the contract every op in
 *     `clipOps` holds — `withCheckpoint` reads identity to mean "nothing
 *     happened" and records no undo step. Clicking the LUT a clip already has
 *     costs the user nothing.
 *
 * One rule that is *not* shared with `blendOps`: **an unknown `presetId` is
 * accepted.** A blend mode is a closed union and a bad one is a bug upstream; a
 * LUT id names a file that may be installed on one machine and not on another,
 * and refusing to store it would mean a project that loses its grade whenever
 * it is opened somewhere the LUT is missing. Storing it and rendering ungraded
 * is what lets the grade come back when the LUT does. Whether the id is
 * *sensible* is a question for the panel and the agent command, which can
 * report it; this layer's job is to preserve what the document said.
 */

import type { LutRef, TimelineElement } from "../../@types/timeline";
import { setIn } from "../../utils/immutable";
import { clampIntensity, DEFAULT_LUT_INTENSITY, lutOf } from "../renderer/lut";
import type { TimelineDocument } from "./tracks";

/**
 * The element types that are composited as a layer, and can therefore be
 * graded.
 *
 * Exactly the members of the `Gradable` mixin in `@types/timeline.ts`, and the
 * same five as `BLENDABLE_FILETYPES` — the two mixins cover the same set for
 * the same reason. Kept as a value so the agent command can name them in its
 * error message rather than repeating the list.
 */
export const GRADABLE_FILETYPES = [
  "video",
  "image",
  "gif",
  "shape",
  "text",
] as const;

const GRADABLE = new Set<string>(GRADABLE_FILETYPES);

/** Whether this element is one a LUT can be set on. */
export function isGradable(
  element: TimelineElement | undefined | null,
): boolean {
  return element != null && GRADABLE.has(element.filetype);
}

/** The grade on a clip, or `null`. The panel's read model. */
export function lutRefOf(
  doc: TimelineDocument,
  elementId: string,
): LutRef | null {
  return lutOf(doc.elements[elementId]);
}

function sameRef(a: LutRef | null, b: LutRef | null): boolean {
  if (a == null || b == null) {
    return a === b;
  }
  return a.presetId === b.presetId && a.intensity === b.intensity;
}

function withLut(
  doc: TimelineDocument,
  elementId: string,
  next: LutRef | null,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isGradable(element)) {
    return doc;
  }
  if (sameRef(lutOf(element), next)) {
    return doc;
  }

  let updated: TimelineElement;
  if (next == null) {
    // Removed, not set to `undefined`: `JSON.stringify` drops an undefined
    // value, so the saved project would not match the one in memory.
    const { lut: _cleared, ...rest } = element as TimelineElement & {
      lut?: LutRef;
    };
    updated = rest as TimelineElement;
  } else {
    updated = setIn(element, ["lut"], next) as TimelineElement;
  }

  return { ...doc, elements: { ...doc.elements, [elementId]: updated } };
}

/**
 * Apply a LUT to a clip, or clear it with `null`.
 *
 * The intensity of a clip that is already graded is **carried over** rather
 * than reset. Trying five LUTs at 40% should compare five LUTs at 40%, not
 * force the strength back to full on every click — the same reason
 * `EffectElementType.intensity` is a field and not a preset parameter.
 */
export function setClipLut(
  doc: TimelineDocument,
  elementId: string,
  presetId: string | null,
  intensity?: number,
): TimelineDocument {
  if (presetId == null) {
    return withLut(doc, elementId, null);
  }
  const existing = lutOf(doc.elements[elementId]);
  const resolved =
    intensity !== undefined
      ? clampIntensity(intensity)
      : (existing?.intensity ?? DEFAULT_LUT_INTENSITY);
  return withLut(doc, elementId, { presetId, intensity: resolved });
}

/**
 * Change how strongly an existing grade applies.
 *
 * Declines on a clip with no LUT: an intensity with nothing to scale is a
 * field nothing would read, and storing one would leave a `lut` key naming no
 * preset in the saved project.
 */
export function setClipLutIntensity(
  doc: TimelineDocument,
  elementId: string,
  intensity: number,
): TimelineDocument {
  const existing = lutOf(doc.elements[elementId]);
  if (existing == null) {
    return doc;
  }
  return withLut(doc, elementId, {
    presetId: existing.presetId,
    intensity: clampIntensity(intensity),
  });
}

/**
 * Set the same LUT on many clips as one document.
 *
 * Folding preserves the decline contract for free: ids that cannot take a
 * grade return the accumulator unchanged, so a call naming only such ids comes
 * back identical to its input and records no undo step.
 */
export function setClipLutMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  presetId: string | null,
  intensity?: number,
): TimelineDocument {
  return elementIds.reduce(
    (accumulated, id) => setClipLut(accumulated, id, presetId, intensity),
    doc,
  );
}

/** Change the intensity on many clips as one document. */
export function setClipLutIntensityMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  intensity: number,
): TimelineDocument {
  return elementIds.reduce(
    (accumulated, id) => setClipLutIntensity(accumulated, id, intensity),
    doc,
  );
}
