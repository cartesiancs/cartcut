/**
 * Showing a text clip's lettering a piece at a time.
 *
 * Two tools for one feature at two levels, the way the Animation tab offers a
 * Typewriter button above a unit picker and a progress field.
 *
 * `apply_typewriter` is the one an agent should reach for. A reveal is a unit
 * plus a keyframed scalar, and building one by hand means three calls that have
 * to agree; worse, a hand-built one gets the default easing, whose zero-velocity
 * arrival reads as a stutter rather than as a person at a keyboard.
 *
 * `set_text_reveal` is the only way to *create* a reveal, which is why it is
 * here at all rather than a path in `update_clip`'s whitelist. `revealProgress`
 * is a conditional track gated on the field existing, so until a clip has a
 * reveal, `set_animation`, `add_keyframes` and `get_keyframes` all refuse it.
 * `features/agent/commands/reveal.ts` records why a whitelist path would have
 * been worse than no access at all.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import { EASINGS, REVEAL_UNITS, mutating, tool, type Registrar } from "./define";

export function registerRevealTools(define: Registrar) {
  define(
    "apply_typewriter",
    {
      title: "Type a text clip on",
      description:
        "Reveal a text clip's lettering a piece at a time, typed on from `atMs`. Prefer this over " +
        "building the same thing out of set_text_reveal and add_keyframes: it writes the reveal, both " +
        "keyframes and a linear curve together, and a typewriter left on the default easing reads as a " +
        "stutter rather than as typing. `unit` is what one step shows: a character, a word, or a whole " +
        "line. Give `durationMs` for a length or `unitsPerSecond` for a speed (18 is brisk and " +
        "readable); durationMs wins. Typing that will not fit before the clip ends is compressed rather " +
        "than started earlier, and the result says so. Replaces whatever the clip's revealProgress " +
        "track held, so a second call gives a clean typewriter instead of two moves fighting. Re-time " +
        "it afterwards with add_keyframes; clear it with set_text_reveal unit:null. Text clips only.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        unit: z
          .enum(REVEAL_UNITS)
          .optional()
          .describe(
            "What one step shows. Defaults to the clip's current unit, or character.",
          ),
        durationMs: z
          .number()
          .min(1)
          .optional()
          .describe("How long the whole reveal takes. Wins over unitsPerSecond."),
        unitsPerSecond: z
          .number()
          .positive()
          .optional()
          .describe("A speed instead of a length: units a second. Default 18."),
        atMs: z
          .number()
          .optional()
          .describe(
            "Timeline ms the typing starts at. Must be inside every clip in `elementIds`. Defaults to each clip's own start.",
          ),
        easing: z
          .enum(EASINGS)
          .optional()
          .describe("Defaults to linear, which is what typing looks like."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("apply_typewriter", args)),
  );

  define(
    "set_text_reveal",
    {
      title: "Set how much of a text clip is shown",
      description:
        "The reveal itself, without the keyframes: what one step counts (`unit`), how much is shown " +
        "(`progress`, 0-100, where 100 shows everything and changes nothing), how soft each step's edge " +
        "is (`fade`), and **what a unit does as it arrives** — the `animate*` fields, After Effects' " +
        "Text Animator. " +
        "Each `animate*` value is where a unit **starts** and settles from the clip's own: " +
        "`animateScale: 140` makes a word appear 40% oversized and shrink into place, `animateOffsetY: 20` " +
        "makes it rise. `animateWindow` is how many units move at once — 1 bounces one at a time, 3 is a " +
        "stagger. `animateOpacity` is the opacity it starts at, 0 by default, so 100 moves without fading. " +
        "animate:null drops the movement; unit:null removes the reveal and its revealProgress track. " +
        "A clip needs a reveal before set_animation and add_keyframes will touch `revealProgress`; this is " +
        "what gives it one, and apply_typewriter writes the reveal and the move together. " +
        "`progress` is only the track's fallback, so on a keyframed clip the curve wins. Text clips only.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        unit: z
          .enum(REVEAL_UNITS)
          .nullable()
          .optional()
          .describe("null removes the reveal. Omit to keep the current unit."),
        progress: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("How much of the text is shown. 100 shows all of it."),
        fade: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "How much of one step's turn it spends fading in. 0 is a hard cut.",
          ),
        animate: z
          .null()
          .optional()
          .describe("null removes the movement and keeps the reveal."),
        animateWindow: z
          .number()
          .min(0)
          .max(8)
          .optional()
          .describe("Units moving at once. 1 is one at a time; 3 is a stagger."),
        animateScale: z
          .number()
          .min(0)
          .max(1000)
          .optional()
          .describe("Size a unit starts at, as a percentage. 100 is inert."),
        animateOffsetX: z.number().min(-10000).max(10000).optional(),
        animateOffsetY: z
          .number()
          .min(-10000)
          .max(10000)
          .optional()
          .describe("Offset a unit starts at, in clip pixels. Positive is down."),
        animateRotation: z
          .number()
          .min(-3600)
          .max(3600)
          .optional()
          .describe("Degrees a unit starts rotated, about its own centre."),
        animateBlur: z.number().min(0).max(500).optional(),
        animateOpacity: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Opacity a unit starts at. 0 fades in; 100 does not fade."),
        animateEasing: z
          .enum(EASINGS)
          .optional()
          .describe("How a unit travels from its starting state to settled."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_text_reveal", args)),
  );
}
