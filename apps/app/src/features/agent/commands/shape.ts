/**
 * A shape's parametric outline, from the agent surface.
 *
 * One command over the panel's own ops (`timeline/shapeOps.ts`), so an agent's
 * edit and the user's slider share one undo step and one set of decline rules.
 * The whole patch is one document and therefore one undo step: "make it a
 * seven-pointed star with rounded points" is a single edit, not three.
 *
 * There is no `clear` here. Dropping a recipe leaves an outline nobody can put
 * back from the agent side, and an agent that wanted a different shape should
 * ask for that shape.
 */

import { SHAPE_GEOMETRY_KINDS, type ShapeGeometryKind } from "../../../@types/timeline";
import { coerceShapeGeometry, shapeGeometryOf } from "../../shape/shapeGeometry";
import { MAX_SHAPE_COUNT, MIN_SHAPE_COUNT } from "../../shape/shapeOutline";
import { isShapeElement, setClipShapeGeometryMany } from "../../timeline/shapeOps";
import { commit } from "../commit";
import { currentDoc, requireElement } from "../context";
import { registerCommands } from "../registry";

export type ShapeToolParams = {
  kind?: ShapeGeometryKind;
  cornerRadius?: number | number[];
  count?: number;
  innerRatio?: number;
  arcStart?: number;
  arcSweep?: number;
  hole?: number;
};

/**
 * The tool's flat parameters as a recipe patch.
 *
 * Flat on the wire and nested in the document, because `arc` is the only nested
 * thing and two extra tool parameters read far better in a schema than an
 * object an agent has to supply whole to change half of.
 */
export function shapePatchFrom(
  params: ShapeToolParams,
  current: { start: number; sweep: number } | null,
) {
  const patch: Record<string, unknown> = {};
  if (params.kind !== undefined) {
    patch.kind = params.kind;
  }
  if (params.cornerRadius !== undefined) {
    patch.radius = params.cornerRadius;
  }
  for (const key of ["count", "innerRatio", "hole"] as const) {
    if (params[key] !== undefined) {
      patch[key] = params[key];
    }
  }
  if (params.arcStart !== undefined || params.arcSweep !== undefined) {
    patch.arc = {
      start: params.arcStart ?? current?.start ?? 0,
      sweep: params.arcSweep ?? current?.sweep ?? 360,
    };
  }
  return patch;
}

registerCommands({
  set_shape: (params: ShapeToolParams & { elementIds: string[] }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_shape needs at least one id in `elementIds`.");
    }

    const wrongType = ids
      .map((id) => requireElement(doc, id))
      .filter((element) => !isShapeElement(element));
    if (wrongType.length > 0) {
      throw new Error(
        "Only shape clips carry a shape recipe; got " +
          `${wrongType.map((element) => element.filetype).join(", ")}.`,
      );
    }

    // The kind has to be settled before anything else can be validated: a
    // `count` means nothing on a rectangle, and the first clip's own kind is
    // what an agent that omitted `kind` is patching.
    const existing = shapeGeometryOf(doc.elements[ids[0]]);
    const kind = params.kind ?? existing?.kind;
    if (kind == null) {
      throw new Error(
        "That shape was drawn by hand and has no recipe, so `kind` is needed. " +
          `Known kinds: ${SHAPE_GEOMETRY_KINDS.join(", ")}. ` +
          "Setting one replaces the clip's outline.",
      );
    }

    const patch = shapePatchFrom(
      { ...params, kind },
      existing?.arc ?? { start: 0, sweep: 360 },
    );

    // Through the same validator the panel would use, so an agent hears about a
    // radius array of the wrong length rather than having three of its four
    // corners quietly ignored.
    const checked = coerceShapeGeometry({ ...patch, kind });
    if (!checked.ok) {
      throw new Error(checked.error);
    }
    if (
      params.count !== undefined &&
      (params.count < MIN_SHAPE_COUNT || params.count > MAX_SHAPE_COUNT)
    ) {
      // Reported rather than clamped. A mouse cannot be told anything and so is
      // clamped in the panel; an agent that is told the bound learns something.
      throw new Error(
        `\`count\` must be between ${MIN_SHAPE_COUNT} and ${MAX_SHAPE_COUNT}.`,
      );
    }

    const result = commit(
      (d) => setClipShapeGeometryMany(d, ids, patch as never),
      "Those shapes already have that outline.",
    );

    const after = currentDoc();
    return {
      ...(result as Record<string, unknown>),
      clips: ids.map((id) => ({
        id,
        geometry: shapeGeometryOf(after.elements[id]),
      })),
    };
  },
});
