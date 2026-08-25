/**
 * Keyframe animation.
 *
 * Times here are absolute timeline milliseconds, like everywhere else in this
 * surface. Internally keyframes are stored relative to the clip's own start;
 * the renderer command does that conversion, because asking an agent that has
 * just read `list_clips` to subtract is asking it to be wrong occasionally.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import { ANIMATABLE, mutating, tool, type Registrar } from "./define";

export function registerAnimationTools(define: Registrar) {
  define(
    "apply_animation_preset",
    {
      title: "Apply an animation preset",
      description:
        "The common moves, correctly built: a fade in or out on opacity, a slow zoom in or out on scale. " +
        "Prefer this over hand-authoring keyframes — it is one undo step, it activates the track for you, and " +
        "it gets the value units right.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        preset: z.enum(["fade_in", "fade_out", "zoom_in", "zoom_out"]),
        durationMs: z.number().min(1).optional().default(250),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("apply_animation_preset", args)),
  );

  define(
    "set_animation",
    {
      title: "Turn a property's animation on or off",
      description:
        "Activate or deactivate a keyframe track. Turning it on seeds a keyframe holding the clip's current " +
        "value, so the picture does not jump. Turning it off leaves the keyframes in place but stops them " +
        "driving the property. add_keyframes activates the track on its own, so you rarely need this first.",
      inputSchema: {
        elementId: z.string(),
        property: z.enum(ANIMATABLE),
        active: z.boolean(),
        seedAtMs: z.number().optional().describe("Defaults to the clip's start."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_animation", args)),
  );

  define(
    "add_keyframes",
    {
      title: "Add keyframes",
      description:
        "Author keyframes on one property, all in one undo step. Activates the track if it is not already on. " +
        "`position` needs both `x` and `y` on every entry; opacity, scale and rotation take `value`. " +
        "Units: opacity 0-100, rotation in degrees, and **scale is in tenths — 10 is unscaled, 12 is 120%**. " +
        "Times are absolute timeline ms and must fall inside the clip; one outside is refused rather than " +
        "clamped, because a keyframe past the clip's end never plays.",
      inputSchema: {
        elementId: z.string(),
        property: z.enum(ANIMATABLE),
        keyframes: z
          .array(
            z.object({
              atMs: z.number(),
              value: z.number().optional().describe("opacity / scale / rotation"),
              x: z.number().optional().describe("position only"),
              y: z.number().optional().describe("position only"),
            }),
          )
          .min(1),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("add_keyframes", args)),
  );

  define(
    "remove_keyframes",
    {
      title: "Remove keyframes",
      description:
        "Delete the keyframes at the given absolute times. A time with no keyframe near it is ignored. " +
        "Use get_keyframes to see what is there.",
      inputSchema: {
        elementId: z.string(),
        property: z.enum(ANIMATABLE),
        atMs: z.array(z.number()).min(1),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("remove_keyframes", args)),
  );
}
