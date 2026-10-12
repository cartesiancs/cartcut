/**
 * Writing a shape's recipe, its fill and its backdrop, as pure ops.
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

import {
  fxParamKeyOf,
  isFxParamTrack,
  type FxParams,
  type ShapeElementType,
  type TimelineElement,
} from "../../@types/timeline";
import {
  backdropFxOf,
  coerceBackdropFx,
  coerceFillOpacity,
  sameBackdropFx,
  type BackdropFxInput,
} from "../shape/backdropFx";
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

/**
 * Give a shape a backdrop preset, change it, or take it away with `null`.
 *
 * `fx` is stored as the caller hands it, after `coerceBackdropFx`: the caller
 * is the one with a registry, and has already checked the preset is one a
 * backdrop can carry and seeded its defaults (`fx/backdropPreset.ts`). An input
 * the coercer refuses declines, rather than storing a backdrop that could
 * never draw and would leave the shape filled solid for no visible reason.
 *
 * A preset change drops the `fx:` tracks of parameters the new preset does
 * not have, as `effectOps.setEffectPreset` does and for the same reason: left
 * to `normalizeAnimation` they would ride along until the next load. Taking
 * the backdrop away drops every one of them, and its `intensity` track.
 */
export function setClipBackdropFx(
  doc: TimelineDocument,
  elementId: string,
  fx: BackdropFxInput | null,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isShapeElement(element)) {
    return doc;
  }
  const before = backdropFxOf(element);

  if (fx == null) {
    if (before == null && !("backdropFx" in element)) {
      return doc;
    }
    // Removed, not set to `undefined`, for `clearClipShapeGeometry`'s reason.
    const { backdropFx: _cleared, ...rest } = element;
    const updated = withoutBackdropTracks(rest as ShapeElementType, null);
    return { ...doc, elements: { ...doc.elements, [elementId]: updated } };
  }

  const next = coerceBackdropFx(fx);
  if (next == null || sameBackdropFx(before, next)) {
    return doc;
  }
  const updated = withoutBackdropTracks(
    { ...element, backdropFx: next },
    next.params,
  );
  return { ...doc, elements: { ...doc.elements, [elementId]: updated } };
}

/**
 * Choose a shape's backdrop preset, the way every surface does it.
 *
 * Two rules the inspector, a tile dropped on the timeline and the agent all
 * share, which is why they live here once:
 *
 *  - **Intensity carries over** when a shape already has a backdrop and the
 *    caller names none, as an effect's does across a preset change: trying a
 *    different look should not reset how strongly it was dialled in.
 *  - **The first backdrop switches the fill off.** A shape is made with an
 *    opaque fill, which would hide the very thing the backdrop draws; someone
 *    who picked a mosaic and saw nothing change would decide it had failed.
 *    A shape that already had a backdrop keeps the fill it was given.
 */
export function chooseClipBackdrop(
  doc: TimelineDocument,
  elementId: string,
  fx: BackdropFxInput,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isShapeElement(element)) {
    return doc;
  }
  const before = backdropFxOf(element);
  let next = setClipBackdropFx(doc, elementId, {
    ...fx,
    intensity: fx.intensity ?? before?.intensity,
  });
  if (next === doc) {
    return doc;
  }
  if (before == null) {
    next = setClipFillOpacity(next, elementId, 0);
  }
  return next;
}

/**
 * Patch a backdrop's parameter values and strength, leaving its preset alone.
 *
 * What the inspector's sliders write. Declines on a shape with no backdrop and
 * on a patch that changes nothing, so a slider dragged back to where it began
 * records no step.
 */
export function patchClipBackdropFx(
  doc: TimelineDocument,
  elementId: string,
  patch: { params?: FxParams; intensity?: number },
): TimelineDocument {
  const element = doc.elements[elementId];
  const before = isShapeElement(element) ? backdropFxOf(element) : null;
  if (before == null) {
    return doc;
  }
  return setClipBackdropFx(doc, elementId, {
    ...before,
    params: { ...before.params, ...(patch.params ?? {}) },
    intensity: patch.intensity ?? before.intensity,
  });
}

/**
 * Set the fill's own opacity, 0-100. Clamped, and deleted at 100 so a shape
 * nobody has made translucent saves as it always did.
 */
export function setClipFillOpacity(
  doc: TimelineDocument,
  elementId: string,
  fillOpacity: number,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isShapeElement(element)) {
    return doc;
  }
  const next = coerceFillOpacity(fillOpacity);
  if (next === null) {
    return doc;
  }
  const stored = element.option?.fillOpacity;
  if (next === undefined ? stored === undefined : stored === next) {
    return doc;
  }

  const { fillOpacity: _previous, ...option } = element.option ?? {
    fillColor: "#ffffff",
  };
  const updated: ShapeElementType = {
    ...element,
    option: next === undefined ? option : { ...option, fillOpacity: next },
  };
  return { ...doc, elements: { ...doc.elements, [elementId]: updated } };
}

export function setClipBackdropFxMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  fx: BackdropFxInput | null,
): TimelineDocument {
  return elementIds.reduce((acc, id) => setClipBackdropFx(acc, id, fx), doc);
}

export function setClipFillOpacityMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  fillOpacity: number,
): TimelineDocument {
  return elementIds.reduce(
    (acc, id) => setClipFillOpacity(acc, id, fillOpacity),
    doc,
  );
}

/**
 * The shape with the backdrop's tracks that no longer drive anything removed.
 *
 * `params` is the backdrop's new parameter set, or `null` when the backdrop is
 * going: then the `intensity` track goes too. Answers the element by identity
 * when there is nothing to drop.
 */
function withoutBackdropTracks(
  element: ShapeElementType,
  params: FxParams | null,
): ShapeElementType {
  const animation = (element as { animation?: Record<string, unknown> }).animation;
  if (animation == null) {
    return element;
  }
  const next: Record<string, unknown> = {};
  let dropped = false;
  for (const property of Object.keys(animation)) {
    const stale = isFxParamTrack(property)
      ? params == null || typeof params[fxParamKeyOf(property)] !== "number"
      : property === "intensity" && params == null;
    if (stale) {
      dropped = true;
      continue;
    }
    next[property] = animation[property];
  }
  return dropped ? ({ ...element, animation: next } as ShapeElementType) : element;
}
