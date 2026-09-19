/**
 * Property edits on an existing clip.
 *
 * `update_clip` lived in `text.ts` because text was the only element type with
 * anything worth patching. It never was a text command — it writes position and
 * opacity on every visual clip — and now that shapes, groups and video filters
 * have writable fields too, keeping it there would be actively misleading.
 *
 * What may be written, and why the exclusions are exclusions, is in
 * `writable.ts`.
 */

import { useTimelineStore } from "../../../states/timelineStore";
import { setIn } from "../../../utils/immutable";
import type { TimelineElement } from "../../../@types/timeline";
import { ensureUndoBaseline } from "../checkpoint";
import { currentDoc, requireElement } from "../context";
import { registerCommands } from "../registry";
import { clipRow } from "../serialize";
import { flatten, rejectionFor, writablePaths } from "./writable";
import { affectsTextBlock, withFittedTextHeights } from "../../element/textFit";
import { setTextWithRuns } from "../../timeline/textRunOps";

registerCommands({
  update_clip: (params: { elementId: string; patch: Record<string, any> }) => {
    const doc = currentDoc();
    const element = requireElement(doc, params.elementId);

    const allowed = writablePaths(element);
    const writes = flatten(params.patch ?? {});
    if (writes.length === 0) {
      throw new Error("update_clip needs a non-empty `patch`.");
    }

    const rejected = writes
      .map(([path]) => path.join("."))
      .filter((name) => !allowed.some((path) => path.join(".") === name));

    if (rejected.length > 0) {
      throw new Error(
        `update_clip cannot write ${rejected.join(", ")} on a ${element.filetype} clip. ` +
          `Writable: ${allowed.map((p) => p.join(".")).join(", ")}. ` +
          `Use trim_clip or move_clips to change timing, set_clip_speed for speed, ` +
          `set_text_font for fonts, set_video_filters for filters, and ` +
          `set_blend_mode for blend modes.`,
      );
    }

    // Bounds are checked before anything is written, so a patch with one bad
    // field does not leave the other fields applied.
    const outOfRange = writes
      .map(([path, value]) => rejectionFor(path.join("."), value))
      .filter((reason): reason is string => reason != null);

    if (outOfRange.length > 0) {
      throw new Error(outOfRange.join(" "));
    }

    // A text clip's box is measured from its text, so anything that changes
    // what the block looks like invalidates the stored height. An explicit
    // `height` in the same patch is the caller asking for a box, and wins.
    const rewraps =
      affectsTextBlock(writes.map(([path]) => path)) &&
      !writes.some(([path]) => path.join(".") === "height");

    // The string is the one field that cannot be a plain `setIn`. A text clip's
    // per-range styling is stored as offsets into it, so rewriting the string
    // without moving them leaves every styled stretch on the wrong characters.
    // `setTextWithRuns` is the one writer that keeps the two together.
    const textWrite = writes.find(
      ([path, value]) =>
        path.length === 1 && path[0] === "text" && typeof value === "string",
    );

    ensureUndoBaseline();
    useTimelineStore.getState().withCheckpoint((d) => {
      const base =
        textWrite == null
          ? d
          : setTextWithRuns(d, params.elementId, textWrite[1] as string);

      let updated: TimelineElement = base.elements[params.elementId];
      for (const [path, value] of writes) {
        if (path === textWrite?.[0]) {
          continue;
        }
        updated = setIn(updated, path, value);
      }
      const next = {
        ...base,
        elements: { ...base.elements, [params.elementId]: updated },
      };
      return rewraps
        ? withFittedTextHeights(next, [params.elementId])
        : next;
    });

    const after = useTimelineStore.getState().getDocument();
    const names = new Map(after.tracks.map((t) => [t.id, t.name]));
    const current = after.elements[params.elementId];

    return {
      ok: true,
      changed: writes.map(([path]) => path.join(".")),
      clip: clipRow(params.elementId, current, names.get(current.trackId)),
    };
  },
});
