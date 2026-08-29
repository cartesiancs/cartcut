/**
 * Reading the project.
 *
 * Output is capped — Claude Code warns at 10,000 tokens of tool output and
 * truncates at 25,000 — so every list here is paged and every projection is a
 * whitelist (`apps/app/src/features/agent/serialize.ts`).
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import {
  CONTACT_SHEET_TIMEOUT_MS,
  MAX_FRAMES,
  nextIndex,
  sampleTimes,
  writeSheet,
} from "../contactSheet";
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
    "analyze_audio",
    {
      title: "Analyse a clip's audio",
      description:
        "Where the sound goes quiet, where it hits, and whether it has a pulse — the things the transcript " +
        "cannot tell you. Returns `silences` (including the ones that are not between words: room tone, a held " +
        "breath, dead air before the take), `onsets` (percussive attacks), `beats`, and a `tempo`. " +
        "Times come back on the timeline, trim and speed accounted for, so they pair directly with " +
        "remove_ranges, split_clip and move_clips. " +
        "**Cut on `beats`, never on bpm arithmetic.** Each beat is measured and re-anchored to the audio, so " +
        "the list stays on the music; a grid extrapolated from a rate drifts, and a drifting grid is worse " +
        "than none because it still looks deliberate. `beats` is empty when there is no pulse worth following. " +
        "`onsets` are finer than beats — subdivisions, consonants, knocks — so use them to place a cut exactly, " +
        "and beats to decide the spacing. " +
        "Onset detection is energy-based: percussive hits well, a legato line poorly. " +
        "Low `tempo.confidence` means there is no pulse to find. Speech scores about 0.2 and music about 0.6; " +
        "that is the correct answer, not a failure. " +
        "Results are cached, so asking twice is cheap; the first call decodes the file.",
      inputSchema: {
        elementId: z
          .string()
          .describe("A video or audio clip, from list_clips."),
        startMs: z
          .number()
          .optional()
          .describe("Only events inside this timeline window."),
        endMs: z.number().optional(),
        maxOnsets: z.number().int().min(1).max(2000).optional().default(200),
      },
      annotations: readOnly,
    },
    tool(async (args: any) => {
      const source: any = await requestEditor("get_transcript_source", {
        elementId: args.elementId,
      });

      // Decoding a long file is seconds to minutes, and it runs entirely in
      // main — the bridge's timeout covers the two short calls either side.
      const { analyzeFile, capAnalysis } = await import("../analyze");
      const analysis = await analyzeFile(source.localpath);

      // Source ms -> timeline ms, and bpm scaled by speed, in the renderer
      // where `geometry.ts` holds the one correct conversion.
      const mapped: any = await requestEditor("map_analysis", {
        elementId: args.elementId,
        silences: analysis.silences,
        onsets: analysis.onsets,
        beats: analysis.beats,
        tempo: analysis.tempo,
      });

      const from = args.startMs ?? -Infinity;
      const to = args.endMs ?? Infinity;
      const inWindow = (at: number) => at >= from && at < to;

      return {
        clipSpan: mapped.clipSpan,
        ...capAnalysis(
          {
            tempo: mapped.tempo,
            silences: mapped.silences.filter(
              (r: any) => r.endMs > from && r.startMs < to,
            ),
            onsets: mapped.onsets.filter(inWindow),
            beats: mapped.beats.filter(inWindow),
          },
          args.maxOnsets,
        ),
      };
    }),
  );

  define(
    "get_contact_sheet",
    {
      title: "Look at the edit",
      description:
        "Render frames of the **composed timeline** as one PNG grid and return its path — then read that " +
        "file to actually look at it. This is the composite the export would deliver, not the source footage: " +
        "titles, shapes, filters, effects and transitions are all in it, drawn by the exporter's own renderer. " +
        "Use it to check what a caption is sitting on top of, whether a cut lands on black, whether a title is " +
        "readable against the picture behind it, and whether a move you keyframed looks like what you meant. " +
        "Give `atMs` for specific instants — cut boundaries are the usual reason — or `startMs`/`endMs` and a " +
        "`count` to sample a stretch evenly. Every tile is labelled with its time, so you can act on what you " +
        "see. " +
        "Each frame costs a video seek, so this is seconds, not milliseconds; ask for a range you care about " +
        "rather than the whole project.",
      inputSchema: {
        atMs: z
          .array(z.number())
          .min(1)
          .max(MAX_FRAMES)
          .optional()
          .describe("Exact instants. Takes precedence over startMs/endMs."),
        startMs: z.number().optional(),
        endMs: z.number().optional(),
        count: z
          .number()
          .int()
          .min(1)
          .max(MAX_FRAMES)
          .optional()
          .default(9)
          .describe("How many frames to sample across the range."),
        columns: z.number().int().min(1).max(6).optional().default(3),
        tileWidth: z
          .number()
          .int()
          .min(80)
          .max(640)
          .optional()
          .describe("Width of one frame in the grid. Default 320."),
      },
      annotations: readOnly,
    },
    tool(async (args: any) => {
      const explicit: number[] | undefined = args.atMs;
      let times = explicit;

      if (times == null) {
        if (args.startMs == null || args.endMs == null) {
          throw new Error(
            "get_contact_sheet needs either `atMs`, or both `startMs` and `endMs`.",
          );
        }
        times = sampleTimes(args.startMs, args.endMs, args.count ?? 9);
      }

      // Seeking video is slow and there can be sixteen of them, so this gets a
      // budget of its own rather than the bridge's default.
      const sheet: any = await requestEditor(
        "render_contact_sheet",
        { atMs: times, columns: args.columns, tileWidth: args.tileWidth },
        CONTACT_SHEET_TIMEOUT_MS,
      );

      const span = { start: times[0], end: times[times.length - 1] };
      const file = writeSheet(
        sheet.pngBase64,
        span.start,
        span.end,
        nextIndex(),
      );

      return {
        path: file,
        note: "Read this file to see the frames.",
        atMs: sheet.atMs,
        columns: sheet.columns,
        rows: sheet.rows,
        width: sheet.width,
        height: sheet.height,
      };
    }),
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
        "The first call on a long clip can take a while. " +
        "Entries may carry `confidence` (0-1) and `speaker`, when the back end reports them — a local " +
        "WhisperX server scores every word and labels speakers if diarisation is on; OpenAI scores whole " +
        "segments and labels nobody. **A low `confidence` means the recogniser was unsure of the words, not " +
        "that the speaker was**: check the audio before putting those words on screen as a caption, and " +
        "prefer a confident neighbouring phrase when choosing a pull-quote. `speaker` is what lets you cut " +
        "between people and caption them apart; segments break on a change of speaker, so a line never mixes " +
        "two.",
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

      // `confidence` and `speaker` are spread rather than named so a field a
      // back end starts reporting reaches the agent without another edit here,
      // and omitted when absent so the common result does not carry a column of
      // `undefined` — the cost of a field is paid per word.
      const raw =
        args.granularity === "word"
          ? transcript.words.map((w) => ({
              text: w.word,
              startMs: w.startMs,
              endMs: w.endMs,
              ...(w.confidence != null ? { confidence: w.confidence } : {}),
              ...(w.speaker != null ? { speaker: w.speaker } : {}),
            }))
          : transcript.segments.map((s) => ({
              text: s.text,
              startMs: s.startMs,
              endMs: s.endMs,
              ...(s.confidence != null ? { confidence: s.confidence } : {}),
              ...(s.speaker != null ? { speaker: s.speaker } : {}),
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
