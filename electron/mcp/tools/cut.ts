/**
 * Cutting.
 *
 * Batch beats loop. `remove_ranges` takes an array because the alternative —
 * one call per cut — costs a round trip and an undo step each, and an agent
 * that has to undo forty times to take back one instruction may as well not
 * have undo.
 *
 * Times are absolute timeline milliseconds, and every one of them is snapped to
 * the project's frame grid on the way in, exactly as the mouse's are.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import {
  Z_ORDER_NOTE,
  destructive,
  mutating,
  timeRange,
  tool,
  trackIdField,
  type Registrar,
} from "./define";

export function registerCutTools(define: Registrar) {
  define(
    "remove_ranges",
    {
      title: "Cut ranges out of a clip",
      description:
        "Delete one or more time windows from a clip in a single edit — the main tool for automatic cut editing. " +
        "Pass every range at once: they are interpreted against the clip as it is now, so you do not recompute " +
        "times after each cut, and the whole thing is one undo step for the user. " +
        "With ripple (the default) the remaining pieces close up, which is what makes speech play continuously; " +
        "without it each cut leaves a gap. Ranges that miss the clip are ignored.",
      inputSchema: {
        elementId: z.string(),
        ranges: z.array(timeRange).min(1),
        ripple: z.boolean().optional().default(true),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("remove_ranges", args)),
  );

  define(
    "split_clip",
    {
      title: "Split a clip",
      description:
        "Cut a clip at one or more times without deleting anything. Both halves stay on the same track. " +
        "A time on or outside the clip's edge is ignored, since a zero-length clip would be invisible.",
      inputSchema: {
        elementId: z.string(),
        atMs: z.array(z.number()).min(1),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("split_clip", args)),
  );

  define(
    "trim_clip",
    {
      title: "Trim a clip's edges",
      description:
        "Move a clip's start and/or end to absolute timeline times. " +
        "Clamped by the neighbouring clips and by the length of the source file, so a trim that " +
        "would overlap stops at the boundary instead of failing.",
      inputSchema: {
        elementId: z.string(),
        startMs: z.number().optional(),
        endMs: z.number().optional(),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("trim_clip", args)),
  );

  define(
    "move_clips",
    {
      title: "Move clips",
      description:
        "Move clips in time and/or to another track. `toMs` places the earliest of them and carries the rest " +
        "along, preserving their spacing; `deltaMs` shifts everything by the same amount. " +
        "Atomic: if any clip cannot land where it is asked, none of them move. " +
        "A track only accepts clips of its own kind, so a video clip cannot move onto an audio track. " +
        "Moving a clip to another track also changes what it draws in front of — " +
        Z_ORDER_NOTE,
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        toMs: z.number().optional(),
        deltaMs: z.number().optional(),
        trackId: trackIdField.optional(),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("move_clips", args)),
  );

  define(
    "delete_clips",
    {
      title: "Delete clips",
      description:
        "Remove clips. With `ripple`, later clips on the same track slide back to close the gap. " +
        "Deleting a group takes its contents with it.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        ripple: z.boolean().optional().default(false),
      },
      annotations: destructive,
    },
    tool((args) => requestEditor("delete_clips", args)),
  );

  define(
    "duplicate_clips",
    {
      title: "Duplicate clips",
      description:
        "Copy clips and place the copies elsewhere on the timeline — the agent's version of copy/paste. " +
        "The selection keeps its shape: the earliest copy lands at `toMs` (or the current selection's end if you " +
        "omit it) and the rest keep their relative offsets. Duplicating a group brings its children, re-parented " +
        "to the new group rather than the old one. `repeat` makes a run of copies in one undo step.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        toMs: z.number().optional(),
        deltaMs: z
          .number()
          .optional()
          .describe("Gap between repeats. Defaults to the selection's length."),
        repeat: z.number().int().min(1).max(50).optional().default(1),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("duplicate_clips", args)),
  );

  define(
    "set_clip_speed",
    {
      title: "Change playback speed",
      description:
        "Speed a video or audio clip up or down. 2 is twice as fast and half as long; 0.5 is slow motion. " +
        "The source window is untouched — only how long the clip occupies the timeline changes — so this is " +
        "not a trim and does not lose any of the footage. " +
        "Honoured in the preview and in the export, picture and sound both. " +
        "With `ripple` (the default) later clips on the same track shift to make room or close up; without it, " +
        "a change that would overlap the next clip is refused. " +
        "Keyframes are left at their own times, so speeding a clip up can leave its animation running past the end.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        speed: z.number().min(0.25).max(4),
        ripple: z.boolean().optional().default(true),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_clip_speed", args)),
  );
}
