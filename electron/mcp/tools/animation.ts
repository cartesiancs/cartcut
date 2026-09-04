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
import {
  ANIMATABLE,
  EASINGS,
  PRESETS,
  mutating,
  tool,
  type Registrar,
} from "./define";

export function registerAnimationTools(define: Registrar) {
  define(
    "apply_animation_preset",
    {
      title: "Apply an animation preset",
      description:
        "The common moves, correctly built — one undo step, the track activated for you, the units and the " +
        "curve already right. Prefer this over hand-authoring keyframes. " +
        "`fade_in`/`fade_out` on opacity. `drift` is a Ken Burns, constant-rate over seconds. `punch_in` " +
        "lands hard in under a fifth of a second; `overshoot_in` passes its target and settles back. `pop` " +
        "grows past full size, `slam` arrives oversized and lands. `shake` is a decaying rattle, " +
        "`rotate_settle` rocks past level. `zoom_in`/`zoom_out` are the gentle pair. The eight `slide_*` " +
        "move one box length and fade as they go, named for the direction of travel: `slide_in_up` " +
        "arrives from below. " +
        "Omit `durationMs` for each preset's own length; a punch stretched to a second is not a punch. " +
        "Omit `atMs` and `_in` presets sit at the clip's start, `_out` at its end; give it and every preset " +
        "starts there and runs forward — how you fade mid-shot. One that will not fit is shortened, not " +
        "moved back. " +
        "**`focus`** aims a zoom. Scale is about the clip's centre, so a zoom converges there unless the " +
        "clip is pushed the other way as it grows; `focus` does that. A point in the clip's box, 0-100 per " +
        "axis; scale presets only.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        preset: z.enum(PRESETS),
        durationMs: z
          .number()
          .min(1)
          .optional()
          .describe("Defaults to the preset's own length."),
        atMs: z
          .number()
          .optional()
          .describe(
            "Timeline ms the move starts at. Must be inside every clip in `elementIds`. " +
              "Defaults to the preset's own anchor — the clip's start, or its end for an out preset.",
          ),
        focus: z
          .object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) })
          .optional()
          .describe(
            "Where to zoom towards, 0-100 in the clip's own box. {50,50} is the centre and changes nothing.",
          ),
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
        "`position`, `size`, `maskPosition`, `maskSize` need `x` and `y` per entry (`x` is the width on both " +
        "sizes); the rest take `value`. Units: opacity 0-100, rotation deg, **scale in tenths — 10 is " +
        "unscaled, 12 is 120%**, **size in px** (the clip's box, per axis — not a second scale), mask " +
        "position/size in % of the clip, mask feather in clip px. " +
        "`mask*` needs set_mask first. " +
        "Times are absolute timeline ms and must fall inside the clip; one outside is refused, not clamped. " +
        "**Set `easing` or the move will be soft.** With none, a keyframe gets handles that leave and arrive " +
        "at zero velocity — the gentlest curve there is, and applied to everything it is what makes motion " +
        "read as drifting rather than deliberate. `easing` shapes the segment *leaving* the entry it is on " +
        "(as CSS reads it), so the last entry's is ignored. " +
        "`snap` covers most of the distance immediately and settles: this is a punch-in. " +
        "`overshoot` passes the target and comes back. `anticipate` winds up before it goes. " +
        "`linear` for a constant drift, and `ease_in`/`ease_out`/`ease_in_out` where CSS would use them.",
      inputSchema: {
        elementId: z.string(),
        property: z.enum(ANIMATABLE),
        keyframes: z
          .array(
            z.object({
              atMs: z.number(),
              value: z
                .number()
                .optional()
                .describe("opacity / scale / rotation / maskRotation / maskFeather / maskRoundness"),
              x: z
                .number()
                .optional()
                .describe(
                  "position / maskPosition, and the width of size / maskSize",
                ),
              y: z
                .number()
                .optional()
                .describe(
                  "position / maskPosition, and the height of size / maskSize",
                ),
              easing: z
                .union([z.enum(EASINGS), z.array(z.number()).length(4)])
                .optional()
                .describe(
                  "Shapes the segment leaving this keyframe. A name, or [x1,y1,x2,y2] control points as CSS writes them.",
                ),
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
