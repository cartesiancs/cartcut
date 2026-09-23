/**
 * An extension's own data on one clip.
 *
 * Pure `(doc) => doc`, the convention every edit in this codebase follows, and
 * with the decline rule that goes with it: **unchanged returns its input by
 * identity**, so `withCheckpoint` records no undo step for a write that stored
 * the same value. An extension that recomputes its data on every document
 * change would otherwise fill the undo history with steps the user cannot see.
 *
 * The three shapes of absence are all deliberate, and together they are what
 * keeps `SCHEMA_VERSION` still: no `ext` key at all when no extension has
 * written anything, no owner key when that extension has cleared its value,
 * and the whole object gone when the last owner clears theirs. A project
 * nobody has run an extension on is byte-identical to one saved before
 * extensions existed.
 */

import type { JsonValue, TimelineElement } from "../../@types/timeline";
import type { TimelineDocument } from "../timeline/tracks";

/**
 * How much one extension may store on one clip.
 *
 * `timeline.json` is rewritten in full on every save and hashed on every edit
 * by `projectDigest.ts`, so this is paid at edit rate rather than once. An
 * extension with more than this to say about a clip writes a file in its own
 * storage and keeps a reference here.
 */
export const MAX_ELEMENT_DATA_BYTES = 64 * 1024;

export type ElementDataResult =
  | { ok: true; document: TimelineDocument }
  | { ok: false; reason: string };

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Read one extension's data. Never throws: it runs on every document change. */
export function elementExtData(
  element: TimelineElement | undefined,
  owner: string,
): JsonValue | null {
  const stored = (element as { ext?: Record<string, JsonValue> } | undefined)?.ext;
  if (stored == null) {
    return null;
  }
  return Object.prototype.hasOwnProperty.call(stored, owner) ? stored[owner] : null;
}

export function setElementExtData(
  doc: TimelineDocument,
  elementId: string,
  owner: string,
  value: JsonValue | null,
): ElementDataResult {
  const element = doc.elements[elementId];
  if (element == null) {
    return { ok: false, reason: "there is no clip with id `" + elementId + "`" };
  }

  if (value !== null) {
    let size = 0;
    try {
      size = JSON.stringify(value)?.length ?? 0;
    } catch {
      return { ok: false, reason: "that value cannot be stored in a project file" };
    }
    if (size > MAX_ELEMENT_DATA_BYTES) {
      return {
        ok: false,
        reason:
          "that value is " +
          size +
          " bytes, over the " +
          MAX_ELEMENT_DATA_BYTES +
          " byte cap. Write a file in the extension's own storage and keep a reference here.",
      };
    }
  }

  const current = (element as { ext?: Record<string, JsonValue> }).ext;
  const had = current != null && Object.prototype.hasOwnProperty.call(current, owner);

  if (value === null && !had) {
    return { ok: true, document: doc };
  }
  if (value !== null && had && sameValue(current?.[owner], value)) {
    return { ok: true, document: doc };
  }

  const nextExt: Record<string, JsonValue> = { ...(current ?? {}) };
  if (value === null) {
    delete nextExt[owner];
  } else {
    nextExt[owner] = value;
  }

  const nextElement = { ...element } as TimelineElement & { ext?: Record<string, JsonValue> };
  if (Object.keys(nextExt).length === 0) {
    delete nextElement.ext;
  } else {
    nextElement.ext = nextExt;
  }

  return {
    ok: true,
    document: {
      ...doc,
      elements: { ...doc.elements, [elementId]: nextElement },
    },
  };
}
