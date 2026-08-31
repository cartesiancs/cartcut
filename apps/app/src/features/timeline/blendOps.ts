/**
 * Document-level edits to a clip's blend mode.
 *
 * A single field and a single op, which is the whole reason this file is worth
 * having rather than a `setIn(element, ["blend"], mode)` at each call site:
 * three rules have to hold at every one of them, and only one is obvious.
 *
 *  1. **Not every element can carry a blend.** Audio has no picture; a group
 *     paints nothing; an effect and a transition are whole-frame operations
 *     rather than layers. Writing the field onto one of those would put it in
 *     the saved project, through every undo snapshot and into the agent's
 *     serializer, where nothing would ever read it.
 *  2. **`"source-over"` deletes the key rather than storing it.** `JSON`
 *     round-trips are how a `.ngt` is written, and a stored default is a field
 *     that then differs between a project saved before the feature and the same
 *     project saved after it, for no visible change.
 *  3. **Declining returns the document by identity**, the contract every op in
 *     `clipOps` holds — `withCheckpoint` reads identity to mean "nothing
 *     happened" and records no undo step. Re-picking the mode a clip already
 *     has costs the user nothing.
 *
 * Validation is deliberately *not* here. `BlendMode` is a closed union, so by
 * the time a value reaches this function it has already been through
 * `renderer/blend.ts#coerceBlend` at the panel or the agent boundary, which is
 * the only place that can report a bad one usefully.
 */

import {
  type BlendMode,
  type TimelineElement,
} from "../../@types/timeline";
import { setIn } from "../../utils/immutable";
import { blendOf, DEFAULT_BLEND } from "../renderer/blend";
import type { TimelineDocument } from "./tracks";

/**
 * The element types that are composited as a layer, and can therefore blend.
 *
 * Exactly the members of the `Blendable` mixin in `@types/timeline.ts`. Kept as
 * a value so the agent command can name them in its error message rather than
 * repeating the list.
 */
export const BLENDABLE_FILETYPES = [
  "video",
  "image",
  "gif",
  "shape",
  "text",
] as const;

const BLENDABLE = new Set<string>(BLENDABLE_FILETYPES);

/** Whether this element is one a blend mode can be set on. */
export function isBlendable(
  element: TimelineElement | undefined | null,
): boolean {
  return element != null && BLENDABLE.has(element.filetype);
}

/**
 * Set the blend mode a clip is composited with.
 *
 * `"source-over"` clears it. Declines — returning `doc` itself — for an id that
 * is not in the document, an element that cannot carry a blend, and a mode the
 * clip already has.
 */
export function setClipBlend(
  doc: TimelineDocument,
  elementId: string,
  blend: BlendMode,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isBlendable(element)) {
    return doc;
  }
  if (blendOf(element) === blend) {
    return doc;
  }

  let next: TimelineElement;
  if (blend === DEFAULT_BLEND) {
    // Removed, not set to `undefined`: `JSON.stringify` drops an undefined
    // value, so the saved project would not match the one in memory.
    const { blend: _cleared, ...rest } = element as TimelineElement & {
      blend?: BlendMode;
    };
    next = rest as TimelineElement;
  } else {
    next = setIn(element, ["blend"], blend) as TimelineElement;
  }

  return {
    ...doc,
    elements: { ...doc.elements, [elementId]: next },
  };
}

/**
 * Set the same mode on many clips as one document.
 *
 * Folding `setClipBlend` preserves the decline contract for free: ids that
 * cannot take the mode return the accumulator unchanged, so a call naming only
 * such ids comes back identical to its input and records no undo step.
 */
export function setClipBlendMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  blend: BlendMode,
): TimelineDocument {
  return elementIds.reduce(
    (accumulated, id) => setClipBlend(accumulated, id, blend),
    doc,
  );
}
