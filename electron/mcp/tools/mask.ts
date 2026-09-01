/**
 * Cutting a clip to a shape.
 *
 * One tool, because a mask is one property of one clip and there is nothing to
 * list: the four shapes are a closed set named in the schema, not a registry of
 * presets on disk the way LUTs and effects are.
 *
 * The drawn `pen` path is deliberately not settable from here — see
 * `features/agent/commands/mask.ts` for why. An agent can move, size, rotate,
 * feather and invert a pen mask a user drew; it cannot supply the vertices.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import { MASK_SHAPES, mutating, tool, type Registrar } from "./define";

export function registerMaskTools(define: Registrar) {
  define(
    "set_mask",
    {
      title: "Mask clips to a shape",
      description:
        "Cut video, image, gif, shape or text clips to a shape, hiding everything outside it. " +
        "Pass shape:null to remove the mask. Position and size are percentages of the clip's own " +
        "box — 50/50 is centred, 100/100 fills it — so a mask keeps its place when the clip is " +
        'resized. `pen` uses a path drawn by hand in the Mask tab; setting it without one leaves ' +
        "the clip unmasked. Every field except the shape can be keyframed with add_keyframes " +
        "(maskPosition, maskSize, maskRotation, maskFeather, maskRoundness).",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        shape: z
          .enum(MASK_SHAPES)
          .nullable()
          .optional()
          .describe("null removes the mask. Omit to keep the current shape."),
        x: z.number().optional().describe("Mask centre across the clip, % (50 is centred)."),
        y: z.number().optional().describe("Mask centre down the clip, % (50 is centred)."),
        width: z.number().min(0).optional().describe("Mask width, % of the clip (100 fills it)."),
        height: z.number().min(0).optional().describe("Mask height, % of the clip."),
        rotation: z.number().optional().describe("Degrees, about the mask's own centre."),
        feather: z
          .number()
          .min(0)
          .optional()
          .describe("Edge softness in clip pixels. 0 is a hard edge."),
        roundness: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Corner rounding, 0-100. No effect on a heart, which has no corners."),
        invert: z
          .boolean()
          .optional()
          .describe("Keep the outside instead of the inside — cuts a hole."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_mask", args)),
  );
}
