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

    ensureUndoBaseline();
    useTimelineStore.getState().withCheckpoint((d) => {
      let updated: TimelineElement = d.elements[params.elementId];
      for (const [path, value] of writes) {
        updated = setIn(updated, path, value);
      }
      return {
        ...d,
        elements: { ...d.elements, [params.elementId]: updated },
      };
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
