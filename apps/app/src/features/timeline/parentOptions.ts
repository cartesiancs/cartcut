/**
 * What a parent picker may offer.
 *
 * The pick-whip's half of `groupOps.ts#setParent`: which groups a selection
 * could legally be attached to, which it could not, and why. DOM-free, so the
 * rules are testable against the op itself rather than through a component.
 *
 * ## The contract
 *
 * **Every enabled choice is one `setParent` accepts, and every disabled one is
 * one it declines.** That is asserted directly in `parentOptions.test.ts`,
 * across a table of documents, because the two are separate implementations of
 * the same rules and nothing else would stop them drifting. It is also the
 * rule `elementTimelineCanvas.groupMenuTemplate` already keeps for the context
 * menu: offering an item that can only decline is worse than not offering it.
 *
 * Disabled rather than absent, though. A list that changes length as the
 * selection changes moves under the pointer, and "greyed out because it would
 * make a loop" tells the user something that a missing row does not.
 */

import type { Timeline } from "../../@types/timeline";
import { canBeGrouped } from "./groupOps";
import {
  MAX_GROUP_DEPTH,
  depthOf,
  isGroupElement,
  parentOf,
  subtreeHeight,
  wouldCycle,
} from "./hierarchy";

/** Why a group cannot take this selection. */
export type ParentRefusal = "self" | "cycle" | "depth";

export type ParentChoice = {
  id: string;
  /** The group's `name`, or its id when that is blank. */
  name: string;
  /** How many groups sit above it — the indent level in a tree-shaped list. */
  depth: number;
  disabled: boolean;
  reason?: ParentRefusal;
};

/** The parent a whole selection shares. `"mixed"` when they disagree. */
export type SharedParent = string | null | "mixed";

/** The live ids among `elementIds`, deduplicated and order-preserving. */
function liveIds(elements: Timeline, elementIds: string[]): string[] {
  return [...new Set(elementIds)].filter((id) => elements[id] != null);
}

/**
 * Whether a parent picker is worth showing for this selection at all.
 *
 * Audio is refused for the reason `canBeGrouped` gives: it carries a `location`
 * only because `TimelinePlaced` hands it one, and nothing reads it. Offering to
 * parent a sound would promise that moving the group moves it, which is a
 * promise the renderer cannot keep.
 */
export function canPickParent(
  elements: Timeline,
  elementIds: string[],
): boolean {
  const ids = liveIds(elements, elementIds);
  return ids.length > 0 && ids.every((id) => canBeGrouped(elements[id]));
}

/**
 * The first reason `groupId` cannot take `ids`, or `null` if it can.
 *
 * The checks and their order mirror `setParent`'s, which is what the contract
 * test pins. `self` is reported ahead of `cycle` even though `wouldCycle`
 * covers both, because "you cannot parent something to itself" is a clearer
 * thing to read than "that would make a loop".
 */
function refusalFor(
  elements: Timeline,
  ids: string[],
  groupId: string,
): ParentRefusal | null {
  if (ids.includes(groupId)) {
    return "self";
  }

  const parentDepth = depthOf(elements, groupId) + 1;
  for (const id of ids) {
    if (wouldCycle(elements, id, groupId)) {
      return "cycle";
    }
    // The moved element's own depth is not enough: a group carrying a tall
    // subtree would otherwise slide under the cap on the strength of its root.
    if (parentDepth + subtreeHeight(elements, id) > MAX_GROUP_DEPTH) {
      return "depth";
    }
  }
  return null;
}

/**
 * Every group in the document, judged against this selection.
 *
 * Empty when the selection is empty, dead, or holds anything ungroupable — in
 * all three cases `setParent` would refuse whatever was picked, so there is
 * nothing to offer.
 *
 * Ordered shallowest first, then by name, then by id, so a nested arrangement
 * reads as a tree and the order never depends on object key order — the same
 * reason `childrenOf` sorts.
 */
export function parentChoicesFor(
  elements: Timeline,
  elementIds: string[],
): ParentChoice[] {
  const ids = liveIds(elements, elementIds);
  if (ids.length === 0 || !ids.every((id) => canBeGrouped(elements[id]))) {
    return [];
  }

  const choices: ParentChoice[] = [];
  for (const id of Object.keys(elements)) {
    if (!isGroupElement(elements[id])) {
      continue;
    }
    const reason = refusalFor(elements, ids, id);
    const name = (elements[id] as any).name;
    choices.push({
      id,
      name: typeof name === "string" && name !== "" ? name : id,
      depth: depthOf(elements, id),
      disabled: reason != null,
      ...(reason != null ? { reason } : {}),
    });
  }

  return choices.sort(
    (a, b) =>
      a.depth - b.depth ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * The parent every element in the selection currently shares.
 *
 * `"mixed"` when they disagree, so the picker can show a blank rather than
 * picking a side — closing a dropdown that had silently pre-selected one half
 * of a split selection would re-parent the other half.
 */
export function sharedParentOf(
  elements: Timeline,
  elementIds: string[],
): SharedParent {
  const ids = liveIds(elements, elementIds);
  if (ids.length === 0) {
    return null;
  }

  const first = parentOf(elements, ids[0]);
  return ids.every((id) => parentOf(elements, id) === first) ? first : "mixed";
}
