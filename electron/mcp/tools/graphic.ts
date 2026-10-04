/**
 * Graphics: layers drawn by a program, for the typography and motion design
 * the text tools cannot reach.
 *
 * `list_graphic_presets` serves from main, as the effect list does. Placing and
 * changing one crosses the bridge. A graphic is a box like an image, so moving,
 * sizing, fading, keyframing, blending, grading and masking it are the tools
 * that already do those things for any clip.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import { listPresets } from "./fx";
import {
  Z_ORDER_NOTE,
  mutating,
  programField,
  readOnly,
  tool,
  trackIdField,
  type Registrar,
} from "./define";

export function registerGraphicTools(define: Registrar) {
  define(
    "list_graphic_presets",
    {
      title: "List graphic presets",
      description:
        "Every installed graphic: kinetic and stylised titles, lower thirds, cards, distortion, reveals " +
        "and generated backgrounds, with the parameters each takes (text and font ones included). Pass an " +
        "`id` to add_graphic, or write your own as a `program`.",
      inputSchema: {
        category: z.string().optional().describe('e.g. "kinetic", "layout", "background".'),
      },
      annotations: readOnly,
    },
    tool(async (args: any) => {
      const all = await listPresets("graphic");
      const presets =
        args.category == null ? all : all.filter((p: any) => p.category === args.category);
      return {
        count: presets.length,
        categories: [...new Set(all.map((p: any) => p.category))].filter(Boolean),
        presets,
      };
    }),
  );

  define(
    "add_graphic",
    {
      title: "Add a graphic",
      description:
        "Place a layer drawn by a program: an installed preset (`presetId`) or one you write (`program`, " +
        "HTML/CSS or GLSL; check_program first). The box defaults to the program's design size, or the frame, " +
        "centred. Lettering lands on a text row in front of the picture, a GLSL background on a video row. " +
        Z_ORDER_NOTE +
        " Numeric parameters animate as `fx:<key>` with set_animation and add_keyframes.",
      inputSchema: {
        presetId: z.string().optional(),
        program: programField.optional(),
        params: z.record(z.any()).optional().describe("Parameter values by key; the rest keep their defaults."),
        name: z.string().max(80).optional().describe("Shown on the timeline bar."),
        startMs: z.number(),
        durationMs: z.number().min(1).optional().describe("Default 4000."),
        trackId: trackIdField.optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().min(1).optional(),
        height: z.number().min(1).optional(),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("add_graphic", args)),
  );

  define(
    "apply_typography",
    {
      title: "Turn text into typography",
      description:
        "Replace text clips with an HTML graphic, in place: same id, row, timing, box, blend, grade, mask and " +
        "position/opacity/scale/rotation/size keyframes. The text, font, colour, size and alignment go into the " +
        "parameters the program's `bindings` name; `params` you pass win over them. A scaled program is given its " +
        "design aspect about the text's centre. Each clip's `dropped` lists what did not carry (runs, reveal, " +
        "outline, shadow and the like), so restyle those in the program. One undo step.",
      inputSchema: {
        clipIds: z.array(z.string()).min(1),
        presetId: z.string().optional().describe("An HTML graphic from list_graphic_presets."),
        program: programField.optional(),
        params: z.record(z.any()).optional(),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("apply_typography", args)),
  );

  define(
    "set_graphic",
    {
      title: "Change a graphic",
      description:
        "Swap the preset or the program, patch parameter values, or rename it. Swapping resets parameters to " +
        "the new program's defaults, with any you pass laid over them.",
      inputSchema: {
        elementId: z.string(),
        presetId: z.string().optional(),
        program: programField.optional(),
        params: z.record(z.any()).optional(),
        name: z.string().max(80).optional(),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_graphic", args)),
  );
}
