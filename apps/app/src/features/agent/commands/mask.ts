/**
 * Masking a clip from the agent surface.
 *
 * One command, and it shares its ops with the panel rather than reimplementing
 * them: `setClipMaskMany` and `setClipMaskFieldsMany` in
 * `features/timeline/maskOps.ts`. That is what keeps an AI edit and a user's
 * own click on the same undo step and the same decline rules — re-applying the
 * shape a clip already has records nothing, from either direction.
 *
 * ## Why the drawn path is not part of this tool
 *
 * `shape: "pen"` is accepted, because a project may already contain one and an
 * agent must be able to move, feather and key it like any other mask. What it
 * cannot do is *supply* the vertices. A path is a drawing made against a
 * picture the agent cannot see well enough to trace, and a tool that took forty
 * numbers would mostly be used to produce a shape nobody wanted. The three
 * built-ins, placed and sized, are what an agent can reason about; the pen
 * belongs to the pointer.
 *
 * Setting `shape: "pen"` on a clip with no path stores a mask that renders as a
 * pass-through, which is the same contract a LUT that is not installed has —
 * so this reports it rather than refusing, for the same reason `set_lut` does.
 */

import { MASK_SHAPES, type MaskShape } from "../../../@types/timeline";
import { coerceMaskShape, maskOf } from "../../mask/maskShape";
import {
  MASKABLE_FILETYPES,
  isMaskable,
  setClipMaskFieldsMany,
  setClipMaskMany,
  type MaskFieldPatch,
} from "../../timeline/maskOps";
import { commit } from "../commit";
import { currentDoc, requireElement } from "../context";
import { registerCommands } from "../registry";

type SetMaskParams = {
  elementIds: string[];
  shape?: MaskShape | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  feather?: number;
  roundness?: number;
  invert?: boolean;
};

/** Every numeric field, checked together so one call reports every mistake. */
function checkNumbers(params: SetMaskParams): void {
  for (const key of [
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "feather",
    "roundness",
  ] as const) {
    const value = params[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error(`set_mask's \`${key}\` must be a finite number.`);
    }
  }
}

registerCommands({
  set_mask: (params: SetMaskParams) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_mask needs at least one id in `elementIds`.");
    }
    checkNumbers(params);

    if (
      params.shape !== undefined &&
      params.shape !== null &&
      coerceMaskShape(params.shape) == null
    ) {
      throw new Error(
        `set_mask's \`shape\` must be one of ${MASK_SHAPES.join(", ")}, ` +
          "or null to remove the mask.",
      );
    }

    const wrongType = ids
      .map((id) => requireElement(doc, id))
      .filter((element) => !isMaskable(element));

    if (wrongType.length > 0) {
      throw new Error(
        `Only ${MASKABLE_FILETYPES.join(", ")} clips carry a mask; ` +
          `got ${wrongType.map((element) => element.filetype).join(", ")}.`,
      );
    }

    // The placement fields, gathered only where the caller supplied both halves
    // of a pair. Half a location is not a location, and defaulting the other
    // half to the centre would move the mask on an axis nobody named.
    const patch: MaskFieldPatch = {};
    if (params.x !== undefined || params.y !== undefined) {
      const existing = maskOf(doc.elements[ids[0]]);
      patch.location = {
        x: params.x ?? existing?.location.x ?? 50,
        y: params.y ?? existing?.location.y ?? 50,
      };
    }
    if (params.width !== undefined || params.height !== undefined) {
      const existing = maskOf(doc.elements[ids[0]]);
      patch.size = {
        width: params.width ?? existing?.size.width ?? 60,
        height: params.height ?? existing?.size.height ?? 60,
      };
    }
    for (const key of ["rotation", "feather", "roundness"] as const) {
      if (params[key] !== undefined) {
        patch[key] = params[key];
      }
    }
    if (params.invert !== undefined) {
      patch.invert = params.invert;
    }

    const hasPatch = Object.keys(patch).length > 0;

    const result = commit(
      (d) => {
        // Shape first: it is what creates or removes the mask, and the fields
        // have nowhere to land until it has. One document, so a shape and a
        // placement given together are one undo step.
        const shaped =
          params.shape === undefined
            ? d
            : setClipMaskMany(d, ids, params.shape);
        return hasPatch ? setClipMaskFieldsMany(shaped, ids, patch) : shaped;
      },
      params.shape === null
        ? "Those clips have no mask to remove."
        : "Those clips already have that mask.",
    );

    // Stored, not refused — see the header. Reported, because the clip renders
    // unmasked here and nothing else would say why.
    const penWithoutPath = ids.some((id) => {
      const mask = maskOf(currentDoc().elements[id]);
      return mask?.shape === "pen" && (mask.path?.length ?? 0) < 3;
    });
    if (penWithoutPath) {
      return {
        ...(result as Record<string, unknown>),
        warning:
          "A pen mask with no drawn path renders as no mask at all. Draw one " +
          "with the pen in the Mask tab, or pick rectangle, star or heart.",
      };
    }
    return result;
  },
});
