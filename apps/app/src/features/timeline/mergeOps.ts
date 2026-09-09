/**
 * Rejoin clips that a split took apart.
 *
 * `clipEdit.ts#splitAt` already promises this is possible: "Adjacency is exact
 * — `left` ends precisely where `right` begins — which is what lets the two
 * pieces sit side by side on one track and be rejoined without drift." This is
 * the other half of that sentence.
 *
 * Merge is deliberately narrow. It is the inverse of a cut, not a general
 * "combine these clips" — two unrelated videos butted against each other have
 * no single source window that could describe the result, and a merge that
 * quietly threw one of them away would be worse than no merge at all. So every
 * condition below is really the same question asked from a different angle:
 * *were these one clip a moment ago?* When the answer is no, the document comes
 * back by identity and `withCheckpoint` records nothing.
 */

import type { TimelineElement } from "../../@types/timeline";
import {
  ADJACENCY_EPSILON_MS,
  isDurationLocked,
  isDynamicElement,
  spanEnd,
  spanStart,
  speedOf,
} from "./geometry";
import { normalizeDocument, type TimelineDocument } from "./tracks";

/**
 * How far apart two edges may be and still count as touching, in ms.
 *
 * Now `geometry.ts#ADJACENCY_EPSILON_MS`, which carries the reasoning. It moved
 * because transitions ask the same question of the same two numbers — "is there
 * a cut here?" — and the two answers must agree, or a cut that offers a
 * transition could refuse to merge. Re-exported under the old name so this
 * module's own documentation keeps referring to something real.
 */
export const MERGE_EPSILON_MS = ADJACENCY_EPSILON_MS;

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= MERGE_EPSILON_MS;
}

/** Whether any animation track on this element holds keyframes. */
function isAnimated(element: TimelineElement): boolean {
  const animation = (element as any).animation;
  if (animation == null) {
    return false;
  }
  return Object.keys(animation).some(
    (property) =>
      animation[property]?.isActivate === true &&
      (animation[property]?.x?.length ?? 0) > 0,
  );
}

/**
 * Whether `right` is the piece that used to follow `left`.
 *
 * The source-window test is the one that does the real work. Two clips can be
 * flush on the timeline and still be showing frames from opposite ends of the
 * file — that is what happens the moment anyone trims a cut — and joining those
 * would silently splice out everything in between.
 */
function canJoin(left: TimelineElement, right: TimelineElement): boolean {
  if (left.trackId !== right.trackId) {
    return false;
  }

  // Merging across a group boundary would carry a clip out of the coordinate
  // space its position is expressed in, moving it on screen.
  const leftParent = (left as any).parentId ?? null;
  const rightParent = (right as any).parentId ?? null;
  if (leftParent !== rightParent) {
    return false;
  }

  if (left.filetype !== right.filetype) {
    return false;
  }

  // A template is never half of a cut. The `localpath` test below is what
  // decides two clips share a source, and every template carries the same
  // `"TEMPLATE"` sentinel — so two *different* templates sitting edge to edge
  // passed every test here, and merging them dropped one while the survivor
  // claimed its span and went on rendering only its own six seconds. The
  // length guard is the honest statement of why: merging changes a duration,
  // and a template's belongs to its author.
  if (isDurationLocked(left) || isDurationLocked(right)) {
    return false;
  }

  if (left.localpath !== right.localpath) {
    return false;
  }

  // Two text clips sharing the empty `localpath` every text element has are not
  // halves of one cut unless they also say the same thing.
  if (left.filetype === "text" && (left as any).text !== (right as any).text) {
    return false;
  }

  if (isAnimated(left) || isAnimated(right)) {
    return false;
  }

  if (!near(spanEnd(left), spanStart(right))) {
    return false;
  }

  if (isDynamicElement(left) && isDynamicElement(right)) {
    if (speedOf(left) !== speedOf(right)) {
      return false;
    }
    if (!near(left.trim.endTime, right.trim.startTime)) {
      return false;
    }
  }

  return true;
}

/**
 * The selection in timeline order, or `null` if any id is unknown.
 *
 * Carries the map id alongside each element rather than reading `element.key`,
 * which is *not* the id it is filed under: `splitClip` files the right half
 * under a fresh uuid while the element's own `key` stays whatever the original
 * had. Deleting by `key` would miss the clip and take an unrelated one.
 */
type Link = { id: string; element: TimelineElement };

function ordered(doc: TimelineDocument, elementIds: string[]): Link[] | null {
  const unique = [...new Set(elementIds)];
  if (unique.length < 2) {
    return null;
  }

  const links: Link[] = [];
  for (const id of unique) {
    const element = doc.elements[id];
    if (element == null) {
      return null;
    }
    links.push({ id, element });
  }

  return links.sort((a, b) => spanStart(a.element) - spanStart(b.element));
}

/**
 * Whether `mergeClips` would do anything.
 *
 * Exported so the toolbar can grey the button out without restating the rules —
 * there is one definition of "these can be joined" and both callers read it.
 */
export function canMergeClips(
  doc: TimelineDocument,
  elementIds: string[],
): boolean {
  const chain = ordered(doc, elementIds);
  if (chain == null) {
    return false;
  }

  for (let i = 0; i < chain.length - 1; i += 1) {
    if (!canJoin(chain[i].element, chain[i + 1].element)) {
      return false;
    }
  }

  return true;
}

/**
 * Fuse a run of adjacent clips back into one.
 *
 * All-or-nothing, like `moveClips`: one bad link and the whole chain declines.
 * A partial merge would leave the user staring at a selection that half
 * collapsed, with no way to tell which half.
 *
 * The survivor is the **leftmost** clip, keeping its id. That matters beyond
 * tidiness — the selection, the keyframe editor's `target.elementId` and the
 * agent's last `list_clips` all name ids, and minting a fresh one for the
 * result would invalidate every reference to a clip the user still sees.
 */
export function mergeClips(
  doc: TimelineDocument,
  elementIds: string[],
): TimelineDocument {
  if (!canMergeClips(doc, elementIds)) {
    return doc;
  }

  // `ordered` cannot be null here: `canMergeClips` just returned true.
  const chain = ordered(doc, elementIds) as Link[];
  const head = chain[0].element;
  const tail = chain[chain.length - 1].element;

  let merged: TimelineElement;
  if (isDynamicElement(head) && isDynamicElement(tail)) {
    const trim = { startTime: head.trim.startTime, endTime: tail.trim.endTime };
    // Restated rather than summed, so the invariant
    // `duration === trim.endTime - trim.startTime` holds by construction and
    // cannot drift across a long chain.
    merged = {
      ...head,
      trim,
      duration: trim.endTime - trim.startTime,
    } as TimelineElement;
  } else {
    merged = {
      ...head,
      duration: chain.reduce(
        (total, link) => total + link.element.duration,
        0,
      ),
    } as TimelineElement;
  }

  const elements = { ...doc.elements, [chain[0].id]: merged };
  for (const link of chain.slice(1)) {
    delete elements[link.id];
  }

  return normalizeDocument({ ...doc, elements });
}
