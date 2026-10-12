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
 *
 * `set_shape_backdrop` is the other half: an effect or LUT preset run over what
 * is beneath the shape, inside its outline. A face mosaic is an ellipse with
 * `com.cartcut.pixelate` on it. Its own command rather than more `set_shape`
 * fields, because `set_shape` is about the outline, needs a `kind` on a shape
 * drawn by hand, and declines with words about the outline.
 */

import {
  SHAPE_GEOMETRY_KINDS,
  type FxParams,
  type ShapeGeometryKind,
  type TimelineElement,
} from "../../../@types/timeline";
import { backdropModeOf } from "../../fx/backdropPreset";
import { inlinePresetId } from "../../fx/programHash";
import { presetById } from "../../fx/presetRegistry";
import { defaultParamsOf, type FxPreset } from "../../fx/presetTypes";
import {
  backdropFxOf,
  fillOpacityOf,
  type BackdropFxInput,
} from "../../shape/backdropFx";
import { coerceShapeGeometry, shapeGeometryOf } from "../../shape/shapeGeometry";
import { MAX_SHAPE_COUNT, MIN_SHAPE_COUNT } from "../../shape/shapeOutline";
import {
  chooseClipBackdrop,
  isShapeElement,
  patchClipBackdropFx,
  setClipBackdropFx,
  setClipFillOpacity,
  setClipShapeGeometryMany,
} from "../../timeline/shapeOps";
import type { TimelineDocument } from "../../timeline/tracks";
import { commit } from "../commit";
import { currentDoc, requireElement } from "../context";
import { requireProgram } from "../programInput";
import { registerCommands } from "../registry";
import { backdropRow } from "../serialize";

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

/** What a caller names a backdrop by: an installed preset, or a program. */
export type BackdropToolInput = {
  presetId?: string;
  program?: unknown;
  params?: Record<string, unknown>;
  intensity?: number;
};

/**
 * A backdrop the shape ops will store, or an `Error` that says what to fix.
 *
 * Checked here, where the registry is, because the op cannot: a preset that is
 * not installed, or one that is a transition, a graphic or an overlay, would be
 * stored as a backdrop that never draws, and the shape would fill solid with
 * nothing to say why. The preset's defaults go under whatever values were
 * passed, so every parameter has a number for the inspector and for a
 * keyframe track to start from.
 */
export function requireBackdrop(input: BackdropToolInput): {
  fx: BackdropFxInput;
  warnings: unknown[];
} {
  if (input.program != null && input.presetId) {
    throw new Error("Pass either `presetId` or `program`, not both.");
  }
  if (input.program != null) {
    const inline = requireProgram(input.program, "effect", input.params);
    requireBackdropPreset(inline.preset, "That program");
    return {
      fx: {
        presetId: inlinePresetId(inline.program.hash),
        program: inline.program,
        params: inline.params,
        intensity: input.intensity,
      },
      warnings: inline.warnings,
    };
  }
  if (!input.presetId) {
    throw new Error(
      "A backdrop needs a `presetId` (list_effect_presets and list_luts have them) or a `program`.",
    );
  }
  const preset = presetById(input.presetId);
  if (preset == null) {
    throw new Error(
      `No preset "${input.presetId}" is installed. list_effect_presets and list_luts list the ones that are.`,
    );
  }
  requireBackdropPreset(preset, `"${input.presetId}"`);
  return {
    fx: {
      presetId: preset.id,
      params: { ...defaultParamsOf(preset), ...((input.params ?? {}) as FxParams) },
      intensity: input.intensity,
    },
    warnings: [],
  };
}

function requireBackdropPreset(preset: FxPreset, name: string): void {
  if (backdropModeOf(preset) != null) {
    return;
  }
  const what =
    preset.render.type === "overlay"
      ? "an overlay, which plays its own media over the frame and has nothing to read beneath the shape"
      : `a ${preset.kind} preset`;
  throw new Error(
    `${name} is ${what}. A backdrop takes an effect shader or a LUT.`,
  );
}

/** What a reply says about one shape's backdrop: the serializer's row, and its fill. */
export function backdropSummary(element: TimelineElement | undefined) {
  return { backdrop: backdropRow(element), fillOpacity: fillOpacityOf(element) };
}

function requireShapes(doc: TimelineDocument, ids: string[], tool: string): void {
  if (ids.length === 0) {
    throw new Error(`${tool} needs at least one id in \`elementIds\`.`);
  }
  const wrongType = ids
    .map((id) => requireElement(doc, id))
    .filter((element) => !isShapeElement(element));
  if (wrongType.length > 0) {
    throw new Error(
      "Only shape clips carry a backdrop; got " +
        `${wrongType.map((element) => element.filetype).join(", ")}.`,
    );
  }
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

  /**
   * Run an effect or LUT preset over what is beneath shapes, inside their
   * outlines, change it, or take it away. One commit for every id, so a
   * mosaic over three faces is one undo step.
   */
  set_shape_backdrop: (
    params: BackdropToolInput & {
      elementIds: string[];
      fillOpacity?: number;
      remove?: boolean;
    },
  ) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    requireShapes(doc, ids, "set_shape_backdrop");

    const naming = params.presetId != null || params.program != null;
    if (params.remove === true && naming) {
      throw new Error("Pass `remove` on its own, without a preset or a program.");
    }

    let warnings: unknown[] = [];
    let apply: (d: TimelineDocument, id: string) => TimelineDocument;
    let declineReason = "Those shapes already have that backdrop.";

    if (params.remove === true) {
      apply = (d, id) => setClipBackdropFx(d, id, null);
      declineReason = "Those shapes have no backdrop to remove.";
    } else if (naming) {
      const resolved = requireBackdrop(params);
      warnings = resolved.warnings;
      // The first backdrop switches the fill off and a preset change keeps
      // the intensity: `chooseClipBackdrop` is where both rules live, so the
      // inspector and a dropped tile agree with this.
      apply = (d, id) => chooseClipBackdrop(d, id, resolved.fx);
    } else if (params.params != null || params.intensity != null) {
      const bare = ids.filter((id) => backdropFxOf(doc.elements[id]) == null);
      if (bare.length > 0) {
        throw new Error(
          `${bare.length === 1 ? "That shape has" : "Those shapes have"} no backdrop to adjust yet; pass a \`presetId\` or a \`program\` first.`,
        );
      }
      apply = (d, id) =>
        patchClipBackdropFx(d, id, {
          params: params.params as FxParams | undefined,
          intensity: params.intensity,
        });
    } else if (params.fillOpacity != null) {
      apply = (d) => d;
      declineReason = "Those shapes already have that fill opacity.";
    } else {
      throw new Error(
        "Name a `presetId` or a `program`, adjust `params` or `intensity`, set `fillOpacity`, or pass `remove`.",
      );
    }

    const result = commit((d: TimelineDocument) => {
      let next = d;
      for (const id of ids) {
        next = apply(next, id);
        // After the backdrop, so a fill the caller named wins over the one a
        // first backdrop switches off.
        if (params.fillOpacity !== undefined) {
          next = setClipFillOpacity(next, id, params.fillOpacity);
        }
      }
      return next;
    }, declineReason);

    const after = currentDoc();
    return {
      ...(result as Record<string, unknown>),
      ...(warnings.length > 0 ? { warnings } : {}),
      clips: ids.map((id) => ({ id, ...backdropSummary(after.elements[id]) })),
    };
  },
});
