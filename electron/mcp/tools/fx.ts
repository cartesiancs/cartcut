/**
 * Transitions and effects.
 *
 * The renderer has shipped both for a long time — 37 transition presets and 39
 * effect presets, drawn by the WebGL compositor in the preview and by the same
 * compositor on the export path. None of it was reachable from here, and
 * `CLAUDE.md` compounded that by saying transitions did not exist, so agents
 * told users a cross-dissolve was impossible.
 *
 * The two `list_*_presets` tools serve straight from main through `presetLib`,
 * the way `list_fonts` does, because the manifests are files on disk and the
 * renderer has nothing to add. Everything else crosses the bridge.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import {
  Z_ORDER_NOTE,
  mutating,
  readOnly,
  tool,
  trackIdField,
  type Registrar,
} from "./define";

/**
 * Enough of a manifest to choose a preset and set its parameters.
 *
 * `manifestJson` is a **string** — `scanPresetRoot` hands the file's bytes
 * across without parsing, because the renderer's registry is what validates a
 * manifest and doing it twice would put two opinions on what a valid preset is.
 * So the parse happens here, and a manifest that will not parse is dropped
 * rather than throwing: one broken third-party preset must not take the whole
 * list with it.
 */
function presetRow(preset: any): any | null {
  let manifest: any;
  try {
    manifest = JSON.parse(preset?.manifestJson ?? "");
  } catch {
    return null;
  }
  if (manifest == null || typeof manifest !== "object") {
    return null;
  }

  return {
    id: manifest.id ?? preset?.id,
    name: manifest.name,
    kind: manifest.kind,
    category: manifest.category,
    origin: preset?.origin,
    params: (Array.isArray(manifest.params) ? manifest.params : []).map(
      (param: any) => ({
        key: param?.key,
        label: param?.label,
        type: param?.type,
        default: param?.default,
        ...(param?.min != null ? { min: param.min } : {}),
        ...(param?.max != null ? { max: param.max } : {}),
        ...(Array.isArray(param?.options)
          ? {
              options: param.options.map((option: any) => ({
                value: option?.value,
                label: option?.label,
              })),
            }
          : {}),
      }),
    ),
  };
}

async function listPresets(kind: "transition" | "effect") {
  // Lazily imported for the reason `read.ts` names: `lib/preset` reaches
  // `electron-is-dev`, and registration has to stay loadable from a test.
  const { presetLib } = await import("../../lib/preset");
  const { presets } = await presetLib.list();
  return (presets ?? [])
    .map(presetRow)
    .filter((row: any): row is any => row != null && row.kind === kind);
}

export function registerFxTools(define: Registrar) {
  define(
    "list_transition_presets",
    {
      title: "List transition presets",
      description:
        "Every transition the app can draw, with the parameters each one takes. Cross-dissolve, dip to " +
        "colour and film dissolve for the invisible ones; whip-pan, cross-zoom, glitch, flash and light-leak " +
        "for the ones meant to be seen. Pass an `id` from here to add_transition.",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe('Narrow to one family, e.g. "slide" or "dissolve".'),
      },
      annotations: readOnly,
    },
    tool(async (args: any) => {
      const all = await listPresets("transition");
      const presets =
        args.category == null
          ? all
          : all.filter((p: any) => p.category === args.category);
      return {
        count: presets.length,
        categories: [...new Set(all.map((p: any) => p.category))].filter(Boolean),
        presets,
      };
    }),
  );

  define(
    "list_effect_presets",
    {
      title: "List effect presets",
      description:
        "Every whole-frame effect, with the parameters each one takes. Colour and tone (teal-orange, " +
        "bleach-bypass, faded-film), optical (bloom, halation, vignette, chromatic-aberration), texture " +
        "(film-grain, vhs, scanlines) and light (flicker, light-sweep, strobe). Pass an `id` to add_effect.",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe('Narrow to one family, e.g. "color" or "texture".'),
      },
      annotations: readOnly,
    },
    tool(async (args: any) => {
      const all = await listPresets("effect");
      const presets =
        args.category == null
          ? all
          : all.filter((p: any) => p.category === args.category);
      return {
        count: presets.length,
        categories: [...new Set(all.map((p: any) => p.category))].filter(Boolean),
        presets,
      };
    }),
  );

  define(
    "list_cuts",
    {
      title: "List the cuts on a track",
      description:
        "Every place one clip meets the next, which is where a transition can go. Reports both clip ids, when " +
        "they meet, and whether a transition is already there. " +
        "`maxDurationMs` is the longest window the two clips can hold. `realFootageMs` is how much of a " +
        "centred one would be **real frames rather than held ones** — a transition reads past the outgoing " +
        "clip's out-point and before the incoming clip's in-point, and where the source runs out the clip holds " +
        "its last frame. A short dissolve that freezes slightly is what every editor does, so this is reported " +
        "rather than refused; trim the clips if you want it all real. Defaults to every video track.",
      inputSchema: {
        trackId: trackIdField.optional(),
      },
      annotations: readOnly,
    },
    tool((args) => requestEditor("list_cuts", args)),
  );

  define(
    "add_transition",
    {
      title: "Add a transition",
      description:
        "Put a transition on the cut between two adjacent clips. It is a mix of two rendered frames, not an " +
        "animation on a clip, so it takes the outgoing and incoming ids rather than a time — list_cuts has " +
        "them. Neither clip moves or is trimmed: the frames it needs are the ones already in the files either " +
        "side of the trim. " +
        "`alignment` decides where the mix sits relative to the cut — centred by default, or `start`/`end` to " +
        "put it entirely on the incoming or outgoing side. " +
        "A request longer than the clips can hold is shortened rather than refused; list_cuts reports the " +
        "ceiling, and how much of it would be real footage.",
      inputSchema: {
        fromId: z.string().describe("The outgoing clip."),
        toId: z.string().describe("The incoming clip."),
        presetId: z.string().describe("An id from list_transition_presets."),
        durationMs: z.number().min(1).optional().describe("Default 500."),
        alignment: z.enum(["center", "start", "end"]).optional(),
        params: z
          .record(z.any())
          .optional()
          .describe("Preset parameters, by the keys list_transition_presets gives."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("add_transition", args)),
  );

  define(
    "set_transition",
    {
      title: "Change a transition",
      description:
        "Swap the preset, change the length, move it relative to the cut, or patch its parameters. Changing " +
        "the preset resets parameters the old one owned, so pass any you want with it in the same call.",
      inputSchema: {
        elementId: z.string(),
        presetId: z.string().optional(),
        durationMs: z.number().min(1).optional(),
        alignment: z.enum(["center", "start", "end"]).optional(),
        params: z.record(z.any()).optional(),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_transition", args)),
  );

  define(
    "remove_transition",
    {
      title: "Remove a transition",
      description:
        "Take a transition off its cut. The two clips are untouched — they were never trimmed to make room — " +
        "so the cut goes back to being a hard one.",
      inputSchema: { elementId: z.string() },
      // Not `destructive`: that flag is for edits a single undo cannot take
      // back. This removes one element and leaves both clips exactly as they
      // were, so one Cmd+Z restores it entirely.
      annotations: mutating,
    },
    tool((args) => requestEditor("remove_transition", args)),
  );

  define(
    "add_effect",
    {
      title: "Add an effect",
      description:
        "Put a whole-frame effect on the timeline: a grade, a grain, a bloom, a glitch. " +
        "**An effect applies to everything painted beneath it**, so it lives on its own row and where that row " +
        "sits is the whole point — the first one is made at the very top, applying to the entire composite, " +
        "and you narrow it by moving its track down with move_track. " +
        Z_ORDER_NOTE +
        " `intensity` is 0-100 and is static; to make an effect come and go, use several short effect clips " +
        "rather than keyframes.",
      inputSchema: {
        presetId: z.string().describe("An id from list_effect_presets."),
        startMs: z.number(),
        durationMs: z.number().min(1),
        intensity: z.number().min(0).max(100).optional().describe("Default 100."),
        params: z.record(z.any()).optional(),
        trackId: trackIdField
          .optional()
          .describe("An existing effect track. One is made if you omit it."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("add_effect", args)),
  );

  define(
    "set_effect",
    {
      title: "Change an effect",
      description:
        "Swap the preset, change the intensity or the blend mode, or patch parameters. Changing the preset " +
        "resets parameters the old one owned, so pass any you want with it in the same call. " +
        "`blend: null` clears the mode, which is what a shader preset wants — it does its own combining.",
      inputSchema: {
        elementId: z.string(),
        presetId: z.string().optional(),
        intensity: z.number().min(0).max(100).optional(),
        blend: z.string().nullable().optional(),
        params: z.record(z.any()).optional(),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_effect", args)),
  );

  define(
    "get_fx",
    {
      title: "Read a transition or effect",
      description:
        "One transition or effect in full: its preset, its parameters, and — for a transition — which clips it " +
        "sits between and the window it actually occupies after the handles were taken into account. " +
        "list_clips reports these as bare rows, because a transition has no appearance of its own to describe.",
      inputSchema: { elementId: z.string() },
      annotations: readOnly,
    },
    tool((args) => requestEditor("get_fx", args)),
  );
}
