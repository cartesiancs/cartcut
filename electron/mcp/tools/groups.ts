/**
 * Groups.
 *
 * A group is a *spatial* parent — After Effects' null object. It moves, rotates
 * and scales its children on the canvas. It is not a nested sequence: it does
 * not move them in time, gate their visibility, or change their layer order.
 * Every description here says so, because "group them and move them together"
 * is the natural reading and it is the wrong one — `move_clips` moves clips in
 * time, on any number of tracks, without needing a group at all.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import { destructive, mutating, tool, type Registrar } from "./define";

export function registerGroupTools(define: Registrar) {
  define(
    "create_null",
    {
      title: "Create a null object",
      description:
        "Add an empty transform parent — After Effects' null object — that draws nothing. Attach clips to it " +
        "afterwards with `set_clip_parent`, then move, rotate or scale the null to move all of them together " +
        "on the canvas. Their own keyframes are not touched: the null's transform composes on top at draw " +
        "time. Use this when the clips do not exist yet, or when you want one handle to animate several " +
        "clips from; use `group_clips` instead to wrap clips that already exist. Spatial only — a null does " +
        "not move its children in time or change their layer order.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Shown on the null's bar. Defaults to \"Null\"."),
        color: z.string().optional(),
        size: z
          .number()
          .optional()
          .describe(
            "One side of the pivot square, in project pixels. Not a size to draw — nothing paints a null — " +
              "it is the box it rotates and scales about. Defaults to 100.",
          ),
        x: z
          .number()
          .optional()
          .describe("Where the pivot sits. Defaults to the centre of the frame."),
        y: z.number().optional(),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("create_null", args)),
  );

  define(
    "group_clips",
    {
      title: "Group clips",
      description:
        "Bind clips to a shared transform, so moving, rotating or scaling the group moves all of them on the " +
        "canvas together. Spatial only — the group does not move its children in time or change their layer " +
        "order, and `move_clips` already moves several clips at once without one. " +
        "Audio cannot be grouped. Deleting a group deletes its contents.",
      inputSchema: {
        elementIds: z.array(z.string()).min(2),
        name: z.string().optional(),
        color: z.string().optional(),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("group_clips", args)),
  );

  define(
    "ungroup",
    {
      title: "Ungroup",
      description:
        "Release a group's children, baking the group's current transform into each one so nothing moves on " +
        "screen. If the group is animated this is lossy — only its transform at `atMs` survives — so it is " +
        "refused unless you pass force:true.",
      inputSchema: {
        groupIds: z.array(z.string()).min(1),
        atMs: z
          .number()
          .optional()
          .describe("Which moment's transform to bake. Defaults to the playhead."),
        force: z.boolean().optional().default(false),
      },
      annotations: destructive,
    },
    tool((args) => requestEditor("ungroup", args)),
  );

  define(
    "set_clip_parent",
    {
      title: "Move clips in or out of a group",
      description:
        "Re-parent clips to an existing group, or pass parentId:null to release them. The clips do not move on " +
        "screen — their own transform is rewritten to compensate.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1),
        parentId: z.string().nullable(),
        atMs: z.number().optional().describe("Defaults to the playhead."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_clip_parent", args)),
  );
}
