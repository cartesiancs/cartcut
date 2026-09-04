/**
 * Groups — a shared *spatial* transform, After Effects' null object.
 *
 * `group_clips` reproduces `elementTimelineCanvas.groupSelected()`, including
 * its track choice: a group bar lives on its own kind of row so it never
 * competes with a real clip for a slot.
 *
 * `ungroup` is the one lossy operation in this whole surface. The UI puts a
 * `window.confirm` in front of it because there is no way to fold a
 * time-varying transform into a child's static fields — only the instant at the
 * playhead survives. An agent has no confirm dialog, so the equivalent is to
 * refuse and say why unless it passes `force`.
 */

import { v4 as uuidv4 } from "uuid";
import {
  canBeGrouped,
  createGroup,
  isGroupAnimated,
  setParent,
  ungroup,
} from "../../timeline/groupOps";
import { createNullElement } from "../../element/nullElement";
import { placeNewElement } from "../../timeline/placement";
import { appendTrackOfKind } from "../../timeline/tracks";
import { renderOptionStore } from "../../../states/renderOptionStore";
import { commit, declined } from "../commit";
import { currentDoc, playheadMs, requireElement } from "../context";
import { registerCommands } from "../registry";

registerCommands({
  /**
   * An empty null object, for attaching clips to afterwards.
   *
   * The counterpart to `group_clips`, which needs a selection to wrap. Both
   * produce the same `filetype: "group"` element; this one has no children and
   * so no bounding box to seat its pivot on, and takes a point instead —
   * defaulting to the centre of the project frame, derived from the project's
   * own resolution rather than assuming 1080p.
   */
  create_null: (params: {
    name?: string;
    color?: string;
    size?: number;
    x?: number;
    y?: number;
  }) => {
    const { previewSize, duration } = renderOptionStore.getState().options;
    const nullId = uuidv4();

    const element = createNullElement({
      name: params.name,
      color: params.color,
      size: params.size,
      center: {
        x: params.x ?? Number(previewSize.w) / 2,
        y: params.y ?? Number(previewSize.h) / 2,
      },
      // `renderOption.duration` is in seconds.
      duration: duration * 1000,
    });

    // Seated at 0, not the playhead: `localSampleAt` falls back to the static
    // value before an element's `startTime`, so a null starting later would
    // have its own keyframes quietly ignored to the left of it.
    const result = commit(
      (d) => placeNewElement(d, nullId, element, 0, uuidv4()),
      "The null object could not be added.",
    );

    return result.ok ? { ...result, nullId } : result;
  },

  group_clips: (params: { elementIds: string[]; name?: string; color?: string }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length < 2) {
      throw new Error("group_clips needs at least two ids in `elementIds`.");
    }

    const notGroupable = ids
      .map((id) => requireElement(doc, id))
      .filter((element) => !canBeGrouped(element));

    if (notGroupable.length > 0) {
      throw new Error(
        `Audio clips cannot be grouped — a group is a transform on the canvas, and audio has no picture. ` +
          `Remove the ${notGroupable.length} audio clip${notGroupable.length === 1 ? "" : "s"} from the selection.`,
      );
    }

    const groupId = uuidv4();
    const newTrackId = uuidv4();

    const result = commit((d) => {
      // Reuse a group row if there is one; `chooseTrackFor` is not used because
      // it keys off an element's filetype and would need the group built first.
      const withTrack = d.tracks.some((track) => track.kind === "group")
        ? d
        : appendTrackOfKind(d, "group", newTrackId);

      const target =
        withTrack.tracks.find((track) => track.kind === "group")?.id ?? newTrackId;

      return createGroup(withTrack, ids, groupId, target, {
        name: params.name,
        color: params.color,
      });
    }, "Those clips could not be grouped. They must all share the same current parent, and nesting cannot go more than 8 deep.");

    return result.ok ? { ...result, groupId } : result;
  },

  ungroup: (params: { groupIds: string[]; atMs?: number; force?: boolean }) => {
    const doc = currentDoc();
    const ids = params.groupIds ?? [];
    if (ids.length === 0) {
      throw new Error("ungroup needs at least one id in `groupIds`.");
    }

    const notGroups = ids
      .map((id) => ({ id, element: requireElement(doc, id) }))
      .filter(({ element }) => element.filetype !== "group");

    if (notGroups.length > 0) {
      throw new Error(
        `${notGroups.map(({ id }) => `"${id}"`).join(", ")} ${notGroups.length === 1 ? "is" : "are"} not a group. ` +
          `Use set_clip_parent with parentId:null to take a clip out of one.`,
      );
    }

    const atMs = Math.max(0, Math.round(params.atMs ?? playheadMs()));

    // Checked before the commit so a refusal costs no history entry at all.
    const animated = ids.filter((id) => isGroupAnimated(doc.elements, id));
    if (animated.length > 0 && params.force !== true) {
      return {
        ...declined(
          `${animated.length === 1 ? "That group is" : `${animated.length} of those groups are`} animated. ` +
            `Ungrouping keeps only the transform at ${atMs}ms and discards the keyframes — there is no way to ` +
            `fold a moving transform into a child's static fields. Pass force:true to proceed.`,
        ),
        lossy: animated,
      };
    }

    return commit(
      (d) => ids.reduce((next, id) => ungroup(next, id, atMs), d),
      "Those groups are already gone.",
    );
  },

  set_clip_parent: (params: {
    elementIds: string[];
    parentId: string | null;
    atMs?: number;
  }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_clip_parent needs at least one id in `elementIds`.");
    }
    for (const id of ids) {
      requireElement(doc, id);
    }

    if (params.parentId != null) {
      const parent = requireElement(doc, params.parentId);
      if (parent.filetype !== "group") {
        throw new Error(
          `"${params.parentId}" is a ${parent.filetype} clip, not a group. Only a group can be a parent — ` +
            `use group_clips to make one.`,
        );
      }
    }

    const atMs = Math.max(0, Math.round(params.atMs ?? playheadMs()));

    return commit(
      (d) => setParent(d, ids, params.parentId ?? null, atMs),
      params.parentId == null
        ? "Those clips are not in a group."
        : "Those clips could not be re-parented. They are already there, or the link would make a cycle or nest more than 8 deep.",
    );
  },
});
