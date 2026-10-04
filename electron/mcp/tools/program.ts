/**
 * Programs written on the spot.
 *
 * `add_effect`, `add_transition` and the graphic tools take a `program` in
 * place of a `presetId`. These three are what an agent needs around that:
 * checking a draft before placing it, reading one back, and keeping a good one
 * as a preset folder so it shows up beside the built-ins.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import { mutating, programField, readOnly, tool, type Registrar } from "./define";

export function registerProgramTools(define: Registrar) {
  define(
    "check_program",
    {
      title: "Check a program",
      description:
        "Validate and compile a program without placing it, and get back every error with its file and line " +
        "in your own source. Use it while iterating on a shader or a graphic; add_effect, add_transition and " +
        "add_graphic run the same checks and refuse what this would refuse. The same content always gets the " +
        "same `presetId`, so clips that share a program share its compiled shader.",
      inputSchema: {
        program: programField,
        renderAtMs: z
          .array(z.number().min(0))
          .max(6)
          .optional()
          .describe(
            "Graphics only: draw it alone at these program times into a filmstrip PNG and return its path. Read the file to see it.",
          ),
        durationMs: z.number().min(1).optional().describe("The clip length to draw it as. Default 4000."),
        box: z
          .object({ width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) })
          .optional()
          .describe("Default: the program's designSize, else 1280x720."),
        params: z.record(z.any()).optional(),
      },
      annotations: readOnly,
    },
    tool(async (args) => {
      const result = (await requestEditor("check_program", args, 120_000)) as any;
      const strip = result?.filmstrip;
      if (strip?.pngBase64 == null) {
        return result;
      }
      // Lazily, for the reason `fx.ts` names: `contactSheet` reaches `electron`.
      const { writeSheet, nextIndex } = await import("../contactSheet");
      const times: number[] = strip.atMs ?? [0];
      const path = writeSheet(strip.pngBase64, times[0], times[times.length - 1], nextIndex());
      const { pngBase64: _png, ...rest } = strip;
      return { ...result, filmstrip: { ...rest, path, note: "Read this file to see the frames." } };
    }),
  );

  define(
    "get_program",
    {
      title: "Read a clip's program",
      description:
        "The manifest and sources of the program on a clip, with each source capped at `maxChars` in total " +
        "(default 20000). Also says whether it currently draws, and why not when it does not.",
      inputSchema: {
        elementId: z.string(),
        maxChars: z.number().int().min(200).max(200000).optional(),
      },
      annotations: readOnly,
    },
    tool((args) => requestEditor("get_program", args)),
  );

  define(
    "save_program_as_preset",
    {
      title: "Save a program as a preset",
      description:
        "Write the program on a clip out as a preset folder in the user's presets, under `id` " +
        '(letters, digits, dots, dashes, like "com.me.neon-title"; not "inline."). It then appears in the ' +
        "preset lists and the browser like any other. The clip keeps its own copy, unchanged.",
      inputSchema: {
        elementId: z.string(),
        id: z.string().min(1).max(120),
      },
      annotations: mutating,
    },
    tool(async (args) => {
      const exported = (await requestEditor("export_program", args)) as {
        manifestJson: string;
        sources: Record<string, string>;
        assets: Record<string, string>;
      };
      // Lazily imported for the reason `fx.ts` names: `lib/preset` reaches
      // `electron-is-dev`, and registration has to stay loadable from a test.
      const { presetLib } = await import("../../lib/preset");
      const saved = await presetLib.saveProgram(
        args.id,
        exported.manifestJson,
        exported.sources,
        exported.assets,
      );
      await requestEditor("reload_presets", {});
      return saved;
    }),
  );
}
