/**
 * The tools Claude Code sees.
 *
 * Each one validates with zod, forwards to the renderer, and returns the
 * answer. No editing logic lives here — see `bridge.ts` for why it cannot.
 *
 * Three things shape the descriptions below more than anything else:
 *
 *  - **Output is capped.** Claude Code warns at 10,000 tokens of tool output
 *    and truncates at 25,000. Every list is paged and every projection is a
 *    whitelist (`apps/app/src/features/agent/serialize.ts`).
 *  - **Batch beats loop.** `remove_ranges` and `add_subtitles` take arrays
 *    because the alternative — one call per cut, one per caption — costs a
 *    round trip and an undo step each, and an agent that has to undo forty
 *    times to take back one instruction may as well not have undo.
 *  - **Times are absolute timeline milliseconds**, except where a name says
 *    `source`. Transcripts are the one place the two diverge, and
 *    `get_transcript` resolves that before the agent ever sees it.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requestEditor } from "./bridge";
import { transcribeFile } from "./transcribe";

/** Tool results go back as compact JSON text: no indentation to pay for. */
function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

/**
 * Wrap a handler so a thrown error reaches the agent as text it can act on.
 *
 * Untyped on purpose. Letting `registerTool` infer the argument type from the
 * zod shape and then unify it with this wrapper's own generic is enough to send
 * tsc into an exponential instantiation — the whole file OOMs the compiler with
 * this many tools. zod has already validated by the time a handler runs, so the
 * inferred type would be describing a guarantee that is enforced elsewhere.
 */
function tool(run: (args: any) => Promise<unknown> | unknown) {
  return async (args: any) => {
    try {
      return json(await run(args));
    } catch (error) {
      return failure(error);
    }
  };
}

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
const mutating = { readOnlyHint: false, openWorldHint: false } as const;

type ToolShape = Record<string, z.ZodTypeAny>;

type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: ToolShape;
  annotations?: Record<string, boolean>;
};

/**
 * `registerTool` with its generics erased.
 *
 * `McpServer.registerTool` infers the argument type of the handler from the zod
 * shape, through the SDK's zod-3/zod-4 compatibility layer. That inference is
 * pathological here: a *single* call costs about ten seconds of `tsc` and
 * reports TS2589, and seventeen of them exhaust the compiler's heap outright.
 * Measured, not guessed — erasing it at this one call site takes the file from
 * an out-of-memory crash to roughly a second.
 *
 * Nothing is lost at runtime: zod still validates every call, and the schema
 * the agent sees is unchanged. What goes away is a compile-time echo of a
 * guarantee that is enforced at the boundary anyway.
 */
type Registrar = (
  name: string,
  config: ToolConfig,
  handler: (args: any) => Promise<unknown>,
) => void;

const timeRange = z.object({
  startMs: z.number().describe("Start of the range, in timeline milliseconds."),
  endMs: z.number().describe("End of the range, exclusive."),
});

const subtitleStyle = z
  .object({
    fontsize: z.number().optional(),
    textcolor: z.string().optional().describe('Hex, e.g. "#ffffff".'),
    align: z.enum(["left", "center", "right"]).optional(),
    background: z.boolean().optional().describe("Draw a box behind the text."),
    locationX: z.number().optional(),
    locationY: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .optional()
  .describe(
    "Omit for a lower-third caption sized to the project's own resolution.",
  );

export function registerTools(server: McpServer) {
  const define = server.registerTool.bind(server) as unknown as Registrar;
  // ---------------------------------------------------------------- reading

  define(
    "get_project_overview",
    {
      title: "Project overview",
      description:
        "Resolution, frame rate, duration, playhead, track list and clip counts. " +
        "Start here: it is small, and it gives you the track ids the other tools take.",
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
        "Rows omit keyframe data and blob URLs; use get_clip for one clip in full.",
      inputSchema: {
        trackId: z.string().optional(),
        filetype: z
          .enum(["video", "image", "gif", "shape", "text", "audio"])
          .optional(),
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
        "Everything about one clip: full text, position, size, filters, and a summary of its keyframes " +
        "(counts and times — never the baked sample arrays, which run to tens of thousands of values).",
      inputSchema: { elementId: z.string() },
      annotations: readOnly,
    },
    tool((args) => requestEditor("get_clip", args)),
  );

  define(
    "list_assets",
    {
      title: "List asset files",
      description:
        "Files and folders in the project's asset directory. Defaults to the folder open in the asset panel.",
      inputSchema: { dir: z.string().optional() },
      annotations: readOnly,
    },
    tool((args) => requestEditor("list_assets", args)),
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

  // ---------------------------------------------------------------- cutting

  define(
    "remove_ranges",
    {
      title: "Cut ranges out of a clip",
      description:
        "Delete one or more time windows from a clip in a single edit — the main tool for automatic cut editing. " +
        "Pass every range at once: they are interpreted against the clip as it is now, so you do not recompute " +
        "times after each cut, and the whole thing is one undo step for the user. " +
        "With ripple (the default) the remaining pieces close up, which is what makes speech play continuously; " +
        "without it each cut leaves a gap. Ranges that miss the clip are ignored.",
      inputSchema: {
        elementId: z.string(),
        ranges: z.array(timeRange).min(1),
        ripple: z.boolean().optional().default(true),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("remove_ranges", args)),
  );

  define(
    "split_clip",
    {
      title: "Split a clip",
      description:
        "Cut a clip at one or more times without deleting anything. Both halves stay on the same track. " +
        "A time on or outside the clip's edge is ignored, since a zero-length clip would be invisible.",
      inputSchema: {
        elementId: z.string(),
        atMs: z.array(z.number()).min(1),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("split_clip", args)),
  );

  define(
    "trim_clip",
    {
      title: "Trim a clip's edges",
      description:
        "Move a clip's start and/or end to absolute timeline times. " +
        "Clamped by the neighbouring clips and by the length of the source file, so a trim that " +
        "would overlap stops at the boundary instead of failing.",
      inputSchema: {
        elementId: z.string(),
        startMs: z.number().optional(),
        endMs: z.number().optional(),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("trim_clip", args)),
  );

  define(
    "move_clips",
    {
      title: "Move clips",
      description:
        "Move clips in time and/or to another track. `toMs` places the earliest of them and carries the rest " +
        "along, preserving their spacing; `deltaMs` shifts everything by the same amount. " +
        "Atomic: if any clip cannot land where it is asked, none of them move.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        toMs: z.number().optional(),
        deltaMs: z.number().optional(),
        trackId: z.string().optional(),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("move_clips", args)),
  );

  define(
    "delete_clips",
    {
      title: "Delete clips",
      description:
        "Remove clips. With `ripple`, later clips on the same track slide back to close the gap.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        ripple: z.boolean().optional().default(false),
      },
      annotations: { ...mutating, destructiveHint: true },
    },
    tool((args) => requestEditor("delete_clips", args)),
  );

  // -------------------------------------------------------------- subtitles

  define(
    "add_subtitles",
    {
      title: "Add subtitles",
      description:
        "Place many caption lines at once. Always prefer this over repeated add_text: the batch is one undo " +
        "step, and placing them together is what lands them all on a single text track instead of scattering " +
        "them across one track each. " +
        "Times are timeline milliseconds; pass `sourceElementId` if they came from a clip's own source timing " +
        "and they will be converted for you (get_transcript already returns timeline times, so it does not need it).",
      inputSchema: {
        items: z
          .array(
            z.object({
              text: z.string(),
              startMs: z.number(),
              durationMs: z.number(),
            }),
          )
          .min(1),
        style: subtitleStyle,
        sourceElementId: z
          .string()
          .optional()
          .describe("Only if `items` hold source-file times, not timeline times."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("add_subtitles", args)),
  );

  define(
    "add_text",
    {
      title: "Add one text clip",
      description:
        "A single title or caption. For more than one line, use add_subtitles.",
      inputSchema: {
        text: z.string(),
        startMs: z.number(),
        durationMs: z.number(),
        style: subtitleStyle,
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("add_text", args)),
  );

  define(
    "update_clip",
    {
      title: "Change a clip's properties",
      description:
        "Edit appearance: position, size, opacity, rotation, and for text the words, colour, size and alignment. " +
        "Timing is deliberately not writable here — startTime, duration and trim are coupled by invariants — " +
        "so use trim_clip and move_clips for that. The error message lists what this clip accepts.",
      inputSchema: {
        elementId: z.string(),
        patch: z
          .record(z.any())
          .describe('Nested, e.g. {"location": {"x": 100}, "opacity": 50}.'),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("update_clip", args)),
  );

  // ------------------------------------------------------------------- meta

  define(
    "set_playhead",
    {
      title: "Move the playhead",
      description:
        "Seek the editor so the user sees a particular moment. Useful after an edit, to show your work.",
      inputSchema: { atMs: z.number() },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_playhead", args)),
  );

  define(
    "select_clips",
    {
      title: "Select clips",
      description:
        "Highlight clips in the timeline so the user can see which ones you changed.",
      inputSchema: { elementIds: z.array(z.string()) },
      annotations: mutating,
    },
    tool((args) => requestEditor("select_clips", args)),
  );

  define(
    "undo",
    {
      title: "Undo",
      description:
        "Take back the last edit — yours or the user's; it is one shared history. " +
        "Prefer this over trying to reconstruct a previous state by hand.",
      inputSchema: {},
      annotations: mutating,
    },
    tool(() => requestEditor("undo")),
  );

  define(
    "redo",
    {
      title: "Redo",
      description: "Reapply the edit that undo took back.",
      inputSchema: {},
      annotations: mutating,
    },
    tool(() => requestEditor("redo")),
  );
}
