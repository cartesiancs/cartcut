/**
 * Document-level edits to a clip's colour adjustments.
 *
 * Shaped like `lutOps.ts` and `blendOps.ts`, and the same three rules apply:
 *
 *  1. **Only the five layer types carry adjustments.** Audio has no picture, a
 *     group paints nothing, an effect or a transition is a whole-frame
 *     operation. Writing the field onto one of those would put it in the saved
 *     project where nothing reads it.
 *  2. **The stored form is canonical and sparse.** A slider at zero has no key,
 *     and a clip with every slider at zero has no `adjust` field — removed, not
 *     set to `undefined` or `{}`, so a project saved after resetting everything
 *     is byte-identical to one saved before the feature.
 *  3. **Declining returns the document by identity.** Setting a slider to the
 *     value it already has, or resetting a clip with nothing to reset, records
 *     no undo step.
 *
 * Values are validated where they arrive (`renderer/adjust.ts#coerceAdjustPatch`)
 * and normalized again here — clamped, unknown keys dropped — so nothing
 * outside the table in `adjust/spec.ts` can reach the document from either
 * direction.
 */

import type {
  ColorAdjustments,
  TimelineElement,
} from "../../@types/timeline";
import { keysOfGroup, type AdjustGroup } from "../adjust/spec";
import {
  adjustOf,
  normalizeAdjustments,
  sameAdjustments,
} from "../renderer/adjust";
import type { TimelineDocument } from "./tracks";

/**
 * The element types that can carry colour adjustments.
 *
 * Exactly the members of the `Adjustable` mixin, which covers the same five
 * types as `Gradable`. A value so the agent command can name them.
 */
export const ADJUSTABLE_FILETYPES = [
  "video",
  "image",
  "gif",
  "shape",
  "text",
] as const;

const ADJUSTABLE = new Set<string>(ADJUSTABLE_FILETYPES);

export function isAdjustable(
  element: TimelineElement | undefined | null,
): boolean {
  return element != null && ADJUSTABLE.has(element.filetype);
}

/** A clip's adjustments, canonical, `{}` when it has none. The panel's read model. */
export function adjustmentsOf(
  doc: TimelineDocument,
  elementId: string,
): ColorAdjustments {
  return adjustOf(doc.elements[elementId]) ?? {};
}

function withAdjust(
  doc: TimelineDocument,
  elementId: string,
  next: ColorAdjustments,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isAdjustable(element)) {
    return doc;
  }
  const canonical = normalizeAdjustments(next);
  if (sameAdjustments(adjustOf(element), canonical)) {
    return doc;
  }

  let updated: TimelineElement;
  if (Object.keys(canonical).length === 0) {
    const { adjust: _cleared, ...rest } = element as TimelineElement & {
      adjust?: ColorAdjustments;
    };
    updated = rest as TimelineElement;
  } else {
    updated = { ...element, adjust: canonical } as TimelineElement;
  }
  return { ...doc, elements: { ...doc.elements, [elementId]: updated } };
}

/**
 * Merge `patch` into a clip's adjustments.
 *
 * A key in the patch replaces the clip's value; a key set to zero removes it;
 * a key absent from the patch is left alone. That is what lets one slider move
 * without the caller having to read the other fourteen first.
 */
export function setClipAdjust(
  doc: TimelineDocument,
  elementId: string,
  patch: ColorAdjustments,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isAdjustable(element)) {
    return doc;
  }
  return withAdjust(doc, elementId, { ...(adjustOf(element) ?? {}), ...patch });
}

/**
 * Put a clip's adjustments back to zero — one group, or all of them.
 *
 * Declines on a clip with nothing in that group to reset.
 */
export function resetClipAdjust(
  doc: TimelineDocument,
  elementId: string,
  group?: AdjustGroup,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isAdjustable(element)) {
    return doc;
  }
  if (group == null) {
    return withAdjust(doc, elementId, {});
  }
  const next: ColorAdjustments = { ...(adjustOf(element) ?? {}) };
  for (const key of keysOfGroup(group)) {
    delete next[key];
  }
  return withAdjust(doc, elementId, next);
}

/**
 * The same patch on many clips as one document. Ids that cannot take it leave
 * the accumulator unchanged, so a call that changes nothing returns its input.
 */
export function setClipAdjustMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  patch: ColorAdjustments,
): TimelineDocument {
  return elementIds.reduce(
    (accumulated, id) => setClipAdjust(accumulated, id, patch),
    doc,
  );
}

export function resetClipAdjustMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  group?: AdjustGroup,
): TimelineDocument {
  return elementIds.reduce(
    (accumulated, id) => resetClipAdjust(accumulated, id, group),
    doc,
  );
}
