/**
 * The scaffolding every tool module shares.
 *
 * Two constraints shape this file, and both are load-bearing.
 *
 * **`registerTool`'s generics must stay erased.** `McpServer.registerTool`
 * infers the argument type of the handler from the zod shape, through the SDK's
 * zod-3/zod-4 compatibility layer. That inference is pathological here: a
 * *single* call costs about ten seconds of `tsc` and reports TS2589, and
 * seventeen of them exhaust the compiler's heap outright. Measured, not guessed
 * — erasing it takes the file from an out-of-memory crash to roughly a second.
 *
 * Nothing is lost at runtime: zod still validates every call, and the schema
 * the agent sees is unchanged. What goes away is a compile-time echo of a
 * guarantee that is enforced at the boundary anyway.
 *
 * The cast now lives in exactly one place instead of being a convention that
 * every tool module has to remember. A module receives `Registrar` as a
 * parameter type and *cannot* reintroduce the inference by accident.
 *
 * Two rules for anyone adding a tool module:
 *
 *  - Never annotate a handler parameter, and never let a `z.infer` reach a
 *    handler signature.
 *  - Avoid `z.discriminatedUnion` and deep `z.union` in tool shapes — that is
 *    the other known TS2589 generator on this path. Prefer a flat object with
 *    optional fields, and validate the combination in the handler.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Tool results go back as compact JSON text: no indentation to pay for. */
export function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

export function failure(error: unknown) {
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
 * Untyped on purpose — see the header. zod has already validated by the time a
 * handler runs, so an inferred type would be describing a guarantee that is
 * enforced elsewhere.
 */
export function tool(run: (args: any) => Promise<unknown> | unknown) {
  return async (args: any) => {
    try {
      return json(await run(args));
    } catch (error) {
      return failure(error);
    }
  };
}

export const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
export const mutating = { readOnlyHint: false, openWorldHint: false } as const;
export const destructive = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: true,
} as const;

export type ToolShape = Record<string, z.ZodTypeAny>;

export type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: ToolShape;
  annotations?: Record<string, boolean>;
};

export type Registrar = (
  name: string,
  config: ToolConfig,
  handler: (args: any) => Promise<unknown>,
) => void;

/** The one place the generics are erased. */
export function defineRegistrar(server: McpServer): Registrar {
  return server.registerTool.bind(server) as unknown as Registrar;
}

// ------------------------------------------------------------ shared shapes

export const timeRange = z.object({
  startMs: z.number().describe("Start of the range, in timeline milliseconds."),
  endMs: z.number().describe("End of the range, exclusive."),
});

export const subtitleStyle = z
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

/**
 * The one sentence the whole track surface depends on, written once.
 *
 * An agent that has not read it reaches for `update_clip` to bring a title
 * forward and is refused, or reasons about a caption it cannot see without the
 * fact that would explain it. It is repeated into several descriptions on
 * purpose: a tool is read on its own, not alongside its siblings.
 */
export const Z_ORDER_NOTE =
  "Tracks read top row first: index 0 is the front of the composite, the last row is the back. " +
  "A clip's layer is its track — move_track changes it, update_clip cannot.";

export const trackIdField = z
  .string()
  .describe("A track id from get_project_overview.");

/**
 * Every element type the timeline can hold, for filters and enums.
 *
 * `transition` and `effect` are in it. They were not, so `list_clips` could not
 * even be asked for them — while returning them anyway, because nothing
 * filtered them out. A filter that cannot name half of what it returns is worse
 * than no filter.
 */
export const FILETYPES = [
  "video",
  "image",
  "gif",
  "shape",
  "text",
  "audio",
  "group",
  "transition",
  "effect",
  "template",
] as const;

/**
 * How a clip can be composited with what is beneath it.
 *
 * A copy of `@types/timeline.ts`'s `BLEND_MODES`, for the same reason
 * `ANIMATABLE` and `PRESETS` are copies: `.tsconfig` pins `rootDir` to
 * `electron/`, so nothing here can import from `apps/app/src`.
 * `tools.test.ts` asserts the two against each other, so drift is a failing
 * test rather than a mode the schema advertises and the compositor ignores —
 * which is the failure mode that matters here, because an unknown value
 * assigned to `globalCompositeOperation` does not throw.
 */
export const BLEND_MODES = [
  "source-over",
  "darken",
  "multiply",
  "color-burn",
  "lighten",
  "screen",
  "color-dodge",
  "lighter",
  "overlay",
  "soft-light",
  "hard-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;

/**
 * The properties that carry a keyframe track.
 *
 * Another copy, for the `rootDir` reason above, and `tools.test.ts` pins it
 * against `@types/timeline.ts#AnimatableProperty` so drift is a failing test.
 * That matters here in a way it does not for a preset name: `get_clip` reports
 * whichever tracks a clip carries, so an enum narrower than the union would
 * *advertise* a property in one tool's output and *reject* it in another's
 * input — a surface an agent can only discover by being refused.
 *
 * The five `mask*` entries only exist on a clip that has a mask;
 * `animatableProperties` is the gate, and the commands decline through it.
 */
export const ANIMATABLE = [
  "position",
  "opacity",
  "scale",
  "rotation",
  "size",
  "maskPosition",
  "maskSize",
  "maskRotation",
  "maskFeather",
  "maskRoundness",
] as const;

/** The mask shapes a clip can be cut to. A copy of `MASK_SHAPES`. */
export const MASK_SHAPES = ["rectangle", "star", "heart", "pen"] as const;

/**
 * The animation presets.
 *
 * A copy of `features/animation/presets.ts`'s table, and a copy on purpose:
 * `.tsconfig` pins `rootDir` to `electron/` so nothing here can import from
 * `apps/app/src` — the same reason `ANIMATABLE` is duplicated. `tools.test.ts`
 * asserts the two lists against each other, so drift is a failing test rather
 * than a preset the schema advertises and the renderer does not have.
 */
export const PRESETS = [
  "fade_in",
  "fade_out",
  "zoom_in",
  "zoom_out",
  "punch_in",
  "drift",
  "overshoot_in",
  "pop",
  "slam",
  "shake",
  "rotate_settle",
  "slide_in_up",
  "slide_in_down",
  "slide_in_left",
  "slide_in_right",
  "slide_out_up",
  "slide_out_down",
  "slide_out_left",
  "slide_out_right",
] as const;

/** The named easing curves `add_keyframes` accepts. Copied, and pinned, as above. */
export const EASINGS = [
  "linear",
  "ease_in",
  "ease_out",
  "ease_in_out",
  "snap",
  "overshoot",
  "anticipate",
] as const;
