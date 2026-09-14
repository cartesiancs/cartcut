/**
 * Writing a shape's recipe and its fill, as pure ops.
 *
 * The three rules `blendOps.ts` states, plus the fourth `maskOps.ts` adds:
 *
 *  1. **Only a shape carries either field.** Nothing else has an `option`
 *     block or an outline to generate, and writing one onto a video would put
 *     it in the saved project, through every undo snapshot and into the agent's
 *     serialiser, where nothing would ever read it.
 *  2. **Clearing deletes the key rather than storing a default**, so a shape
 *     nobody has parameterised saves byte-identically to one written before the
 *     feature and `SCHEMA_VERSION` did not move.
 *  3. **Declining returns the document by identity**, which `withCheckpoint`
 *     reads as "nothing happened" and spends no undo step on.
 *  4. **Every write builds a new element and a new outline.** Never a mutation.
 *     `clipOps.ts#pasteClips` shares everything but the animation block between
 *     a clip and its copy, so a duplicate holds *the same arrays* as its
 *     original, and an in-place edit here would change both and reach backwards
 *     into every undo entry that shares the element.
 *     `previewCanvas.addShapePoint` still does it the other way, pushing into
 *     `element.shape` in place; nothing new may copy that.
 *
 * ## The pair, and why it is a pair
 *
 * `geometry` is the recipe and `shape` is its outer boundary flattened, and
 * **this module is the only thing that writes either**. That is what stops them
 * disagreeing. The mirror exists because three readers want the cheap form and
 * none of them should have to learn recipes exist: the polygon tool's vertex
 * overlay, the agent serialiser's `shapePointCount`, and `renderShape`'s own
 * no-recipe branch. `ShapeGeometry`'s doc comment states the rest of it.
 *
 * The mirror is built against **`oWidth`/`oHeight`**, the authoring box, never
 * the drawn size: `renderShape` multiplies every stored point by
 * `shapeDrawScale`, so a mirror built against the drawn size would be scaled
 * twice. That is the defect `SHAPE_AUTHORING_BOX`'s comment already records
 * from the other direction.
 */

import type { ShapeElementType, TimelineElement } from "../../@types/timeline";
import {
  mergeShapeGeometry,
  sameShapeGeometry,
  shapeGeometryOf,
  type ShapeGeometryPatch,
} from "../shape/shapeGeometry";
import { flattenOutline } from "../shape/shapeOutline";
import type { TimelineDocument } from "./tracks";

/** Whether this element is one a recipe can be set on. */
export function isShapeElement(
  element: TimelineElement | undefined | null,
): element is ShapeElementType {
  return element?.filetype === "shape";
}

/** The authoring box a mirror is built against, defaulting the way draws do. */
function authoringBox(element: ShapeElementType): {
  width: number;
  height: number;
} {
  const usable = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value !== 0;
  // The same fallback ladder `renderer/shape.ts#scaleOf` walks, so a project
  // saved before `oHeight` was written mirrors into the box it draws in.
  const width = usable(element.oWidth)
    ? element.oWidth
    : usable(element.oHeight)
      ? element.oHeight
      : 100;
  const height = usable(element.oHeight)
    ? element.oHeight
    : usable(element.oWidth)
      ? element.oWidth
      : 100;
  return { width, height };
}

/** The outline `shape` should hold beside `geometry`. Exported for the tests. */
export function mirrorFor(element: ShapeElementType): number[][] {
  const geometry = shapeGeometryOf(element);
  if (geometry == null) {
    return element.shape;
  }
  return flattenOutline(geometry, authoringBox(element));
}

/**
 * Apply a patch to a shape's recipe, rewriting the mirror in the same step.
 *
 * `patch` is merged onto whatever recipe the clip has, so the panel can send
 * one field. A `kind` on a clip with no recipe **gives** it one, which replaces
 * the outline: that is the only way a polygon clicked out by hand can become
 * parametric, it is one undo step, and the panel says so before doing it.
 */
export function setClipShapeGeometry(
  doc: TimelineDocument,
  elementId: string,
  patch: ShapeGeometryPatch,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isShapeElement(element)) {
    return doc;
  }

  const before = shapeGeometryOf(element);
  const next = mergeShapeGeometry(before, patch);
  if (next == null || sameShapeGeometry(before, next)) {
    return doc;
  }

  const updated: ShapeElementType = {
    ...element,
    geometry: next,
    shape: flattenOutline(next, authoringBox(element)),
  };

  return { ...doc, elements: { ...doc.elements, [elementId]: updated } };
}

/**
 * Take a shape's recipe away, leaving the outline it last produced.
 *
 * The outline stays because it is the shape the user is looking at: dropping
 * the recipe is "stop generating this", not "delete it". The clip becomes an
 * ordinary hand-made polygon, which is what it will be edited as from then on.
 */
export function clearClipShapeGeometry(
  doc: TimelineDocument,
  elementId: string,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isShapeElement(element) || shapeGeometryOf(element) == null) {
    return doc;
  }

  // Removed, not set to `undefined`: `JSON.stringify` drops an undefined value,
  // so the saved project would not match the one in memory.
  const { geometry: _cleared, ...rest } = element as ShapeElementType & {
    geometry?: unknown;
  };

  return {
    ...doc,
    elements: { ...doc.elements, [elementId]: rest as ShapeElementType },
  };
}

/**
 * The fill colour, as an op rather than a store patch.
 *
 * `optionShape.handleChangeColor` wrote this through `updateTimeline`, which
 * records no undo step at all, so a colour change could not be taken back and a
 * colour picker's drag wrote once per `input` event. Through here a drag is one
 * step, and setting the colour a shape already has is none.
 */
export function setClipFillColor(
  doc: TimelineDocument,
  elementId: string,
  fillColor: string,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isShapeElement(element) || typeof fillColor !== "string" || fillColor === "") {
    return doc;
  }
  if (element.option?.fillColor === fillColor) {
    return doc;
  }

  const updated: ShapeElementType = {
    ...element,
    option: { ...element.option, fillColor },
  };
  return { ...doc, elements: { ...doc.elements, [elementId]: updated } };
}

/** Folding preserves the decline contract for free: see `maskOps.ts`. */
export function setClipShapeGeometryMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  patch: ShapeGeometryPatch,
): TimelineDocument {
  return elementIds.reduce(
    (acc, id) => setClipShapeGeometry(acc, id, patch),
    doc,
  );
}

export function setClipFillColorMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  fillColor: string,
): TimelineDocument {
  return elementIds.reduce((acc, id) => setClipFillColor(acc, id, fillColor), doc);
}
