/**
 * Framing a clip: what part of the source is kept, which way round it faces,
 * and which way up it sits.
 *
 * Three commands over three op modules that already existed and had no caller
 * on this surface. `serialize.ts` has been reporting `crop` and `flipH`/`flipV`
 * since those features landed, so until now an agent could read two states it
 * had no way to create. Its comment beside the crop block even names the tool
 * that would take them.
 *
 * ## Crop is in fractions, not percentages
 *
 * `serialize.ts` reports the rect as fractions of the source frame, calling it
 * "the unit the field stores and the one any future `set_crop` would take".
 * Taking percentages here would mean a tool whose output cannot be fed back
 * into its own input, which is the sort of thing an agent gets wrong once and
 * then gets wrong consistently.
 *
 * ## Rotation here is not `update_clip`'s `rotation`
 *
 * `update_clip` writes the free-angle `rotation` field directly. `rotate_clips`
 * is the quarter-turn the Clip menu performs: it turns the picture **and swaps
 * the box**, so a portrait clip becomes landscape. Writing 90 into `rotation`
 * leaves a landscape box with a sideways picture in it. Both are legitimate and
 * they are different edits.
 */

import type { CropRect } from "../../../@types/timeline";
import {
  CROPPABLE_FILETYPES,
  cropOf,
  isCroppable,
  resetClipCrop,
  setClipCrop,
} from "../../timeline/cropOps";
import {
  MIRRORABLE_FILETYPES,
  isMirrorable,
  setClipMirror,
} from "../../timeline/mirrorOps";
import { canRotateClips, rotateClips } from "../../timeline/rotateOps";
import { commit } from "../commit";
import {
  currentDoc,
  playheadMs,
  projectBakeHz,
  requireElement,
} from "../context";
import { registerCommands } from "../registry";

type SetCropParams = {
  elementIds: string[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  reset?: boolean;
};

type SetMirrorParams = {
  elementIds: string[];
  horizontal?: boolean;
  vertical?: boolean;
};

/** Every numeric field, checked together so one call reports every mistake. */
function checkNumbers(
  name: string,
  params: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = params[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error(`${name}'s \`${key}\` must be a finite number.`);
    }
  }
}

registerCommands({
  set_crop: (params: SetCropParams) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_crop needs at least one id in `elementIds`.");
    }
    checkNumbers("set_crop", params as Record<string, unknown>, [
      "x",
      "y",
      "width",
      "height",
    ]);

    const wrongType = ids
      .map((id) => requireElement(doc, id))
      .filter((element) => !isCroppable(element));

    if (wrongType.length > 0) {
      throw new Error(
        `Only ${CROPPABLE_FILETYPES.join(", ")} clips can be cropped; ` +
          `got ${wrongType.map((element) => element.filetype).join(", ")}.`,
      );
    }

    const hasRect =
      params.x !== undefined ||
      params.y !== undefined ||
      params.width !== undefined ||
      params.height !== undefined;

    if (params.reset === true && hasRect) {
      throw new Error(
        "set_crop takes either `reset: true` or a rect, not both.",
      );
    }
    if (params.reset !== true && !hasRect) {
      throw new Error(
        "set_crop needs `x`, `y`, `width` or `height`, or `reset: true` to show the whole frame.",
      );
    }

    const cursor = playheadMs();
    const bakeHz = projectBakeHz();

    if (params.reset === true) {
      return commit(
        (d) => ids.reduce((next, id) => resetClipCrop(next, id, cursor, bakeHz), d),
        "Those clips already show their whole frame.",
      );
    }

    return commit(
      (d) =>
        ids.reduce((next, id) => {
          // Each clip is measured against its **own** framing, so a call that
          // names only `width` narrows every clip from wherever it already sits
          // rather than snapping them all to the first one's rect.
          const existing = cropOf(next.elements[id]);
          const rect: CropRect = {
            x: params.x ?? existing.x,
            y: params.y ?? existing.y,
            width: params.width ?? existing.width,
            height: params.height ?? existing.height,
          };
          return setClipCrop(next, id, rect, cursor, bakeHz);
        }, d),
      "Those clips already have that framing, or the rect falls outside the frame.",
    );
  },

  set_mirror: (params: SetMirrorParams) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_mirror needs at least one id in `elementIds`.");
    }
    if (params.horizontal === undefined && params.vertical === undefined) {
      throw new Error("set_mirror needs `horizontal` or `vertical`.");
    }

    const wrongType = ids
      .map((id) => requireElement(doc, id))
      .filter((element) => !isMirrorable(element));

    if (wrongType.length > 0) {
      throw new Error(
        `Only ${MIRRORABLE_FILETYPES.join(", ")} clips can be mirrored; ` +
          `got ${wrongType.map((element) => element.filetype).join(", ")}.`,
      );
    }

    /*
     * Absolute, not a toggle. `toggleMirror` is what the menu item needs,
     * because a person can see which way the clip is already facing; an agent
     * often cannot, and a toggle would make "flip this" depend on a state it
     * would have to read first and might race.
     */
    return commit((d) => {
      let next = d;
      for (const id of ids) {
        if (params.horizontal !== undefined) {
          next = setClipMirror(next, id, "h", params.horizontal);
        }
        if (params.vertical !== undefined) {
          next = setClipMirror(next, id, "v", params.vertical);
        }
      }
      return next;
    }, "Those clips already face that way.");
  },

  rotate_clips: (params: { elementIds: string[]; degrees?: number }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("rotate_clips needs at least one id in `elementIds`.");
    }
    checkNumbers("rotate_clips", params as Record<string, unknown>, ["degrees"]);
    for (const id of ids) {
      requireElement(doc, id);
    }

    const degrees = params.degrees ?? 90;

    // Named before the commit: "nothing here can turn" and "that turned
    // nothing" are different answers, and only the document knows which.
    const declineReason = canRotateClips(doc, ids)
      ? "That turn leaves those clips where they already are."
      : "Nothing in that selection can be turned. Audio has no picture to rotate.";

    return commit(
      (d) => rotateClips(d, ids, degrees, playheadMs(), projectBakeHz()),
      declineReason,
    );
  },
});
