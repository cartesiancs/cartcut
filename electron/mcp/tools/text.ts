/**
 * Text, captions, and property edits on any clip.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import {
  BLEND_MODES,
  Z_ORDER_NOTE,
  mutating,
  subtitleStyle,
  tool,
  type Registrar,
} from "./define";

export function registerTextTools(define: Registrar) {
  define(
    "add_subtitles",
    {
      title: "Add subtitles",
      description:
        "Place many caption lines at once. Always prefer this over repeated add_text: the batch is one undo " +
        "step, and placing them together is what lands them all on a single text track instead of scattering " +
        "them across one track each. " +
        "Times are timeline milliseconds; pass `sourceElementId` if they came from a clip's own source timing " +
        "and they will be converted for you (get_transcript already returns timeline times, so it does not need it). " +
        "Caption lines keep the punctuation of the speech they transcribe, full stop included — the opposite of " +
        "a title's convention, and what a viewer reads sentence boundaries from. " +
        "They land on a text track in front of the picture; a `warning` in the result means some of them do not.",
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
        "A single title, lower third or chapter card. For more than one line, use add_subtitles. " +
        "**A title takes no terminal full stop** — a period at the end of an on-screen title reads as a " +
        "typo, and transcript text pasted straight in brings one along. Keep ? and !, and keep punctuation " +
        "inside a multi-clause line; drop only the final period. Captions transcribing speech are the " +
        "exception and keep theirs — those go through add_subtitles. " +
        "The clip lands on a text track in front of the picture; if the result carries a `warning`, " +
        "something is stacked over it. " +
        Z_ORDER_NOTE,
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
        "Edit appearance: position, size, opacity, rotation; for text the words, colour, size and alignment; " +
        "for a shape its fill colour; for a group its name. " +
        "Timing is deliberately not writable here — startTime, duration and trim are coupled by invariants — " +
        "so use trim_clip and move_clips for that, set_clip_speed for speed, set_text_font for fonts, and " +
        "set_video_filters for filters. The error message lists what this clip accepts.",
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

  define(
    "set_text_font",
    {
      title: "Set a text clip's font",
      description:
        "Change the typeface of one or more text clips. Pass a `path` from list_fonts, or \"default\" for the " +
        "built-in face. This writes the font's path, name and type together and registers the face with the " +
        "canvas — setting them one at a time through update_clip would leave the clip drawing in the fallback.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        fontPath: z.string().describe('A path from list_fonts, or "default".'),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_text_font", args)),
  );

  define(
    "rasterize_text",
    {
      title: "Rasterize text into an image clip",
      description:
        "Bake one or more text clips into PNG image clips with the same position, timing, rotation and " +
        "animation — the equivalent of After Effects' \"render and replace\". Use this to freeze a title's " +
        "appearance so it no longer depends on the font being installed, or to treat the lettering as " +
        "artwork. The text properties are gone afterwards: a single undo restores them. Shadows and glows " +
        "are included in the image, which is therefore slightly larger than the text box was.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("rasterize_text", args)),
  );

  define(
    "set_blend_mode",
    {
      title: "Set how a clip combines with what is under it",
      description:
        "Composite a clip with a blend mode instead of stacking it plainly — multiply, screen, overlay, " +
        "lighten, darken and the rest of the standard set. The layer beneath is everything already drawn: " +
        "the clips on lower tracks and then the project background, so a blended clip on the bottom track " +
        'blends with the background colour alone. Pass "source-over" for normal. ' +
        "Two common uses: `multiply` a video over white lettering on a black card puts the picture inside " +
        "the letters, and `screen` lays a light leak, dust or smoke plate over the shot without a matte. " +
        "Video, image, gif, shape and text clips only — audio and groups paint no layer. " +
        "Suspended for the length of a transition, which mixes its two clips itself. " +
        "Applies in both the preview and the exported file.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        blend: z
          .enum(BLEND_MODES)
          .describe('How to composite. "source-over" is normal stacking.'),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_blend_mode", args)),
  );

  define(
    "set_video_filters",
    {
      title: "Set a video clip's filter",
      description:
        "Apply a chroma key or a blur to video clips, or pass filter:null to clear. " +
        "Parameters are structured — chromakey takes `color` (hex) and `threshold` (0-1); blur and radialblur " +
        "take `strength` — so you never have to build the encoded parameter string yourself. " +
        "One filter per clip, which is what the editor's own panel allows. " +
        "Applies in both the preview and the exported file.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        filter: z
          .object({
            name: z.enum(["chromakey", "blur", "radialblur"]),
            color: z
              .string()
              .optional()
              .describe('chromakey only. Hex, e.g. "#00ff00".'),
            threshold: z
              .number()
              .min(0)
              .max(1)
              .optional()
              .describe("chromakey only. How near a colour has to be. Default 0.5."),
            strength: z
              .number()
              .optional()
              .describe("blur / radialblur only."),
          })
          .nullable()
          .describe("null clears the clip's filter."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_video_filters", args)),
  );
}
