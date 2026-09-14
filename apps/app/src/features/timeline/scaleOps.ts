/**
 * A clip's uniform magnification, and the op that writes it.
 *
 * One optional numeric field and its read guard, shaped exactly like
 * `mirrorOps.ts` and `blendOps.ts` and for the same three reasons:
 *
 *  1. **Only the seven `Visual` types carry it.** A scale is a factor applied
 *     to a picture. Audio has none; an effect and a transition each cover the
 *     whole frame by definition, so there is nothing for a factor to act on.
 *  2. **Unscaled deletes the key rather than storing 10.** A project nobody has
 *     scaled then saves byte-identically to one written before the feature, and
 *     `SCHEMA_VERSION` did not move.
 *  3. **Declining returns the document by identity**, so setting the scale a
 *     clip already has records no undo step.
 *
 * **Tenths, the unit the `scale` track stores.** 10 is unscaled, 12 is 120%.
 * The field and the track have to agree, because the track's fallback is this
 * field (`transform.ts#localSampleAt`), a new track is seeded from it
 * (`keyframeOps.ts#staticValueOf`) and the last keyframe's value is written
 * back into it (`keyframeOps.ts#withStaticValue`). Percent is a display unit
 * and lives in `animation/propertyUnits.ts`, which the sidebar and the curve
 * editor's ruler both go through.
 *
 * Called `scaleTenthsOf` rather than `scaleOf` because that name is taken twice
 * already, by `transform.ts` for a matrix's scale factor and by
 * `renderer/shape.ts` for a path's. Naming the unit is worth the length here:
 * a caller that reads this as a multiplier is wrong by a factor of ten and the
 * picture still draws.
 */

import type { TimelineElement } from "../../@types/timeline";
import { setIn } from "../../utils/immutable";
import type { TimelineDocument } from "./tracks";

/** Unscaled. The neutral value, in the tenths the scale track stores. */
export const SCALE_NEUTRAL_TENTHS = 10;

/**
 * The element types that can be scaled: the members of `Visual`.
 *
 * A group is in it: a group draws nothing, but its transform is composed into
 * every child's, so scaling one scales what is inside it. That is the whole
 * point of a null object.
 */
export const SCALABLE_FILETYPES = [
  "video",
  "image",
  "gif",
  "shape",
  "text",
  "group",
  "template",
] as const;

const SCALABLE = new Set<string>(SCALABLE_FILETYPES);

/** Whether this element is one a scale can be set on. */
export function isScalable(
  element: TimelineElement | undefined | null,
): boolean {
  return element != null && SCALABLE.has(element.filetype);
}

/**
 * Pin a scale into the representable range.
 *
 * The floor is zero and not below it. A negative factor turns the matrix
 * inside out, which mirrors the element rather than shrinking it: `transform.ts`
 * refuses a negative scale outright and `rotationOf` would read the flipped
 * matrix as a half turn. Mirroring is a thing this editor has, and `mirrorOps.ts`
 * owns it; see `renderer/mirror.ts` for why it is applied inside the box
 * instead of in the transform.
 *
 * There is no ceiling. Rotation has none either, and a clip magnified past the
 * frame is a legitimate picture: it covers everything.
 */
export function clampScaleTenths(value: number): number {
  if (!Number.isFinite(value)) {
    return SCALE_NEUTRAL_TENTHS;
  }
  return Math.max(0, value);
}

/**
 * The magnification this clip is authored at, in tenths.
 *
 * The read half, and it runs inside the paint loop once per element per frame,
 * so it must never throw. Defaulted *and* clamped, so a field absent from an
 * old project, a `null` element mid-undo and a hand-edited `.ngt` carrying
 * `"12"` or `-4` all produce something the matrix can be built from. Reading
 * through this rather than the raw field is what keeps "no field" and "10" the
 * same clip.
 */
export function scaleTenthsOf(
  element: TimelineElement | null | undefined,
): number {
  const scale = (element as { scale?: unknown } | null | undefined)?.scale;
  if (typeof scale !== "number") {
    return SCALE_NEUTRAL_TENTHS;
  }
  return clampScaleTenths(scale);
}

/**
 * A scale on its way *into* the document, from a spinner or a file.
 *
 * The strict counterpart to `scaleTenthsOf`, the split `blendOf`/`coerceBlend`
 * and `normalizeFps`/`coerceFps` both state. That one is a read guard on a hot
 * path; this one runs once, at the boundary a value arrives at, and returns
 * `null` for anything unusable so the caller can say what was wrong instead of
 * silently storing the default.
 *
 * Only numbers and strings are read: `Number(true)` is `1`, which would quietly
 * turn a boolean into a clip shrunk to a tenth of its size.
 */
export function coerceScaleTenths(value: unknown): number | null {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(raw)) {
    return null;
  }
  return clampScaleTenths(raw);
}

/**
 * Set one clip's magnification, or clear it.
 *
 * Declines, returning `doc` itself, for an id that is not in the document, an
 * element that cannot be scaled, a value that is not a usable number, and a
 * scale the clip already has.
 *
 * Note what this does *not* do: it never touches `animation.scale`. A clip with
 * a live scale track draws from the track and this field is its fallback, which
 * is the same relationship `rotation` and `opacity` have with theirs. The
 * sidebar writes both in one gesture for exactly that reason.
 */
export function setClipScale(
  doc: TimelineDocument,
  elementId: string,
  tenths: number,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isScalable(element)) {
    return doc;
  }
  if (!Number.isFinite(tenths)) {
    return doc;
  }

  const next = clampScaleTenths(tenths);
  if (scaleTenthsOf(element) === next) {
    return doc;
  }

  let updated: TimelineElement;
  if (next === SCALE_NEUTRAL_TENTHS) {
    // Removed, not set to `undefined`: `JSON.stringify` drops an undefined
    // value, so the saved project would not match the one in memory.
    const { scale: _cleared, ...rest } = element as TimelineElement &
      Record<string, unknown>;
    updated = rest as TimelineElement;
  } else {
    updated = setIn(element, ["scale"], next) as TimelineElement;
  }

  return {
    ...doc,
    elements: { ...doc.elements, [elementId]: updated },
  };
}
