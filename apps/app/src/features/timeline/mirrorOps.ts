/**
 * Mirroring a clip's picture, horizontally or vertically.
 *
 * Two optional boolean fields and the ops that write them, shaped exactly like
 * `blendOps.ts` and for the same three reasons:
 *
 *  1. **Only video and image carry it.** A mirror flips *media*. Text mirrored
 *     is unreadable, a shape is symmetric or can be redrawn, and a group, an
 *     effect or a transition has no picture of its own to turn over.
 *  2. **Off deletes the key rather than storing `false`.** A project nobody has
 *     mirrored then saves byte-identically to one written before the feature,
 *     and `SCHEMA_VERSION` did not move.
 *  3. **Declining returns the document by identity**, so re-applying the state
 *     a clip already has records no undo step.
 *
 * Where it is drawn is `renderer/mirror.ts`, inside the element's box rather
 * than in its transform — see that file for why that keeps the mask, the hit
 * test and the grips where they were.
 */

import type { TimelineElement } from "../../@types/timeline";
import { setIn } from "../../utils/immutable";
import type { TimelineDocument } from "./tracks";

export type MirrorAxis = "h" | "v";

/** The element types that can be mirrored — the members of `Mirrorable`. */
export const MIRRORABLE_FILETYPES = ["video", "image"] as const;

const MIRRORABLE = new Set<string>(MIRRORABLE_FILETYPES);

const FIELD = { h: "flipH", v: "flipV" } as const;

/** Whether this element is one a mirror can be set on. */
export function isMirrorable(
  element: TimelineElement | undefined | null,
): boolean {
  return element != null && MIRRORABLE.has(element.filetype);
}

/**
 * Which way this clip is mirrored. The read half: absent means not mirrored,
 * and anything but a literal `true` reads as absent, so a hand-edited project
 * cannot make the renderer flip on a truthy string.
 */
export function mirrorOf(element: TimelineElement | undefined | null): {
  h: boolean;
  v: boolean;
} {
  const fields = element as { flipH?: unknown; flipV?: unknown } | null;
  return {
    h: fields?.flipH === true,
    v: fields?.flipV === true,
  };
}

/**
 * Mirror one clip on one axis, or clear it.
 *
 * Declines — returning `doc` itself — for an id that is not in the document,
 * an element that cannot be mirrored, and a state the clip already has.
 */
export function setClipMirror(
  doc: TimelineDocument,
  elementId: string,
  axis: MirrorAxis,
  on: boolean,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isMirrorable(element)) {
    return doc;
  }
  if (mirrorOf(element)[axis] === on) {
    return doc;
  }

  const field = FIELD[axis];
  let next: TimelineElement;
  if (on) {
    next = setIn(element, [field], true) as TimelineElement;
  } else {
    // Removed, not set to `undefined`: `JSON.stringify` drops an undefined
    // value, so the saved project would not match the one in memory.
    const { [field]: _cleared, ...rest } = element as TimelineElement &
      Record<string, unknown>;
    next = rest as TimelineElement;
  }

  return {
    ...doc,
    elements: { ...doc.elements, [elementId]: next },
  };
}

/**
 * What a toggle over `elementIds` would set `axis` to, or `null` when nothing
 * in the selection can be mirrored.
 *
 * Off only when *every* mirrorable clip is already on — the rule every editor
 * uses for a mixed selection, and the one that makes a second click undo the
 * first. Exported so the context menu can label the item with what it will do.
 */
export function mirrorToggleTarget(
  doc: TimelineDocument,
  elementIds: readonly string[],
  axis: MirrorAxis,
): boolean | null {
  const targets = elementIds
    .map((id) => doc.elements[id])
    .filter((element) => isMirrorable(element));
  if (targets.length === 0) {
    return null;
  }
  return !targets.every((element) => mirrorOf(element)[axis]);
}

/**
 * Flip the selection on one axis as one document.
 *
 * Folding `setClipMirror` keeps the decline contract: a selection with nothing
 * mirrorable in it comes back identical to its input and records no undo step.
 */
export function toggleMirror(
  doc: TimelineDocument,
  elementIds: readonly string[],
  axis: MirrorAxis,
): TimelineDocument {
  const on = mirrorToggleTarget(doc, elementIds, axis);
  if (on == null) {
    return doc;
  }
  return elementIds.reduce(
    (accumulated, id) => setClipMirror(accumulated, id, axis, on),
    doc,
  );
}
