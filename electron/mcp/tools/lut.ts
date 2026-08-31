/**
 * Colour lookup tables.
 *
 * Called LUTs throughout, never "filters": `set_video_filters` and
 * `VideoElementType.filter` already own that word for the chroma key and the
 * blurs, and a tool surface with two things called a filter is one an agent
 * will pick wrongly.
 *
 * Two tools, which is all this needs, because a LUT reaches the picture two
 * ways and only one of them is new:
 *
 *  - **As a clip's own grade**, which is `set_lut` and has no analogue anywhere
 *    else in the tool surface.
 *  - **As an adjustment layer**, which is already `add_effect` — a LUT preset
 *    lives in the same registry as the shader presets, so an effect element
 *    pointing at one grades everything beneath its track with no new tool and
 *    no new element type.
 *
 * `list_luts` is separate from `list_effect_presets` rather than folded into
 * it, and that is a size decision as much as a taxonomy one: eighty more rows
 * would push the effect list past what is comfortable to read, and an agent
 * looking for a *look* is asking a different question from one looking for an
 * *effect*. It serves straight from main through `presetLib`, the way the two
 * `list_*_presets` tools do, because the manifests are files on disk and the
 * renderer has nothing to add.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import { mutating, readOnly, tool, type Registrar } from "./define";

/** Enough of a manifest to choose a LUT. A LUT declares no parameters. */
function lutRow(preset: any): any | null {
  let manifest: any;
  try {
    manifest = JSON.parse(preset?.manifestJson ?? "");
  } catch {
    // One broken third-party preset must not take the whole list with it.
    return null;
  }
  if (manifest == null || typeof manifest !== "object" || manifest.kind !== "lut") {
    return null;
  }
  return {
    id: manifest.id ?? preset?.id,
    name: manifest.name,
    category: manifest.category,
    origin: preset?.origin,
    ...(typeof manifest.note === "string" ? { note: manifest.note } : {}),
  };
}

export function registerLutTools(define: Registrar) {
  define(
    "list_luts",
    {
      title: "List colour LUTs",
      description:
        "Every colour LUT installed, including any the user imported. Film and print looks, " +
        "cinematic grades (teal-orange, night-city, golden-hour), vintage, black-and-white with the " +
        "photographic colour separations, warm/cool, vivid, matte, and log conversions for S-Log3, LogC3, V-Log, " +
        "C-Log3, D-Log and HLG. Pass an `id` to set_lut to grade a clip, or to add_effect to grade " +
        "everything beneath a track.",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe('Narrow to one family, e.g. "film" or "log-convert".'),
      },
      annotations: readOnly,
    },
    tool(async (args: any) => {
      // Lazily imported for the reason `read.ts` names: `lib/preset` reaches
      // `electron-is-dev`, and registration has to stay loadable from a test.
      const { presetLib } = await import("../../lib/preset");
      const { presets } = await presetLib.list();
      const all = (presets ?? [])
        .map(lutRow)
        .filter((row: any): row is any => row != null);
      const narrowed =
        args.category == null
          ? all
          : all.filter((row: any) => row.category === args.category);
      return {
        count: narrowed.length,
        categories: [...new Set(all.map((row: any) => row.category))].filter(
          Boolean,
        ),
        luts: narrowed,
      };
    }),
  );

  define(
    "set_lut",
    {
      title: "Grade clips with a LUT",
      description:
        "Apply a LUT to video, image, gif, shape or text clips, or pass presetId:null to clear it. " +
        "This grades the clips themselves. To grade a whole stack instead — everything beneath a row, " +
        "the way an adjustment layer works — use add_effect with the same LUT id and move its track. " +
        "Ids come from list_luts.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        presetId: z
          .string()
          .nullable()
          .describe("A LUT id from list_luts. null removes the LUT."),
        intensity: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe(
            "How strongly it applies, 0-100. Left as it was when omitted, so " +
              "trying several LUTs keeps the strength you dialled in.",
          ),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_lut", args)),
  );
}
