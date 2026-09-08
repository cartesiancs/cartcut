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
import { cutPointsOn } from "./transitionOps";
import { freezeMs } from "./transitionGeometry";
import { clipsOnTrack, type TimelineDocument, type TimelineTrack } from "./tracks";

/** Row height in px. Fixed globally so filmstrip tiles cache at one size. */
export const TRACK_HEIGHT = 40;
/** Vertical space between rows. */
export const TRACK_GAP = 4;
/** Distance between the tops of adjacent rows. */
export const TRACK_PITCH = TRACK_HEIGHT + TRACK_GAP;
/** Grab width of a trim handle, shrunk on narrow clips. */
export const TRIM_HANDLE_PX = 8;
/**
 * Narrowest a transition badge is drawn, so a short one stays grabbable.
 *
 * Wider than `MIN_CLIP_PX` because a badge has to be clicked to be edited at
 * all, whereas a sliver of a clip can still be selected from the part of it
 * that is visible.
 */
export const MIN_TRANSITION_PX = 14;
/** Grab width of a transition's length handles. */
export const TRANSITION_HANDLE_PX = 5;
/** How near a bare cut has to be clicked to offer a transition, in px. */
export const CUT_GRAB_PX = 6;
/**
 * Half-height of the cut affordance, and of its grab band.
 *
 * The affordance must **not** own the full row height, and the reason is
 * concrete: two abutting clips are what every split produces, so a cut sits
 * exactly where both clips' trim handles meet. A full-height grab zone there
 * would make it impossible to trim either side of any cut in the project —
 * losing a daily gesture to buy an occasional one.
 *
 * So it claims only a band across the vertical middle, and the trim handles
 * keep the rest. One constant drives both the drawn glyph and the hit band, so
 * the clickable area is exactly the thing the user can see — the invariant this
 * module exists to hold.
 */
export const CUT_AFFORDANCE_PX = 9;
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

/**
 * A transition badge, straddling the cut it belongs to.
 *
 * Laid out here rather than drawn ad hoc because it has to be *hit* — and a
 * badge that sits on a cut necessarily overlaps both neighbours' trim handles.
 * Only one source of geometry can decide who wins, and `hitTest` below is it.
 */
export type TransitionRect = {
  transitionId: string;
  trackId: string;
  fromId: string;
  toId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Source handles forced it shorter than asked for; drawn as a warning. */
  clamped: boolean;
  /**
   * Part of it holds a frozen frame, because the source ran out.
   *
   * Not an error — it is what every editor does, and refusing instead was the
   * bug that made a transition impossible between two freshly imported clips.
   * Marked so the user can see it and trim for real footage if they care.
   */
  frozen: boolean;
};

/**
 * A cut with no transition on it yet — the affordance for adding one.
 *
 * Zero width: it is a *point*, and `hitTest` gives it a grab margin rather than
 * the layout giving it a box. That keeps the drawn hint and the clickable area
 * from drifting apart the way `findTarget` and `drawCanvas` once did.
 */
export type CutRect = {
  trackId: string;
  fromId: string;
  toId: string;
  atMs: number;
  x: number;
  y: number;
  h: number;
};

export type TimelineLayout = {
  rows: TrackRow[];
  /** Only the clips that intersect the viewport. */
  clips: ClipRect[];
  /** Transition badges, for the same viewport. */
  transitions: TransitionRect[];
  /** Cuts with nothing on them yet. */
  cuts: CutRect[];
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
  | {
      kind: "transition";
      transitionId: string;
      trackId: string;
      zone: "body" | "resizeStart" | "resizeEnd";
    }
  | {
      kind: "cut";
      trackId: string;
      fromId: string;
      toId: string;
      atMs: number;
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
  const transitions: TransitionRect[] = [];
  const cuts: CutRect[] = [];

  for (const row of rows) {
    // Rows scrolled fully out of view contribute nothing to draw or to hit.
    if (row.top + row.height < 0 || row.top > viewportH) {
      continue;
    }

    for (const [elementId, element] of clipsOnTrack(doc, row.trackId)) {
      // A transition is on the track but is not a clip on it — it straddles the
      // cut rather than occupying a slot. Laid out separately below so that a
      // badge and the two clips it sits between stay distinguishable to both
      // the painter and the hit test.
      if (element.filetype === "transition") {
        const { start, length } = spanOf(element);
        const x = xAtTime(start, range, hScroll);
        const w = Math.max(MIN_TRANSITION_PX, msToPxSigned(length, range));
        if (x + w < 0 || x > viewportW) {
          continue;
        }
        transitions.push({
          transitionId: elementId,
          trackId: row.trackId,
          fromId: element.fromId,
          toId: element.toId,
          x,
          y: row.top,
          w,
          h: row.height,
          clamped:
            element.requestedDuration != null &&
            element.requestedDuration > element.duration,
          frozen: (() => {
            const from = doc.elements[element.fromId];
            const to = doc.elements[element.toId];
            if (from == null || to == null) {
              return false;
            }
            return (
              freezeMs(from, to, element.alignment, element.duration) > 0
            );
          })(),
        });
        continue;
      }

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

    for (const cut of cutPointsOn(doc, row.trackId)) {
      // Only bare cuts. One that already carries a transition has a badge, and
      // offering to add a second there would be an offer the ops decline.
      if (cut.transitionId != null) {
        continue;
      }
      const x = xAtTime(cut.atMs, range, hScroll);
      if (x < -CUT_GRAB_PX || x > viewportW + CUT_GRAB_PX) {
        continue;
      }
      cuts.push({
        trackId: row.trackId,
        fromId: cut.fromId,
        toId: cut.toId,
        atMs: cut.atMs,
        x,
        y: row.top,
        h: row.height,
      });
    }
  }

  return {
    rows,
    clips,
    transitions,
    cuts,
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
 * A box in screen px — the same space `ClipRect` is in.
 *
 * `ClipRect` structurally satisfies this, so a clip can be handed straight to
 * `clipsInRect` in a test without being unpacked.
 */
export type ScreenRect = { x: number; y: number; w: number; h: number };

/**
 * The band between two points, whichever corner the drag started from.
 *
 * Folding all four directions into one non-negative rect here is what lets
 * `clipsInRect` below be a plain overlap test: it never has to reason about a
 * negative extent, and it can be exhaustively tested without a gesture.
 */
export function rectBetween(
  a: { x: number; y: number },
  b: { x: number; y: number },
): ScreenRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/**
 * Every clip a rubber-band touches, in layout order.
 *
 * The area query to `hitTest`'s point query, and it lives here for the reason
 * this module exists: both read `layout.clips` and both have to agree about
 * where a clip ends. `hitTest` writes that as `x >= clip.x + clip.w`; the test
 * below is the same half-open rule on both axes, which is also
 * `overlap.ts#overlaps` in two dimensions. Split across two files, a click and
 * a one-pixel band on the same pixel could name different clips.
 *
 * Three consequences follow from the half-open rule, and each matches something
 * the codebase already states:
 *
 * - A band with no width or no height selects nothing — `overlaps`' own rule,
 *   that a zero-width interval contains no instant. The gesture never presents
 *   one (a band does not start until the pointer has travelled), so this is
 *   about the function being total rather than about the UI.
 * - A band whose right edge lands exactly on a clip's left edge misses it, and
 *   one that *starts* there hits it. That is the rule `hitTest` gives abutting
 *   clips: an edge belongs to exactly one side.
 * - Touching is enough, and so is being contained: the test asks only whether
 *   two boxes overlap, so a band drawn wholly inside a long clip selects it.
 *
 * Iterating `layout.clips` in its natural order — track index, then start time,
 * then id — makes the result independent of which way the band was dragged.
 * That is what lets `selectionStore.setIds` decline a mousemove that swept
 * nothing new, which is the whole reason a band can update the selection live.
 *
 * Taking a `TimelineLayout` rather than a `TimelineDocument` is deliberate:
 * `layout.clips` is viewport-culled and clamped to `MIN_CLIP_PX`, so the band
 * selects exactly what is *drawn*, down to a clip too short to draw at its true
 * width. Re-deriving from the document would reintroduce the drift this module
 * exists to prevent.
 */
export function clipsInRect(
  layout: TimelineLayout,
  rect: ScreenRect,
): string[] {
  // Stated separately rather than left to the comparison below, exactly as
  // `overlaps` does it: `x < clip.x + clip.w && clip.x < x + 0` is true for a
  // zero-width band sitting inside a clip, so the half-open rule has to be
  // asserted rather than derived.
  if (rect.w <= 0 || rect.h <= 0) {
    return [];
  }

  const found: string[] = [];
  for (const clip of layout.clips) {
    if (
      rect.x < clip.x + clip.w &&
      clip.x < rect.x + rect.w &&
      rect.y < clip.y + clip.h &&
      clip.y < rect.y + rect.h
    ) {
      found.push(clip.elementId);
    }
  }
  return found;
}

/**
 * What is under the pointer.
 *
 * Order matters, and it is the reverse of the drawing order for one reason: a
 * transition badge sits *on* a cut, so it necessarily overlaps the trim handles
 * of both clips it joins. Test clips first and the trim handle always wins,
 * which would make a badge impossible to click at any zoom. So transitions come
 * first, then bare cuts, then clips.
 *
 * The cost is that the last few pixels of a clip's trim handle are shadowed by
 * a badge. That is the right trade: the rest of the handle is still there, and
 * the alternative is an affordance the user can see and never reach.
 *
 * Within each, edges claim a handle and the rest is body — the same shape the
 * clips already had.
 */
export function hitTest(
  layout: TimelineLayout,
  x: number,
  y: number,
): Hit {
  for (let i = layout.transitions.length - 1; i >= 0; i--) {
    const badge = layout.transitions[i];
    if (
      x < badge.x ||
      x >= badge.x + badge.w ||
      y < badge.y ||
      y >= badge.y + badge.h
    ) {
      continue;
    }

    const handle = Math.min(TRANSITION_HANDLE_PX, badge.w / 3);
    const zone =
      x < badge.x + handle
        ? "resizeStart"
        : x >= badge.x + badge.w - handle
          ? "resizeEnd"
          : "body";

    return {
      kind: "transition",
      transitionId: badge.transitionId,
      trackId: badge.trackId,
      zone,
    };
  }

  for (const cut of layout.cuts) {
    // A band across the middle of the row, not the whole row: the trim handles
    // of both clips meet here, and every split makes one of these. See
    // `CUT_AFFORDANCE_PX`.
    if (
      Math.abs(x - cut.x) > CUT_GRAB_PX ||
      Math.abs(y - (cut.y + cut.h / 2)) > CUT_AFFORDANCE_PX
    ) {
      continue;
    }
    return {
      kind: "cut",
      trackId: cut.trackId,
      fromId: cut.fromId,
      toId: cut.toId,
      atMs: cut.atMs,
    };
  }

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
