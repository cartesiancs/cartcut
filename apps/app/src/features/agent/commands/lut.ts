/**
 * Grading a clip from the agent surface.
 *
 * One command, and it shares its op with the panel rather than reimplementing
 * it: `setClipLutMany` in `features/timeline/lutOps.ts`. That is what keeps an
 * AI edit and a user's own click on the same undo step and the same decline
 * rules — re-applying a LUT a clip already has records nothing, from either
 * direction.
 *
 * Deliberately **not** validated against the installed set. A LUT id names a
 * file that may be present on one machine and absent on another, and refusing
 * an id this build has not got would mean an agent could not restore a grade
 * from a project it was handed. What it does instead is *say so*: the result
 * reports which ids were not found, so the caller learns the grade will render
 * as a pass-through here without the edit being refused.
 */

import { presetById } from "../../fx/presetRegistry";
import {
  GRADABLE_FILETYPES,
  isGradable,
  setClipLutMany,
} from "../../timeline/lutOps";
import { commit } from "../commit";
import { currentDoc, requireElement } from "../context";
import { registerCommands } from "../registry";

registerCommands({
  set_lut: (params: {
    elementIds: string[];
    presetId: string | null;
    intensity?: number;
  }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_lut needs at least one id in `elementIds`.");
    }
    if (params.presetId !== null && typeof params.presetId !== "string") {
      throw new Error(
        "set_lut needs a `presetId` from list_luts, or null to clear the LUT.",
      );
    }
    if (
      params.intensity !== undefined &&
      (typeof params.intensity !== "number" ||
        !Number.isFinite(params.intensity))
    ) {
      throw new Error("set_lut's `intensity` must be a number from 0 to 100.");
    }

    const wrongType = ids
      .map((id) => requireElement(doc, id))
      .filter((element) => !isGradable(element));

    if (wrongType.length > 0) {
      throw new Error(
        `Only ${GRADABLE_FILETYPES.join(", ")} clips carry a LUT; ` +
          `got ${wrongType.map((element) => element.filetype).join(", ")}. ` +
          "To grade a whole stack, add_effect with the same LUT id instead.",
      );
    }

    const preset =
      params.presetId == null ? null : presetById(params.presetId);
    if (params.presetId != null && preset != null && preset.kind !== "lut") {
      throw new Error(
        `${params.presetId} is a ${preset.kind} preset, not a LUT. ` +
          "Use add_effect for that one.",
      );
    }

    const result = commit(
      (d) => setClipLutMany(d, ids, params.presetId, params.intensity),
      params.presetId == null
        ? "Those clips have no LUT to remove."
        : "Those clips already have that LUT.",
    );

    // Applied either way — see the header — but worth reporting, because the
    // clips will render ungraded on this machine and nothing else would say so.
    if (params.presetId != null && preset == null) {
      return {
        ...(result as Record<string, unknown>),
        warning:
          `No LUT with the id ${params.presetId} is installed here, so these ` +
          "clips will render ungraded until it is. The id has been stored, so " +
          "the grade returns wherever it is installed.",
      };
    }
    return result;
  },
});
