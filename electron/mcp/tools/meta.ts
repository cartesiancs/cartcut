/**
 * Commands that move the editor rather than the document.
 *
 * Undo is exposed deliberately. Every other tool routes through
 * `withCheckpoint`, so an agent that overshoots can take its own edit back
 * instead of trying to reconstruct the previous state by hand — which it would
 * do imperfectly, and which is how an agent turns one bad edit into three.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import { mutating, readOnly, tool, type Registrar } from "./define";

export function registerMetaTools(define: Registrar) {
  define(
    "set_playhead",
    {
      title: "Move the playhead",
      description:
        "Seek the editor so the user sees a particular moment. Useful after an edit, to show your work.",
      inputSchema: { atMs: z.number() },
      annotations: mutating,
    },
    tool((args) => requestEditor("set_playhead", args)),
  );

  define(
    "select_clips",
    {
      title: "Select clips",
      description:
        "Highlight clips in the timeline so the user can see which ones you changed.",
      inputSchema: { elementIds: z.array(z.string()) },
      annotations: mutating,
    },
    tool((args) => requestEditor("select_clips", args)),
  );

  define(
    "get_selection",
    {
      title: "What the user has selected",
      description:
        "The clips currently selected in the timeline. Use it when the user says \"this clip\" or \"the selected ones\".",
      inputSchema: {},
      annotations: readOnly,
    },
    tool(() => requestEditor("get_selection")),
  );

  define(
    "undo",
    {
      title: "Undo",
      description:
        "Take back the last edit — yours or the user's; it is one shared history. " +
        "Prefer this over trying to reconstruct a previous state by hand.",
      inputSchema: {},
      annotations: mutating,
    },
    tool(() => requestEditor("undo")),
  );

  define(
    "redo",
    {
      title: "Redo",
      description: "Reapply the edit that undo took back.",
      inputSchema: {},
      annotations: mutating,
    },
    tool(() => requestEditor("redo")),
  );
}
