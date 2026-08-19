/**
 * Document-level editing: split, move, trim, delete, paste.
 *
 * `clipEdit` does the arithmetic on one element; this file is where the track
 * model's rules live — a track never holds overlapping clips, and every op
 * either produces a document that satisfies that or produces nothing at all.
 *
 * "Nothing at all" means the *same object reference* back. `withCheckpoint`
 * uses identity to decide whether an undo step happened, so a declined edit
 * costs the user nothing: a split with the playhead off the clip, a drag into
 * an occupied slot, an arrow key at the top row.
 */

import type { TimelineElement } from "../../@types/timeline";
import { splitAt, trimEnd, trimStart } from "./clipEdit";
import { spanLength, spanOf } from "./geometry";
import { findCollisions, overlaps } from "./overlap";
import { chooseTrackFor } from "./placement";
import { cloneAnimation } from "../animation/keyframes";
import {
  clipsOnTrack,
  normalizeDocument,
  trackIndexOf,
  type TimelineDocument,
} from "./tracks";

/** Rebuild with a new element map, re-deriving indices, names and priorities. */
function withElements(
  doc: TimelineDocument,
  elements: Record<string, TimelineElement>,
): TimelineDocument {
  return normalizeDocument({ ...doc, elements });
}

/**
 * Cut one clip at `atMs`.
 *
 * Both halves keep the original's `trackId` — the single most important line in
 * this file. The old split gave the right half a fresh `priority` of `max + 1`,
 * and because a row *was* the priority-sorted index, that put every cut on a
 * brand-new row.
 */
export function splitClip(
  doc: TimelineDocument,
  elementId: string,
  atMs: number,
  newId: string,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (element == null) {
    return doc;
  }

  const parts = splitAt(element, atMs);
  if (parts == null) {
    return doc;
  }

  return withElements(doc, {
    ...doc.elements,
    [elementId]: parts.left,
    [newId]: parts.right,
  });
}

/** Cut every clip in `elementIds` that the playhead actually crosses. */
export function splitAtPlayhead(
  doc: TimelineDocument,
  elementIds: string[],
  atMs: number,
  idGen: () => string,
): TimelineDocument {
  let next = doc;
  for (const elementId of elementIds) {
    next = splitClip(next, elementId, atMs, idGen());
  }
  return next;
}

/**
 * Move clips in time and/or across tracks.
 *
 * Atomic: if any clip in the selection cannot go where it is asked, nothing
 * moves. A partial move would silently break up a selection the user dragged as
 * one thing, which is worse than refusing.
 */
export function moveClips(
  doc: TimelineDocument,
  elementIds: string[],
  deltaMs: number,
  deltaTrackIndex = 0,
): TimelineDocument {
  if (elementIds.length === 0) {
    return doc;
  }

  const ordered = [...doc.tracks].sort((a, b) => a.index - b.index);
  const moving = new Set(elementIds);
  const next: Record<string, TimelineElement> = { ...doc.elements };
  const placed: Array<{ trackId: string; start: number; end: number }> = [];

  for (const elementId of elementIds) {
    const element = doc.elements[elementId];
    if (element == null) {
      return doc;
    }

    const fromIndex = trackIndexOf(doc, element.trackId);
    const toIndex = fromIndex + deltaTrackIndex;
    if (toIndex < 0 || toIndex >= ordered.length) {
      return doc;
    }

    const target = ordered[toIndex];
    // Kinds stay apart: a caption on an audio row would neither render nor
    // export, so the move is refused rather than quietly allowed.
    if (deltaTrackIndex !== 0 && target.kind !== ordered[fromIndex].kind) {
      return doc;
    }

    const start = element.startTime + deltaMs;
    if (start < 0) {
      return doc;
    }

    const span = { start, end: start + spanLength(element) };
    if (findCollisions(doc, target.id, span, [...moving]).length > 0) {
      return doc;
    }

    // Clips being moved together must not land on top of each other either.
    if (
      placed.some(
        (other) => other.trackId === target.id && overlaps(other, span),
      )
    ) {
      return doc;
    }
    placed.push({ trackId: target.id, ...span });

    next[elementId] = { ...element, startTime: start, trackId: target.id };
  }

  return withElements(doc, next);
}

/** Convenience for the single-clip case. */
export function moveClip(
  doc: TimelineDocument,
  elementId: string,
  deltaMs: number,
  deltaTrackIndex = 0,
): TimelineDocument {
  return moveClips(doc, [elementId], deltaMs, deltaTrackIndex);
}

/** The clip immediately before / after `elementId` on its own track. */
function neighboursOf(doc: TimelineDocument, elementId: string) {
  const element = doc.elements[elementId];
  const siblings = clipsOnTrack(doc, element.trackId).filter(
    ([id]) => id !== elementId,
  );
  const { start, end } = spanOf(element);

  let before: number | null = null;
  let after: number | null = null;

  for (const [, sibling] of siblings) {
    const span = spanOf(sibling);
    if (span.end <= start && (before == null || span.end > before)) {
      before = span.end;
    }
    if (span.start >= end && (after == null || span.start < after)) {
      after = span.start;
    }
  }

  return { before, after };
}

/**
 * Drag a clip's left edge, stopping at the clip before it.
 *
 * Clamping rather than refusing: an editor should let you pull an edge until it
 * butts against its neighbour, not freeze the moment the drag would overlap.
 */
export function trimClipStart(
  doc: TimelineDocument,
  elementId: string,
  deltaMs: number,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (element == null) {
    return doc;
  }

  const { before } = neighboursOf(doc, elementId);
  const limit = before ?? 0;
  // Negative delta extends leftwards; it may not reach past the neighbour.
  const clamped = Math.max(deltaMs, limit - element.startTime);

  const trimmed = trimStart(element, clamped);
  if (trimmed.startTime === element.startTime && trimmed.duration === element.duration) {
    return doc;
  }

  return withElements(doc, { ...doc.elements, [elementId]: trimmed });
}

/** Drag a clip's right edge, stopping at the clip after it. */
export function trimClipEnd(
  doc: TimelineDocument,
  elementId: string,
  deltaMs: number,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (element == null) {
    return doc;
  }

  const { after } = neighboursOf(doc, elementId);
  const room =
    after == null ? Infinity : after - spanOf(element).end;
  const clamped = Math.min(deltaMs, room);

  const trimmed = trimEnd(element, clamped);
  if (trimmed.duration === element.duration) {
    return doc;
  }

  return withElements(doc, { ...doc.elements, [elementId]: trimmed });
}

export function deleteClips(
  doc: TimelineDocument,
  elementIds: string[],
): TimelineDocument {
  const present = elementIds.filter((id) => doc.elements[id] != null);
  if (present.length === 0) {
    return doc;
  }

  const elements = { ...doc.elements };
  for (const id of present) {
    delete elements[id];
  }
  return withElements(doc, elements);
}

/**
 * Delete a clip and close the gap it leaves, pulling everything after it on the
 * same track backwards. Other tracks are untouched — this is a lane-local
 * ripple, not a magnetic timeline.
 */
export function rippleDelete(
  doc: TimelineDocument,
  elementId: string,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (element == null) {
    return doc;
  }

  const { end, length } = spanOf(element);
  const elements = { ...doc.elements };
  delete elements[elementId];

  for (const [id, sibling] of clipsOnTrack(doc, element.trackId)) {
    if (id === elementId) {
      continue;
    }
    if (spanOf(sibling).start >= end) {
      elements[id] = {
        ...sibling,
        startTime: Math.max(0, sibling.startTime - length),
      };
    }
  }

  return withElements(doc, elements);
}

/**
 * Paste clips so the earliest of them lands on `atMs`, preserving the shape of
 * the copied group.
 *
 * Each clip prefers the track it came from; if that track is gone or occupied,
 * it falls back to the same rule a newly added element follows.
 */
export function pasteClips(
  doc: TimelineDocument,
  clips: Record<string, TimelineElement>,
  atMs: number,
  idGen: () => string,
): TimelineDocument {
  const entries = Object.values(clips);
  if (entries.length === 0) {
    return doc;
  }

  const anchor = Math.min(...entries.map((clip) => clip.startTime));
  let next = doc;

  for (const clip of entries) {
    const start = Math.max(0, atMs + (clip.startTime - anchor));
    const span = { start, end: start + spanLength(clip) };
    const newId = idGen();

    const originalTrackExists = next.tracks.some(
      (track) => track.id === clip.trackId,
    );
    const fitsOriginal =
      originalTrackExists &&
      findCollisions(next, clip.trackId, span).length === 0;

    // `cloneAnimation`, because `{...clip}` shares the `animation` object with
    // the clipboard entry: pasting the same clip twice gave two elements one
    // animation, and editing a keyframe on either changed both. Cloning just
    // the animation rather than the whole clip keeps `blob`, `shape` and
    // `filter` shared, which is what makes a paste cheap.
    if (fitsOriginal) {
      next = withElements(next, {
        ...next.elements,
        [newId]: cloneAnimation({ ...clip, startTime: start }),
      });
      continue;
    }

    const chosen = chooseTrackFor(next, clip, start, idGen());
    next = withElements(chosen.doc, {
      ...chosen.doc.elements,
      [newId]: cloneAnimation({
        ...clip,
        startTime: start,
        trackId: chosen.trackId,
      }),
    });
  }

  return next;
}
