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
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import { SHAPE_GEOMETRY_KINDS, mutating, tool, type Registrar } from "./define";

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
}
