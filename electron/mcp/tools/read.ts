/**
 * Reading the project.
 *
 * Output is capped — Claude Code warns at 10,000 tokens of tool output and
 * truncates at 25,000 — so every list here is paged and every projection is a
 * whitelist (`apps/app/src/features/agent/serialize.ts`).
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
// `../transcribe` and `../../lib/font` are *not* imported at the top. Both
// reach `electron-is-dev`, which throws outside an Electron process — and that
// would make this whole module unloadable from a test for the sake of two
// handlers. They are imported lazily where they are used. Registration must
// stay side-effect-free so `tools/tools.test.ts` can enumerate the tool list.
import {
  ANIMATABLE,
  FILETYPES,
  Z_ORDER_NOTE,
  readOnly,
  tool,
  trackIdField,
  type Registrar,
} from "./define";

export function registerReadTools(define: Registrar) {
  define(
    "get_project_overview",
    {
      title: "Project overview",
      description:
        "Resolution, frame rate, duration, playhead, track list and clip counts. " +
        "Start here: it is small, and it gives you the track ids the other tools take. " +
        Z_ORDER_NOTE,
      inputSchema: {},
      annotations: readOnly,
    },
    tool(() => requestEditor("get_project_overview")),
  );

  define(
    "list_clips",
    {
      title: "List clips",
      description:
        "Clips on the timeline as compact rows, newest filters first. " +
        "Paged: check `truncated` and `total`, and raise `offset` rather than assuming you have seen everything. " +
        "Rows omit keyframe data and blob URLs; use get_clip for one clip in full. " +
        "Rows read by track from the top down — the first rows are the front-most layers — then left to " +
        "right in time.",
      inputSchema: {
        trackId: trackIdField.optional(),
        filetype: z.enum(FILETYPES).optional(),
        startMs: z
          .number()
          .optional()
          .describe("Only clips overlapping at or after this time."),
        endMs: z.number().optional(),
        limit: z.number().int().min(1).max(500).optional().default(100),
        offset: z.number().int().min(0).optional().default(0),
      },
      annotations: readOnly,
    },
    tool((args) => requestEditor("list_clips", args)),
  );

  define(
    "get_clip",
    {
      title: "Get one clip",
      description:
        "Everything about one clip: full text, position, size, filters, group membership, and a summary of its " +
        "keyframes (counts and times — never the baked sample arrays, which run to tens of thousands of values).",
      inputSchema: { elementId: z.string() },
      annotations: readOnly,
    },
    tool((args) => requestEditor("get_clip", args)),
  );

  define(
    "get_keyframes",
    {
      title: "Get a clip's keyframes",
      description:
        "The authored keyframes on one property: their times, values and bezier handles. " +
        "Times come back as absolute timeline milliseconds, the same way every other tool speaks. " +
        "Paged — a hand-authored curve is a handful of points, but nothing stops one per frame.",
      inputSchema: {
        elementId: z.string(),
        property: z.enum(ANIMATABLE),
        limit: z.number().int().min(1).max(200).optional().default(100),
        offset: z.number().int().min(0).optional().default(0),
      },
      annotations: readOnly,
    },
    tool((args) => requestEditor("get_keyframes", args)),
  );

  define(
    "list_assets",
    {
      title: "List asset files",
      description:
        "Files and folders in the project's asset directory. Defaults to the folder open in the asset panel. " +
        "These are the paths add_media takes.",
      inputSchema: { dir: z.string().optional() },
      annotations: readOnly,
    },
    tool((args) => requestEditor("list_assets", args)),
  );

  define(
    "list_fonts",
    {
      title: "List installed fonts",
      description:
        "Fonts available to set_text_font, as {name, path}. Paged: a machine can carry hundreds. " +
        "Pass `query` to filter by name.",
      inputSchema: {
        query: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
        offset: z.number().int().min(0).optional().default(0),
      },
      annotations: readOnly,
    },
    // No bridge hop: the font list already lives in main, behind the same
    // function `ipcMain.handle("font:getLists")` serves the renderer with.
    tool(async (args: any) => {
      // `getFontList` declares an `event` parameter it never reads — it is an
      // `ipcMain.handle` handler by shape. Calling it directly is the point:
      // the font list already lives in main, so this needs no bridge hop.
      const { fontLib } = await import("../../lib/font");
      const result: any = await fontLib.getFontList(undefined);
      const all: Array<{ name: string; path: string; type: string }> =
        result?.fonts ?? [];

      const query = typeof args.query === "string" ? args.query.toLowerCase() : null;
      const matching =
        query == null
          ? all
          : all.filter((font) => font.name?.toLowerCase().includes(query));

      const offset = Math.max(0, Math.floor(args.offset ?? 0));
      const limit = Math.max(1, Math.floor(args.limit ?? 50));
      const items = matching.slice(offset, offset + limit);

      return {
        fonts: items.map((font) => ({
          name: font.name,
          path: font.path,
          type: font.type,
        })),
        total: matching.length,
        offset,
        truncated: offset + items.length < matching.length,
      };
    }),
  );

  define(
    "get_transcript",
    {
      title: "Transcribe a clip",
      description:
        "Speech in a video or audio clip, with timings already mapped onto the timeline — " +
        "trim and speed are accounted for, and words the user trimmed away are not returned. " +
        "This is how you decide where to cut. " +
        'Default granularity "segment" gives caption-sized lines; "word" is much larger, ' +
        "so pair it with startMs/endMs when you need it. Results are cached, so asking twice is cheap. " +
        "The first call on a long clip can take a while.",
      inputSchema: {
        elementId: z.string(),
        granularity: z.enum(["segment", "word"]).optional().default("segment"),
        startMs: z
          .number()
          .optional()
          .describe("Only entries overlapping this timeline window."),
        endMs: z.number().optional(),
        method: z
          .enum(["local", "openai"])
          .optional()
          .describe("Defaults to whichever back end the user has configured."),
      },
      annotations: readOnly,
    },
    tool(async (args: any) => {
      const source: any = await requestEditor("get_transcript_source", {
        elementId: args.elementId,
      });

      // Transcription is minutes, not milliseconds — the bridge's default
      // timeout does not apply here because this runs entirely in main.
      const { transcribeFile } = await import("../transcribe");
      const transcript = await transcribeFile(source.localpath, args.method);

      const raw =
        args.granularity === "word"
          ? transcript.words.map((w) => ({
              text: w.word,
              startMs: w.startMs,
              endMs: w.endMs,
            }))
          : transcript.segments.map((s) => ({
              text: s.text,
              startMs: s.startMs,
              endMs: s.endMs,
            }));

      // Source ms -> timeline ms happens in the renderer, where `geometry.ts`
      // holds the one correct conversion.
      const mapped: any = await requestEditor("map_transcript", {
        elementId: args.elementId,
        items: raw,
      });

      const windowed = mapped.items.filter((item: any) => {
        if (args.endMs != null && item.startMs >= args.endMs) return false;
        if (args.startMs != null && item.endMs <= args.startMs) return false;
        return true;
      });

      return {
        elementId: args.elementId,
        granularity: args.granularity ?? "segment",
        method: transcript.method,
        clipSpan: mapped.clipSpan,
        count: windowed.length,
        items: windowed,
      };
    }),
  );
}
