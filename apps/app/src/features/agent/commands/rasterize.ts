/**
 * Baking text into a picture, from the agent side.
 *
 * Not an `update_clip` patch, and not expressible as one: the edit changes the
 * clip's `filetype`, and the value it has to write — a path to a PNG — does not
 * exist until a canvas has drawn the glyphs and the main process has put the
 * bytes on disk. So it gets a command of its own, in the shape
 * `commands/media.ts` uses for anything with an async step before the commit.
 *
 * `rasterizeTextElements` does the work and takes the single checkpoint, so
 * this file is a thin validating wrapper — it exists to give the agent a
 * sentence back rather than a raw throw, and to report what actually changed.
 */

import { useTimelineStore } from "../../../states/timelineStore";
import { rasterizeTextElements } from "../../element/rasterizeText";
import { clipRow } from "../serialize";
import { ensureUndoBaseline } from "../checkpoint";
import { registerCommands } from "../registry";

registerCommands({
  rasterize_text: async (params: { elementIds: string[] }) => {
    const elementIds = params.elementIds ?? [];
    if (elementIds.length === 0) {
      throw new Error("rasterize_text needs at least one element id.");
    }

    const doc = useTimelineStore.getState().getDocument();
    const missing = elementIds.filter((id) => doc.elements[id] == null);
    if (missing.length > 0) {
      throw new Error(`No clip with id ${missing.join(", ")}.`);
    }

    const notText = elementIds.filter(
      (id) => doc.elements[id].filetype !== "text",
    );
    if (notText.length > 0) {
      throw new Error(
        `Only text clips can be rasterized; ${notText.join(", ")} ${
          notText.length === 1 ? "is" : "are"
        } not.`,
      );
    }

    // The baseline has to exist before the checkpoint inside
    // `rasterizeTextElements`, or the agent's first edit of a freshly opened
    // project is not undoable — the gap `features/agent/checkpoint.ts` exists
    // to close.
    ensureUndoBaseline();

    const results = await rasterizeTextElements(
      elementIds,
      useTimelineStore.getState().cursor ?? 0,
    );

    const failures = results.filter((result) => !result.ok);
    const changed = results.filter((result) => result.ok).map((r) => r.elementId);

    if (changed.length === 0) {
      return {
        ok: false,
        reason:
          failures[0] != null && "reason" in failures[0]
            ? failures[0].reason
            : "Nothing could be rasterized.",
      };
    }

    const after = useTimelineStore.getState().getDocument();
    const names = new Map(after.tracks.map((track) => [track.id, track.name]));

    return {
      ok: true,
      changed,
      clips: changed.map((id) =>
        clipRow(id, after.elements[id], names.get(after.elements[id].trackId)),
      ),
      // Surfaced rather than swallowed: a partial success on a mixed selection
      // is exactly the case where silence would mislead.
      ...(failures.length > 0
        ? {
            failed: failures.map((failure) => ({
              elementId: failure.elementId,
              reason: "reason" in failure ? failure.reason : "unknown",
            })),
          }
        : {}),
    };
  },
});
