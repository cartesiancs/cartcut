/**
 * The parent graph.
 *
 * An element's `parentId` names the `group` element whose coordinate space its
 * `location` and `position` keyframes are expressed in. This module answers
 * every structural question about that relation — who is above me, who is below
 * me, would this link close a cycle — and repairs a document whose links have
 * gone bad.
 *
 * It knows nothing about matrices; `transform.ts` is the other half. Keeping the
 * graph separate from the arithmetic is what lets `repairHierarchy` run inside
 * `normalizeDocument`, on every edit, without dragging keyframe sampling in
 * with it.
 *
 * Two rules make the graph cheap and total:
 *
 *   - **Only a `group` may be a parent.** A link to a missing element, or to a
 *     clip that is not a group, is not an error state to handle downstream — it
 *     simply is not a link. `parentOf` returns `null` for it, so every consumer
 *     treats it as a root without a guard of its own.
 *   - **Depth is capped.** `MAX_GROUP_DEPTH` bounds the walk, so a document that
 *     never went through `repairHierarchy` — a hand-edited `.ngt`, a bug in a
 *     future op — cannot hang the render loop.
 */

import type { Timeline, TimelineElement } from "../../@types/timeline";
// Type-only, and deliberately so: `tracks.ts` calls `repairHierarchy` from
// `normalizeDocument`, so a value import in this direction would close a
// runtime cycle between the two modules.
import type { TimelineDocument } from "./tracks";

/**
 * How deeply groups may nest.
 *
 * Eight is far past what anyone builds by hand and shallow enough that the
 * per-frame chain walk stays trivial. It is a backstop against pathological
 * data, not a design constraint users are meant to feel.
 */
export const MAX_GROUP_DEPTH = 8;

/** Whether an element can hold children. */
export function isGroupElement(
  element: TimelineElement | null | undefined,
): boolean {
  return element?.filetype === "group";
}

/**
 * The element's parent id, or `null` if it has none that counts.
 *
 * "Counts" is doing real work: a `parentId` naming an element that was deleted,
 * or naming a clip that is not a group, or naming the element itself, is
 * reported as no parent at all. Callers therefore never see a broken link, and
 * a document that has not been repaired still renders — every orphan simply
 * falls back to canvas space.
 */
export function parentOf(
  elements: Timeline,
  elementId: string,
): string | null {
  const parentId = (elements[elementId] as any)?.parentId;
  if (typeof parentId !== "string" || parentId === "" || parentId === elementId) {
    return null;
  }
  return isGroupElement(elements[parentId]) ? parentId : null;
}

/**
 * Every ancestor of `elementId`, root first.
 *
 * Root first because that is the order the matrices multiply in, and because a
 * caller wanting the immediate parent can take the last entry.
 */
export function ancestorsOf(elements: Timeline, elementId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([elementId]);

  let id = parentOf(elements, elementId);
  while (id != null && out.length < MAX_GROUP_DEPTH) {
    if (seen.has(id)) {
      break;
    }
    seen.add(id);
    out.push(id);
    id = parentOf(elements, id);
  }

  out.reverse();
  return out;
}

/** How many groups sit above `elementId`. A root element is depth 0. */
export function depthOf(elements: Timeline, elementId: string): number {
  return ancestorsOf(elements, elementId).length;
}

/**
 * The direct children of `groupId`, ordered by id.
 *
 * Sorted so the result never depends on object key order — the same reason
 * `clipsOnTrack` breaks its ties on id.
 */
export function childrenOf(elements: Timeline, groupId: string): string[] {
  const out: string[] = [];
  for (const id of Object.keys(elements)) {
    if (parentOf(elements, id) === groupId) {
      out.push(id);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Everything under `groupId`, at any depth, in breadth-first order.
 *
 * The visited set is not defensiveness about cycles — `parentOf` cannot produce
 * one that survives `repairHierarchy` — but about not visiting a node twice on
 * an unrepaired document and returning duplicate ids to a caller about to
 * delete them.
 */
export function descendantsOf(elements: Timeline, groupId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([groupId]);
  let frontier = childrenOf(elements, groupId);
  let depth = 0;

  while (frontier.length > 0 && depth <= MAX_GROUP_DEPTH) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      out.push(id);
      next.push(...childrenOf(elements, id));
    }
    frontier = next;
    depth++;
  }

  return out;
}

/**
 * Whether parenting `childId` to `parentId` would close a loop.
 *
 * True when they are the same element, or when `parentId` is already somewhere
 * beneath `childId` — the pick-whip equivalent of dragging a folder into itself.
 */
export function wouldCycle(
  elements: Timeline,
  childId: string,
  parentId: string,
): boolean {
  if (childId === parentId) {
    return true;
  }
  // Walk up from the proposed parent: if we meet the child, the link closes.
  let id: string | null = parentId;
  let depth = 0;
  const seen = new Set<string>();
  while (id != null && depth <= MAX_GROUP_DEPTH) {
    if (id === childId) {
      return true;
    }
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    id = parentOf(elements, id);
    depth++;
  }
  return false;
}

/**
 * The depth the subtree under `elementId` reaches, counted from `elementId`.
 *
 * A leaf is 0. Used to refuse a re-parent that would push some descendant past
 * `MAX_GROUP_DEPTH` — checking only the moved element's own depth would let a
 * deep subtree slide under the cap by its root.
 */
export function subtreeHeight(elements: Timeline, elementId: string): number {
  // The budget bounds the *descent*, and the visited set stops a cycle from
  // being walked twice. Capping the returned height alone was not enough: on a
  // cyclic document the recursion blew the stack before any check on the way
  // back up ever ran.
  const seen = new Set<string>();

  const walk = (id: string, budget: number): number => {
    if (budget <= 0 || seen.has(id)) {
      return 0;
    }
    seen.add(id);

    let height = 0;
    for (const child of childrenOf(elements, id)) {
      height = Math.max(height, 1 + walk(child, budget - 1));
    }
    return height;
  };

  return Math.min(walk(elementId, MAX_GROUP_DEPTH), MAX_GROUP_DEPTH);
}

/**
 * Drop every `parentId` that is not a live, acyclic, in-depth link to a group.
 *
 * Called from `normalizeDocument`, so it runs on every edit and every
 * checkpoint. That is affordable only because of the first line: a document
 * with no `parentId` anywhere — which is every project until someone makes a
 * group, and most of them after — is recognised in one pass over the keys and
 * returned by identity. CLAUDE.md's warning against walking keyframe arrays in
 * `normalizeDocument` is the same warning, and this is how it is respected.
 *
 * Returns its input by identity when nothing needed repairing, so
 * `withCheckpoint` still sees a declined op as declined.
 */
export function repairHierarchy(doc: TimelineDocument): TimelineDocument {
  const elements = doc.elements;

  let anyParent = false;
  for (const id of Object.keys(elements)) {
    if ((elements[id] as any)?.parentId != null) {
      anyParent = true;
      break;
    }
  }
  if (!anyParent) {
    return doc;
  }

  const next: Timeline = {};
  let changed = false;

  for (const [id, element] of Object.entries(elements)) {
    const declared = (element as any).parentId;
    if (declared == null) {
      next[id] = element;
      continue;
    }

    const resolved = parentOf(elements, id);
    const valid =
      resolved != null &&
      resolved === declared &&
      !wouldCycle(elements, id, declared) &&
      depthOf(elements, id) <= MAX_GROUP_DEPTH;

    if (valid) {
      next[id] = element;
      continue;
    }

    const { parentId: _dropped, ...rest } = element as any;
    next[id] = rest as TimelineElement;
    changed = true;
  }

  return changed ? { ...doc, elements: next } : doc;
}

/**
 * `elementIds` plus everything beneath any group among them, deduplicated.
 *
 * What "delete a group" means: the contents go with it. `ungroup` is the way to
 * keep them, and it is a separate gesture precisely so that neither outcome is
 * a surprise.
 */
export function withDescendants(
  elements: Timeline,
  elementIds: string[],
): string[] {
  const out = new Set<string>();
  for (const id of elementIds) {
    if (elements[id] == null) {
      continue;
    }
    out.add(id);
    if (isGroupElement(elements[id])) {
      for (const child of descendantsOf(elements, id)) {
        out.add(child);
      }
    }
  }
  return [...out];
}
