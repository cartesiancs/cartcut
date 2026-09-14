/**
 * Putting new things on the timeline.
 *
 * Before these, `add_text` was the only way an agent could create anything: it
 * could cut a project apart but not build one.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import {
  SHAPE_GEOMETRY_KINDS,
  Z_ORDER_NOTE,
  mutating,
  tool,
  trackIdField,
  type Registrar,
} from "./define";
import { shapeGeometryFields } from "./shape";

/**
 * Long enough for ffprobe plus a metadata decode on a feature-length file.
 *
 * The only place the bridge's 20s default is wrong. The failure mode it avoids
 * is a confusing one: the tool reports a timeout while the clip still lands on
 * the timeline several seconds later, so the agent's next read disagrees with
 * what it was just told.
 */
const PROBE_TIMEOUT_MS = 120_000;

export function registerMediaTools(define: Registrar) {
  define(
    "add_media",
    {
      title: "Add media to the timeline",
      description:
        "Put video, image, audio or GIF files on the timeline. Pass every file in one call: the batch is one " +
        "undo step, and by default the clips are laid end to end in the order given, which is what \"add these " +
        "five clips\" usually means. Give an item its own `startMs` to place it exactly instead. " +
        "Paths come from list_assets; a bare filename resolves against the open asset folder. " +
        "Video and audio take their length from the file — `durationMs` applies to stills only. " +
        "A file that cannot be read is reported in `skipped` rather than failing the whole call.",
      inputSchema: {
        items: z
          .array(
            z.object({
              path: z.string(),
              startMs: z.number().optional(),
              durationMs: z
                .number()
                .optional()
                .describe("Images and GIFs only. Default 1000."),
              trackId: trackIdField.optional(),
            }),
          )
          .min(1),
        startMs: z
          .number()
          .optional()
          .describe("Where the run begins. Defaults to the playhead."),
        sequential: z
          .boolean()
          .optional()
          .default(true)
          .describe("false stacks everything at the same time instead."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("add_media", args, PROBE_TIMEOUT_MS)),
  );

  define(
    "add_shape",
    {
      title: "Add a shape",
      description:
        "Draw a rectangle, ellipse, polygon or star on the canvas. Useful as a background, a lower-third bar, " +
        "or a block to mask something out. Corners can be rounded, a polygon's point count set, a star's " +
        "spikiness chosen and an ellipse cut into a pie or a ring; set_shape changes any of it afterwards. " +
        '"triangle" is a polygon with 3 points and is accepted as a name for one. ' +
        "Pass `points` instead of `kind` for an arbitrary polygon, in a 0-100 box; such a shape has no recipe, " +
        "and set_shape then needs a `kind` to give it one. " +
        "A shape goes on a video track, so a lower-third bar needs a row between the picture and the text — " +
        Z_ORDER_NOTE,
      inputSchema: {
        kind: z
          .enum([...SHAPE_GEOMETRY_KINDS, "triangle"])
          .optional()
          .default("rectangle"),
        ...shapeGeometryFields,
        points: z
          .array(z.array(z.number()).length(2))
          .optional()
          .describe("[[x, y], ...] in a 0-100 box. Overrides `kind`."),
        startMs: z.number().optional().describe("Defaults to the playhead."),
        durationMs: z.number().optional().default(1000),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        fillColor: z.string().optional().describe('Hex, e.g. "#ffffff".'),
        opacity: z.number().min(0).max(100).optional(),
        rotation: z.number().optional(),
        trackId: trackIdField.optional(),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("add_shape", args)),
  );
}
