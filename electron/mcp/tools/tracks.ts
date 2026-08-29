/**
 * Track management — which is also how layer order is controlled.
 *
 * `priority` is derived from track order on every mutation and is never
 * authored, so "put the logo in front of the video" is a `move_track` call, not
 * a property write. The descriptions below say so, because an agent that does
 * not know it will reach for `update_clip` and be refused.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import {
  destructive,
  mutating,
  tool,
  trackIdField,
  type Registrar,
} from "./define";

export function registerTrackTools(define: Registrar) {
  define(
    "add_track",
    {
      title: "Add a track",
      description:
        "Add an empty row of the given kind. You rarely need this — adding a clip creates a row when it has to — " +
        "but it is how you make space to stack something in front of what is already there. " +
        "Index 0 is the top row and the front of the composite. Omit `index` and the row lands above the " +
        "topmost row of its own kind — or, when the project has none of that kind yet, where that kind " +
        "belongs: text in front of the picture, audio behind it.",
      inputSchema: {
        kind: z.enum(["video", "audio", "text", "effect"]),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0 is the top row and the front of the composite."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("add_track", args)),
  );

  define(
    "remove_track",
    {
      title: "Remove a track",
      description:
        "Delete a row. Refuses a row that still holds clips unless you pass deleteClips:true, so the safe call " +
        "is the default one.",
      inputSchema: {
        trackId: trackIdField,
        deleteClips: z.boolean().optional().default(false),
      },
      annotations: destructive,
    },
    tool((args) => requestEditor("remove_track", args)),
  );

  define(
    "move_track",
    {
      title: "Reorder tracks",
      description:
        "Move a track to a new position. **This is how you change which clip draws on top** — index 0 is the " +
        "top row and the front-most layer, and a clip's paint order is derived from its track, never set on the " +
        "clip itself. Track names (V1, A2, T1) are derived from kind and order too, so they change with this.",
      inputSchema: {
        trackId: trackIdField,
        toIndex: z
          .number()
          .int()
          .min(0)
          .describe("0 puts the row at the top, in front of everything."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("move_track", args)),
  );
}
