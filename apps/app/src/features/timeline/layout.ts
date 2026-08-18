/**
 * Where every row and every clip sits, as one pure function.
 *
 * Four places used to compute this independently, each with its own copy of
 * `index * 30 * 1.2`: the canvas's `drawCanvas` and `findTarget`, and the left
 * column's `drawCanvas` and `_handleMouseClickCanvas`. Drawing and hit-testing
 * disagreeing is the classic failure of that arrangement, and this codebase had
 * it — `findTarget` measured a clip's width with `duration` while `drawCanvas`
 * used `duration / speed`, so a sped-up clip's right-hand trim handle sat
 * outside the bar you could see.
 *
 * Now they all consume one `layoutTimeline` result, so they cannot drift.
 */

import { msToPxSigned, pxToMsSigned, spanOf } from "./geometry";
import { clipsOnTrack, type TimelineDocument, type TimelineTrack } from "./tracks";

/** Row height in px. Fixed globally so filmstrip tiles cache at one size. */
export const TRACK_HEIGHT = 40;
/** Vertical space between rows. */
export const TRACK_GAP = 4;
/** Distance between the tops of adjacent rows. */
export const TRACK_PITCH = TRACK_HEIGHT + TRACK_GAP;
/** Grab width of a trim handle, shrunk on narrow clips. */
export const TRIM_HANDLE_PX = 8;
/** Narrowest a clip is ever drawn, so a very short one stays visible. */
export const MIN_CLIP_PX = 4;
/**
 * Dead space at the top of the timeline.
 *
 * `element-timeline-ruler` is absolutely positioned and overlaps the first
 * ~28px of the canvas beneath it, so a row drawn at y=0 is half-hidden behind
 * the timecode. The old canvas started its loop at `index = 1` for exactly this
 * reason — an offset disguised as a counter. Naming it means the left column
 * can reserve the same space instead of guessing (it used a hardcoded 34px).
 */
export const RULER_OFFSET = 36;

export type LayoutInput = {
  doc: TimelineDocument;
  /** Zoom, as `timelineStore.range`. */
  range: number;
  /** Horizontal scroll in px. */
  hScroll: number;
  /** Vertical scroll in px. */
  vScroll: number;
  viewportW: number;
  viewportH: number;
  /** Space reserved above the first row; defaults to the ruler's. */
  topOffset?: number;
};

export type TrackRow = {
  trackId: string;
  index: number;
  top: number;
  height: number;
  track: TimelineTrack;
};

export type ClipRect = {
  elementId: string;
  trackId: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type TimelineLayout = {
  rows: TrackRow[];
  /** Only the clips that intersect the viewport. */
  clips: ClipRect[];
  /** Full height of all rows, ignoring scroll — for scrollbar extents. */
  totalHeight: number;
};

export type Hit =
  | { kind: "none" }
  | {
      kind: "clip";
      elementId: string;
      trackId: string;
      zone: "body" | "trimStart" | "trimEnd";
    }
  | { kind: "track"; trackId: string };

export function xAtTime(ms: number, range: number, hScroll: number): number {
  return msToPxSigned(ms, range) - hScroll;
}

export function timeAtX(x: number, range: number, hScroll: number): number {
  return pxToMsSigned(x + hScroll, range);
}

/** Top edge of row `index`, accounting for scroll and the reserved header. */
export function rowTop(
  index: number,
  vScroll: number,
  topOffset: number = RULER_OFFSET,
): number {
  return topOffset + index * TRACK_PITCH - vScroll;
}

export function layoutTimeline(input: LayoutInput): TimelineLayout {
  const { doc, range, hScroll, vScroll, viewportW, viewportH } = input;
  const topOffset = input.topOffset ?? RULER_OFFSET;

  const rows: TrackRow[] = [...doc.tracks]
    .sort((a, b) => a.index - b.index)
    .map((track) => ({
      trackId: track.id,
      index: track.index,
      top: rowTop(track.index, vScroll, topOffset),
      height: TRACK_HEIGHT,
      track,
    }));

  const clips: ClipRect[] = [];

  for (const row of rows) {
    // Rows scrolled fully out of view contribute nothing to draw or to hit.
    if (row.top + row.height < 0 || row.top > viewportH) {
      continue;
    }

    for (const [elementId, element] of clipsOnTrack(doc, row.trackId)) {
      const { start, length } = spanOf(element);
      const x = xAtTime(start, range, hScroll);
      const w = Math.max(MIN_CLIP_PX, msToPxSigned(length, range));

      if (x + w < 0 || x > viewportW) {
        continue;
      }

      clips.push({
        elementId,
        trackId: row.trackId,
        x,
        y: row.top,
        w,
        h: row.height,
      });
    }
  }

  return {
    rows,
    clips,
    totalHeight: topOffset + doc.tracks.length * TRACK_PITCH,
  };
}

/**
 * Handle width for a clip of width `w`.
 *
 * On a narrow clip two full-width handles would meet in the middle and leave no
 * way to grab the body — or worse, overlap and make the right handle
 * unreachable. A third of the width each caps that at two thirds.
 */
export function trimHandleWidth(w: number): number {
  return Math.min(TRIM_HANDLE_PX, w / 3);
}

export function trackAtY(layout: TimelineLayout, y: number): string | null {
  for (const row of layout.rows) {
    if (y >= row.top && y < row.top + row.height) {
      return row.trackId;
    }
  }
  return null;
}

/**
 * What is under the pointer.
 *
 * Clips are tested last-drawn-first so the one visually on top wins, matching
 * what the user sees. Within a clip the edges claim a handle each; the rest is
 * body.
 */
export function hitTest(
  layout: TimelineLayout,
  x: number,
  y: number,
): Hit {
  for (let i = layout.clips.length - 1; i >= 0; i--) {
    const clip = layout.clips[i];
    if (
      x < clip.x ||
      x >= clip.x + clip.w ||
      y < clip.y ||
      y >= clip.y + clip.h
    ) {
      continue;
    }

    const handle = trimHandleWidth(clip.w);
    const zone =
      x < clip.x + handle
        ? "trimStart"
        : x >= clip.x + clip.w - handle
          ? "trimEnd"
          : "body";

    return { kind: "clip", elementId: clip.elementId, trackId: clip.trackId, zone };
  }

  const trackId = trackAtY(layout, y);
  if (trackId != null) {
    return { kind: "track", trackId };
  }

  return { kind: "none" };
}
