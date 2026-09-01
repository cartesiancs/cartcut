/**
 * Document-level edits to a clip's mask.
 *
 * Deliberately shaped like `lutOps.ts` and `blendOps.ts`, because the same
 * three rules apply and only one of them is obvious:
 *
 *  1. **Not every element can carry a mask.** Audio has no picture; a group
 *     paints nothing; an effect and a transition are whole-frame operations
 *     rather than layers. Writing the field onto one of those would put it in
 *     the saved project, through every undo snapshot and into the agent's
 *     serialiser, where nothing would ever read it.
 *  2. **Clearing deletes the key rather than storing a null.** A `.ngt` is
 *     written by `JSON.stringify`, which drops an `undefined` — but
 *     `structuredClone`, which the copy path uses, keeps it. Storing a default
 *     would make the saved project and the in-memory one disagree about
 *     whether the clip had ever been masked.
 *  3. **Declining returns the document by identity**, the contract every op in
 *     `clipOps` holds — `withCheckpoint` reads identity to mean "nothing
 *     happened" and records no undo step. Clicking the shape a clip already has
 *     costs the user nothing.
 *
 * ## The fourth rule, which is this module's own
 *
 * **Every write builds a new `MaskType` and a new `path` array.** Never a
 * mutation, not even of a field. `clipOps.ts#pasteClips` shares everything but
 * the animation block between a clip and its copy — its header says so, and
 * that is what makes a paste cheap — so a duplicate holds *the same mask
 * object* as its original. An in-place edit here would change both, and would
 * reach backwards into every undo entry that shares the element, which is
 * exactly the failure `features/animation/keyframes.ts` was written to end.
 * `previewCanvas.addShapePoint` still does it the other way, pushing into
 * `element.shape` in place; the pen tool must not copy that.
 *
 * ## Masks and their keyframes are seeded and removed together
 *
 * A clip's mask tracks exist only while it has a mask — `animatableProperties`
 * gates on `element.mask != null`, which is what makes `keyframeOps.resolve`
 * refuse a mask keyframe on an unmasked clip with no extra guard. So applying a
 * mask seeds the five empty tracks and clearing one removes them, in the same
 * transform, and a document is never left with either half alone.
 *
 * A GIF is the exception that proves it useful: maskable but not animatable, it
 * has no `animation` block at all, so there is nothing to seed and nothing to
 * remove. Inventing one would hand a clip type that has never had a curve
 * editor a curve editor.
 */

import {
  MASK_ANIMATABLE_PROPERTIES,
  type MaskNode,
  type MaskShape,
  type MaskType,
  type TimelineElement,
} from "../../@types/timeline";
import { emptyMaskAnimation } from "../animation/keyframes";
import {
  DEFAULT_MASK_FEATHER,
  DEFAULT_MASK_ROUNDNESS,
  MIN_PEN_NODES,
  coerceMask,
  coerceMaskShape,
  defaultMask,
  maskOf,
  sameMask,
} from "../mask/maskShape";
import type { TimelineDocument } from "./tracks";

/**
 * The element types that are composited as a layer, and can therefore be cut.
 *
 * Exactly the members of the `Maskable` mixin in `@types/timeline.ts`, and the
 * same five as `GRADABLE_FILETYPES` and `BLENDABLE_FILETYPES` — the three
 * mixins cover the same set for the same reason. Kept as a value so the agent
 * command can name them in its error message rather than repeating the list.
 */
export const MASKABLE_FILETYPES = [
  "video",
  "image",
  "gif",
  "shape",
  "text",
] as const;

const MASKABLE = new Set<string>(MASKABLE_FILETYPES);

/** Whether this element is one a mask can be set on. */
export function isMaskable(
  element: TimelineElement | undefined | null,
): boolean {
  return element != null && MASKABLE.has(element.filetype);
}

/** The mask on a clip, read through the guard, or `null`. The panel's model. */
export function maskRefOf(
  doc: TimelineDocument,
  elementId: string,
): MaskType | null {
  return maskOf(doc.elements[elementId]);
}

// ------------------------------------------------------------------ writing

/** A `MaskType` with nothing shared with its input. */
function copyMask(mask: MaskType): MaskType {
  const out: MaskType = {
    shape: mask.shape,
    location: { x: mask.location.x, y: mask.location.y },
    size: { width: mask.size.width, height: mask.size.height },
    rotation: mask.rotation,
    feather: mask.feather,
    roundness: mask.roundness,
  };
  if (mask.invert === true) {
    out.invert = true;
  }
  if (mask.path !== undefined) {
    out.path = mask.path.map((node) => {
      const copy: MaskNode = { p: [node.p[0], node.p[1]] };
      if (node.cs !== undefined) {
        copy.cs = [node.cs[0], node.cs[1]];
      }
      if (node.ce !== undefined) {
        copy.ce = [node.ce[0], node.ce[1]];
      }
      return copy;
    });
  }
  return out;
}

/**
 * The element with `next` on it, its mask tracks seeded or removed to match.
 *
 * The single write path — every public op below funnels through it, so the
 * "mask and tracks move together" invariant is held in one place rather than at
 * four call sites.
 */
function withMask(
  doc: TimelineDocument,
  elementId: string,
  next: MaskType | null,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isMaskable(element)) {
    return doc;
  }
  if (sameMask(maskOf(element), next)) {
    return doc;
  }

  const source = element as TimelineElement & {
    mask?: MaskType;
    animation?: Record<string, unknown>;
  };

  let updated: any;
  if (next == null) {
    // Removed, not set to `undefined` — see rule 2 in this module's header.
    const { mask: _cleared, ...rest } = source;
    updated = rest;
  } else {
    updated = { ...source, mask: copyMask(next) };
  }

  // Only for a clip that has an animation block at all. A GIF has none, and
  // giving it one here would be the only place in the codebase that did.
  if (source.animation != null) {
    if (next == null) {
      const animation: Record<string, unknown> = {};
      for (const [property, track] of Object.entries(source.animation)) {
        if (!(MASK_ANIMATABLE_PROPERTIES as readonly string[]).includes(property)) {
          animation[property] = track;
        }
      }
      updated.animation = animation;
    } else {
      // Seeded only where absent, so switching shape or nudging a field leaves
      // curves the user has already drawn exactly where they were.
      const seeds = emptyMaskAnimation();
      const animation = { ...source.animation };
      let seeded = false;
      for (const [property, track] of Object.entries(seeds)) {
        if (animation[property] == null) {
          animation[property] = track;
          seeded = true;
        }
      }
      if (seeded) {
        updated.animation = animation;
      }
    }
  }

  return { ...doc, elements: { ...doc.elements, [elementId]: updated } };
}

/**
 * Apply a mask shape to a clip, or clear it with `null`.
 *
 * The **placement is carried over** rather than reset: trying five shapes
 * should compare five shapes in the frame the user set up, not snap the mask
 * back to the middle four times. Same reasoning as `setClipLut` carrying the
 * intensity across a change of LUT.
 *
 * A stale `path` is dropped whenever the shape leaves `pen`, so that what is
 * stored and what `maskOf` reads back are the same thing — otherwise the saved
 * project would carry a path nothing reads, and switching back to `pen` months
 * later would resurrect a drawing the user had forgotten making.
 */
export function setClipMask(
  doc: TimelineDocument,
  elementId: string,
  shape: MaskShape | null,
): TimelineDocument {
  if (shape == null) {
    return withMask(doc, elementId, null);
  }
  const resolved = coerceMaskShape(shape);
  if (resolved == null) {
    return doc;
  }

  const existing = maskOf(doc.elements[elementId]);
  if (existing == null) {
    return withMask(doc, elementId, defaultMask(resolved));
  }

  const next: MaskType = { ...existing, shape: resolved };
  if (resolved !== "pen") {
    delete next.path;
  }
  return withMask(doc, elementId, next);
}

/** The fields `setClipMaskFields` will act on. Absent means "leave it". */
export type MaskFieldPatch = {
  location?: { x: number; y: number };
  size?: { width: number; height: number };
  rotation?: number;
  feather?: number;
  roundness?: number;
  invert?: boolean;
};

/**
 * Change a mask's placement, softness or polarity.
 *
 * Declines on a clip with no mask: these are fields *of* a mask, and storing
 * one without a shape would leave a `mask` key the renderer refuses to read.
 *
 * Unreadable numbers are **dropped, and the whole call then declines if that
 * leaves nothing to do** — rather than being clamped into something plausible.
 * The panel's spinners can emit a `NaN` mid-edit, and writing one would plant a
 * value that survives into every baked lane seeded from it afterwards.
 * Out-of-range but readable numbers *are* clamped, because a slider pushed to
 * its end is a preference and not a mistake.
 */
export function setClipMaskFields(
  doc: TimelineDocument,
  elementId: string,
  patch: MaskFieldPatch,
): TimelineDocument {
  const existing = maskOf(doc.elements[elementId]);
  if (existing == null) {
    return doc;
  }

  const merged: Record<string, unknown> = { ...existing };
  if (isPoint(patch.location, "x", "y")) {
    merged.location = patch.location;
  }
  if (isPoint(patch.size, "width", "height")) {
    merged.size = patch.size;
  }
  for (const key of ["rotation", "feather", "roundness"] as const) {
    const value = patch[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      merged[key] = value;
    }
  }
  if (patch.invert !== undefined) {
    // `false` removes the key rather than storing it — the same
    // default-deletes rule the `mask` field itself follows, one level down.
    if (patch.invert) {
      merged.invert = true;
    } else {
      delete merged.invert;
    }
  }

  const next = coerceMask(merged);
  if (next == null) {
    return doc;
  }
  return withMask(doc, elementId, next);
}

function isPoint(
  value: unknown,
  ...keys: string[]
): value is any {
  if (value == null || typeof value !== "object") {
    return false;
  }
  return keys.every((key) => {
    const at = (value as any)[key];
    return typeof at === "number" && Number.isFinite(at);
  });
}

/**
 * Store a drawn path, switching the clip to a `pen` mask.
 *
 * This is what the pen tool commits, once, when the path closes — not once per
 * node. One drawn mask is one undo step, which is both what the user means by
 * the gesture and what keeps the session's own state and the document from
 * drifting apart when they press Cmd+Z halfway through.
 *
 * Declines on a path too short to enclose anything, so a two-node stroke leaves
 * the document exactly as it found it. It never *stores* the pass-through case
 * that `isMaskActive` would then have to render around.
 */
export function setClipMaskPath(
  doc: TimelineDocument,
  elementId: string,
  path: readonly MaskNode[],
): TimelineDocument {
  if (path.length < MIN_PEN_NODES) {
    return doc;
  }
  const existing = maskOf(doc.elements[elementId]) ?? defaultMask("pen");
  const next = coerceMask({ ...existing, shape: "pen", path });
  if (next == null || next.path == null || next.path.length < MIN_PEN_NODES) {
    return doc;
  }
  return withMask(doc, elementId, next);
}

// -------------------------------------------------------------- many at once

/**
 * Set the same shape on many clips as one document.
 *
 * Folding preserves the decline contract for free: ids that cannot take a mask
 * return the accumulator unchanged, so a call naming only such ids comes back
 * identical to its input and records no undo step.
 */
export function setClipMaskMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  shape: MaskShape | null,
): TimelineDocument {
  return elementIds.reduce(
    (accumulated, id) => setClipMask(accumulated, id, shape),
    doc,
  );
}

/** Patch the mask fields of many clips as one document. */
export function setClipMaskFieldsMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  patch: MaskFieldPatch,
): TimelineDocument {
  return elementIds.reduce(
    (accumulated, id) => setClipMaskFields(accumulated, id, patch),
    doc,
  );
}

/** The defaults a panel shows for a clip with no mask yet. */
export const MASK_FIELD_DEFAULTS = {
  feather: DEFAULT_MASK_FEATHER,
  roundness: DEFAULT_MASK_ROUNDNESS,
} as const;
