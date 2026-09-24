/**
 * Document-level edits to a clip's border and drop shadow.
 *
 * The three rules `blendOps.ts` states hold here too: only some element types
 * can carry one, a decoration that would paint nothing deletes the key rather
 * than storing it, and declining returns the document by identity so
 * `withCheckpoint` records no undo step.
 *
 * One rule is this module's own, and it is why a patch is merged rather than
 * replaced. **A caller names one field at a time.** Dragging the blur slider
 * must not clear the offset, and turning a border off must not forget its
 * width, so the panel and the agent both send a sparse patch over what is
 * already there. `enable: false` is therefore stored, where "would paint
 * nothing" is not: the first is a switch the user flicked and expects to find
 * again, the second is a decoration that was never really asked for.
 *
 * Validation is not here. `renderer/decoration.ts` owns `coerceStroke` and
 * `coerceShadow`, which run at the panel and agent boundaries, and its
 * `strokeOf`/`shadowOf` guard the read side on every draw.
 */

import type {
  ClipShadow,
  ClipStroke,
  TimelineElement,
} from "../../@types/timeline";
import {
  coerceShadow,
  coerceStroke,
  DECORATABLE_FILETYPES,
  isDecoratable,
} from "../renderer/decoration";
import { setIn } from "../../utils/immutable";
import type { TimelineDocument } from "./tracks";

export { DECORATABLE_FILETYPES, isDecoratable };

/** What a clip gets the first time either decoration is switched on. */
export const STROKE_DEFAULTS: ClipStroke = {
  enable: true,
  width: 2,
  color: "#000000",
  opacity: 100,
  align: "center",
};

/**
 * A card shadow is faint and low. These are the numbers a design tool opens
 * with, not a demonstration of the feature.
 */
export const SHADOW_DEFAULTS: ClipShadow = {
  enable: true,
  offsetX: 0,
  offsetY: 8,
  blur: 16,
  color: "#000000",
  opacity: 40,
};

/** A sparse patch over one decoration. Absent keys keep what is stored. */
export type StrokePatch = Partial<ClipStroke>;
export type ShadowPatch = Partial<ClipShadow>;

/**
 * The stored value, whatever state it is in, merged onto the defaults.
 *
 * Deliberately **not** `strokeOf`/`shadowOf`: those answer `null` for a
 * decoration that is switched off or that would paint nothing, which is right
 * for the renderer and wrong here. A patch that re-enables a border has to find
 * the width it had, not the default.
 */
function storedOr<T>(element: unknown, key: string, fallback: T): T {
  const raw = (element as Record<string, unknown> | null | undefined)?.[key];
  return raw != null && typeof raw === "object" && !Array.isArray(raw)
    ? ({ ...fallback, ...(raw as object) } as T)
    : ({ ...fallback } as T);
}

function sameDecoration(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The single write path for one key of one clip. */
function withDecoration(
  doc: TimelineDocument,
  elementId: string,
  key: "stroke" | "shadow",
  next: ClipStroke | ClipShadow | null,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isDecoratable(element)) {
    return doc;
  }
  if (sameDecoration((element as any)[key], next)) {
    return doc;
  }

  let updated: TimelineElement;
  if (next == null) {
    // Removed, not set to `undefined`. `JSON.stringify` drops an undefined and
    // `structuredClone`, which the copy path uses, keeps it, so a stored
    // `undefined` would make the saved project and the one in memory disagree
    // about whether the clip had ever been decorated. `maskOps.ts` says the
    // same.
    const { [key]: _cleared, ...rest } = element as TimelineElement &
      Record<string, unknown>;
    updated = rest as TimelineElement;
  } else {
    updated = setIn(element, [key], next) as TimelineElement;
  }

  return { ...doc, elements: { ...doc.elements, [elementId]: updated } };
}

/**
 * Merge a patch over one clip's border.
 *
 * A patch that leaves the border painting nothing at all — off, or zero width,
 * or fully transparent, and no field the user might come back to — deletes the
 * key, which is what keeps an undecorated project saving byte-identically.
 */
export function setClipStroke(
  doc: TimelineDocument,
  elementId: string,
  patch: StrokePatch,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isDecoratable(element)) {
    return doc;
  }
  const merged = { ...storedOr(element, "stroke", STROKE_DEFAULTS), ...patch };
  const next = coerceStroke(merged);
  // Switching off a border a clip never had is nothing happening, not a
  // request to store a disabled one. Without this, a panel that renders an
  // unchecked box and writes on every change would decorate every clip it
  // showed.
  if (next != null && !next.enable && (element as any).stroke == null) {
    return doc;
  }
  return withDecoration(doc, elementId, "stroke", next);
}

export function setClipShadow(
  doc: TimelineDocument,
  elementId: string,
  patch: ShadowPatch,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isDecoratable(element)) {
    return doc;
  }
  const merged = { ...storedOr(element, "shadow", SHADOW_DEFAULTS), ...patch };
  const next = coerceShadow(merged);
  if (next != null && !next.enable && (element as any).shadow == null) {
    return doc;
  }
  return withDecoration(doc, elementId, "shadow", next);
}

/** The same write across several clips, as one undo step. */
export function setClipStrokeMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  patch: StrokePatch,
): TimelineDocument {
  return elementIds.reduce((next, id) => setClipStroke(next, id, patch), doc);
}

export function setClipShadowMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  patch: ShadowPatch,
): TimelineDocument {
  return elementIds.reduce((next, id) => setClipShadow(next, id, patch), doc);
}

/** Take a clip back to no border and no shadow at all. */
export function clearClipDecoration(
  doc: TimelineDocument,
  elementId: string,
): TimelineDocument {
  const withoutStroke = withDecoration(doc, elementId, "stroke", null);
  return withDecoration(withoutStroke, elementId, "shadow", null);
}

/**
 * What the panel should show for a clip, whatever it has stored.
 *
 * The defaults merged in, so every control has a number to bind to before the
 * user has touched anything, and `enable` reported as it is stored so an
 * unchecked box stays unchecked.
 */
export function decorationFieldsOf(element: unknown): {
  stroke: ClipStroke;
  shadow: ClipShadow;
} {
  return {
    stroke: {
      ...storedOr(element, "stroke", STROKE_DEFAULTS),
      enable: (element as any)?.stroke?.enable === true,
    },
    shadow: {
      ...storedOr(element, "shadow", SHADOW_DEFAULTS),
      enable: (element as any)?.shadow?.enable === true,
    },
  };
}
