/**
 * What part of a clip's source is kept, which way round it faces, and which
 * way up it sits.
 *
 * Three tools over ops the app has had all along. `get_clip` has been reporting
 * `crop` and `flipH`/`flipV` since those features landed, so until now an agent
 * could read two states it had no way to create.
 *
 * The crop rect is in **fractions of the source frame**, matching what
 * `get_clip` reports, so a framing read out of one call can be fed straight
 * back into the next. `features/agent/commands/framing.ts` records why, and
 * why `rotate_clips` is a different edit from `update_clip`'s `rotation`.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import { mutating, tool, type Registrar } from "./define";

export function registerFramingTools(define: Registrar) {
  define(
    "set_crop",
    {
      title: "Crop clips to part of their frame",
      description:
        "Keep part of a video or image clip's source frame and hide the rest. All four numbers are " +
        "fractions of the source frame, the same units get_clip reports: x/y are the top-left corner " +
        "(0,0 is the frame's own corner) and width/height are how much is kept (1 is all of it). So a " +
        "centred half-size crop is x:0.25, y:0.25, width:0.5, height:0.5. Omitted fields keep each " +
        "clip's current value, measured per clip, so passing only `width` narrows each from where it " +
        "already sits. Pass reset:true to show the whole frame again. Cropping does not resize the " +
        "clip on screen; it changes what is inside the same box. Video and image clips only.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        x: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Left edge kept, as a fraction of the source frame."),
        y: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Top edge kept, as a fraction of the source frame."),
        width: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Width kept, as a fraction. 1 is the whole frame."),
        height: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Height kept, as a fraction."),
        reset: z
          .boolean()
          .optional()
          .describe("true shows the whole frame again. Cannot be given with a rect."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_crop", args)),
  );

  define(
    "set_mirror",
    {
      title: "Flip clips",
      description:
        "Mirror a video or image clip left-to-right, top-to-bottom, or both. Both fields are absolute " +
        "rather than toggles: pass horizontal:true to face the picture the other way and " +
        "horizontal:false to put it back, whatever it was doing before. Omit a field to leave that " +
        "axis alone. get_clip reports the current state as flipH and flipV. Video and image clips only.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        horizontal: z
          .boolean()
          .optional()
          .describe("Mirror left-to-right. Omit to leave this axis alone."),
        vertical: z
          .boolean()
          .optional()
          .describe("Mirror top-to-bottom. Omit to leave this axis alone."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_mirror", args)),
  );

  define(
    "rotate_clips",
    {
      title: "Turn clips a quarter turn",
      description:
        "Turn clips and swap their width and height with them, the way the Clip menu's Rotate does, so " +
        "a portrait clip becomes landscape. This is not the same as writing `rotation` through " +
        "update_clip: that turns the picture inside a box that keeps its shape, which is what you want " +
        "for a tilt, and this is what you want for footage shot the wrong way up. `degrees` defaults to " +
        "90 and is a change, not an absolute angle. Rotating a group turns its children with it. Audio " +
        "clips in the selection are skipped.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        degrees: z
          .number()
          .optional()
          .describe("How far to turn, clockwise. Default 90. A change, not an absolute angle."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("rotate_clips", args)),
  );
}
