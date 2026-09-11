/**
 * Manual colour adjustments — the Adjust panel's fifteen sliders.
 *
 * One tool. Separate from `set_lut` because the two answer different
 * questions — a LUT is a chosen *look*, these are a clip's own corrections —
 * and they compose: the adjustments run first and the LUT is applied to the
 * corrected picture.
 *
 * The schema lists every key and is strict, so a misspelt slider is refused
 * by zod before it reaches the editor rather than being silently dropped.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import { COLOR_ADJUSTMENTS, mutating, tool, type Registrar } from "./define";

export function registerAdjustTools(define: Registrar) {
  const sliders = Object.fromEntries(
    COLOR_ADJUSTMENTS.map((key) => [key, z.number().optional()]),
  );

  define(
    "set_color_adjustments",
    {
      title: "Adjust clip colour",
      description:
        "Set a clip's colour, lightness and finishing sliders, as in CapCut's Adjust panel. " +
        "Colour: temperature, tint, saturation. Lightness: exposure (±100 = ±2 stops), contrast, " +
        "highlights, shadows, whites, blacks, brilliance. Effects: sharpen, clarity, particles " +
        "(film grain), fade, vignette (+ darkens edges, − lightens). All run −100..100 except " +
        "sharpen, clarity, particles and fade, which run 0..100; 0 is neutral. Keys you omit are " +
        "left as they are; 0 resets one. `reset` clears a group (or all) first, in the same undo " +
        "step. Works on video, image, gif, shape and text clips, before any LUT.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        adjustments: z
          .object(sliders)
          .strict()
          .optional()
          .describe("Slider values to set. Out-of-range values are clamped."),
        reset: z
          .enum(["all", "color", "lightness", "effects"])
          .optional()
          .describe("Put a group, or everything, back to zero before applying `adjustments`."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_color_adjustments", args)),
  );
}
