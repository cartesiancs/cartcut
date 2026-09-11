/**
 * Colour adjustments from the agent surface.
 *
 * One command over the panel's own ops (`timeline/adjustOps.ts`), so an agent's
 * edit and the user's slider share one undo step and one set of decline rules.
 * A reset and a patch in the same call are one document, and so one undo step:
 * "start from zero and set exposure to 20" is a single edit, not two.
 */

import { COLOR_ADJUSTMENT_KEYS } from "../../../@types/timeline";
import { ADJUST_GROUPS, type AdjustGroup } from "../../adjust/spec";
import { adjustOf, coerceAdjustPatch } from "../../renderer/adjust";
import {
  ADJUSTABLE_FILETYPES,
  isAdjustable,
  resetClipAdjustMany,
  setClipAdjustMany,
} from "../../timeline/adjustOps";
import { commit } from "../commit";
import { currentDoc, requireElement } from "../context";
import { registerCommands } from "../registry";

const RESETS = ["all", ...ADJUST_GROUPS] as const;
type Reset = (typeof RESETS)[number];

registerCommands({
  set_color_adjustments: (params: {
    elementIds: string[];
    adjustments?: unknown;
    reset?: Reset;
  }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_color_adjustments needs at least one id in `elementIds`.");
    }
    if (params.adjustments == null && params.reset == null) {
      throw new Error(
        "set_color_adjustments needs `adjustments`, `reset`, or both. " +
          `Adjustments are ${COLOR_ADJUSTMENT_KEYS.join(", ")}.`,
      );
    }
    if (params.reset != null && !RESETS.includes(params.reset)) {
      throw new Error(
        `set_color_adjustments' \`reset\` must be one of ${RESETS.join(", ")}.`,
      );
    }

    let patch = {};
    if (params.adjustments != null) {
      const coerced = coerceAdjustPatch(params.adjustments);
      if (!coerced.ok) {
        throw new Error(coerced.error);
      }
      patch = coerced.patch;
    }

    const wrongType = ids
      .map((id) => requireElement(doc, id))
      .filter((element) => !isAdjustable(element));
    if (wrongType.length > 0) {
      throw new Error(
        `Only ${ADJUSTABLE_FILETYPES.join(", ")} clips carry colour adjustments; ` +
          `got ${wrongType.map((element) => element.filetype).join(", ")}.`,
      );
    }

    const reset = params.reset;
    const result = commit((d) => {
      const cleared =
        reset == null
          ? d
          : resetClipAdjustMany(d, ids, reset === "all" ? undefined : (reset as AdjustGroup));
      return setClipAdjustMany(cleared, ids, patch);
    }, "Those clips already have those adjustments.");

    // What each clip now carries, so the agent does not need a `get_clip` to
    // learn what a merge left behind.
    const after = currentDoc();
    return {
      ...(result as Record<string, unknown>),
      clips: ids.map((id) => ({ id, adjust: adjustOf(after.elements[id]) ?? {} })),
    };
  },
});
