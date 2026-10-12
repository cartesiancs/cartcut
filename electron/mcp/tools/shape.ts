/**
 * A shape clip's parametric outline.
 *
 * One tool, because a recipe is one property of one clip and there is nothing
 * to list: the four kinds are a closed set named in the schema, not a registry
 * of presets on disk the way LUTs and effects are.
 *
 * The fields are flat rather than nested, so an agent can change a sweep
 * without restating a start. `set_shape` folds them back into the one `arc`
 * object the document holds.
 *
 * `set_shape_backdrop` is the other property a shape has that nothing else
 * does: an effect or LUT preset run over what is beneath it, inside its
 * outline. A tool of its own, because `set_shape` is about the outline and
 * needs a `kind` on a shape drawn by hand.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import {
  SHAPE_GEOMETRY_KINDS,
  STROKE_ALIGNMENTS,
  mutating,
  programField,
  tool,
  type Registrar,
} from "./define";

/** What names a shape's backdrop. Shared by `set_shape_backdrop` and `add_shape`. */
export const backdropFields = {
  presetId: z
    .string()
    .optional()
    .describe(
      "An effect from list_effect_presets (e.g. com.cartcut.pixelate, com.cartcut.gaussian-blur, " +
        "com.cartcut.motion-blur) or a LUT from list_luts. Or pass `program`.",
    ),
  program: programField
    .optional()
    .describe("An inline effect program, `kind: \"effect\"`, instead of `presetId`."),
  params: z
    .record(z.any())
    .optional()
    .describe("The preset's parameters by key. Any left out take the preset's defaults."),
  intensity: z.number().min(0).max(100).optional().describe("0-100. Default 100."),
};

/** The fill's own strength, under the clip's opacity. */
export const fillOpacityField = z
  .number()
  .min(0)
  .max(100)
  .optional()
  .describe(
    "0-100, the fill alone. A backdrop shows through a translucent fill as a tint; 0 shows the backdrop only.",
  );

/** Shared by `set_shape` and `add_shape`, so the two cannot drift apart. */
export const shapeGeometryFields = {
  cornerRadius: z
    .union([z.number().min(0), z.array(z.number().min(0)).length(4)])
    .optional()
    .describe(
      "Corner rounding in pixels. One number, or four clockwise from the top left " +
        "(rectangles only read all four). Capped at half the adjacent edge, so a large " +
        "value rounds as far as the shape allows rather than turning it inside out.",
    ),
  count: z
    .number()
    .int()
    .min(3)
    .max(60)
    .optional()
    .describe("Points, for polygon and star. A triangle is a polygon with 3."),
  innerRatio: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Star only: the waist, as a fraction of the outer radius. Lower is spikier. " +
        "Left out, it is the ratio at which the star's points come out straight.",
    ),
  arcStart: z
    .number()
    .optional()
    .describe("Ellipse only: where the wedge starts, in degrees clockwise from 12 o'clock."),
  arcSweep: z
    .number()
    .min(0)
    .max(360)
    .optional()
    .describe("Ellipse only: how far the wedge runs, in degrees. 360 is a whole ellipse."),
  hole: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Ellipse only: a hole through the middle, as a fraction of the radius."),
};

export function registerShapeTools(define: Registrar) {
  define(
    "set_shape",
    {
      title: "Change a shape's outline",
      description:
        "Reshape shape clips: round a rectangle's corners, change a polygon's point count, " +
        "make a star spikier, cut an ellipse into a pie or a ring. Pass `kind` to change what " +
        "the shape is, or leave it out to adjust the shape it already is. A shape drawn by hand " +
        "with the Polygon tool has no recipe, so `kind` is required for it and setting one " +
        "replaces its outline.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        kind: z.enum(SHAPE_GEOMETRY_KINDS).optional(),
        ...shapeGeometryFields,
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_shape", args)),
  );

  define(
    "set_shape_backdrop",
    {
      title: "Run an effect inside a shape",
      description:
        "Run an effect or LUT preset over everything painted beneath shape clips, inside their outlines, " +
        "leaving the rest of the frame alone. This is how to blur or pixelate a face, frost a panel behind a " +
        "caption, smear one band sideways (com.cartcut.motion-blur with an `angle`), or grade inside a window. " +
        "A face mosaic is an ellipse with com.cartcut.pixelate; to make it follow the face, parent it with " +
        "set_clip_parent to a null that tracks it (Auto Track in the app makes one, and moves it only, so size " +
        "the ellipse with room to spare). What counts as beneath is decided by track order, as for any clip. " +
        "The first backdrop on a shape switches its fill off (fillOpacity 0) unless you pass `fillOpacity`; " +
        "raise it to tint the region. Pass `params` or `intensity` alone to adjust a backdrop already there, " +
        "and `remove: true` to take it away. Overlay presets are refused. A backdrop whose preset cannot run " +
        "draws the shape's fill solid instead, so a mosaic never fails see-through: get_clip reports " +
        "`backdrop.draws`. `intensity` and numeric parameters animate as for an effect: set_animation and " +
        "add_keyframes with `intensity` or `fx:<key>` on the shape.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        ...backdropFields,
        fillOpacity: fillOpacityField,
        remove: z.boolean().optional().describe("Take the backdrop away. Pass nothing else with it."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_shape_backdrop", args)),
  );

  define(
    "set_clip_decoration",
    {
      title: "Put a border and a drop shadow on clips",
      description:
        "A stroke around a shape, image or video clip and a soft shadow under it — the card border and the " +
        "lift every layout has, across as many clips as you like in one undo step. " +
        "**Do not build a border out of two stacked shapes**; that is what this replaces. " +
        "A shape's border follows its real outline, so a rounded rectangle's corners are rounded and a " +
        "star's border follows its points. An image or video is bordered on its box, rounded by its " +
        "cornerRadius (update_clip). " +
        "Sizes are in the clip's own pixels, so a border grows when the clip is scaled, and the shadow " +
        "rotates with it. `strokeAlign` matters at any useful width: \"inner\" keeps the border inside the " +
        "outline, \"outer\" outside it, \"center\" straddles. " +
        "Naming any field of a decoration switches it on; pass `strokeEnable`/`shadowEnable` false to turn " +
        "one off. Fields left out keep what they had. " +
        "**Text has its own pair**, which strokes the letters rather than the box — use update_clip with " +
        "options.outline and options.shadow for that.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        strokeEnable: z.boolean().optional(),
        strokeWidth: z.number().min(0).max(500).optional().describe("Clip pixels."),
        strokeColor: z.string().optional().describe('Hex, e.g. "#1a1a1a".'),
        strokeOpacity: z.number().min(0).max(100).optional(),
        strokeAlign: z.enum(STROKE_ALIGNMENTS).optional(),
        shadowEnable: z.boolean().optional(),
        shadowOffsetX: z.number().min(-1000).max(1000).optional(),
        shadowOffsetY: z
          .number()
          .min(-1000)
          .max(1000)
          .optional()
          .describe("Positive is downwards, which is where light usually is."),
        shadowBlur: z.number().min(0).max(500).optional(),
        shadowColor: z.string().optional(),
        shadowOpacity: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("A card shadow is faint: 20 to 40, not 100."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_clip_decoration", args)),
  );
}
