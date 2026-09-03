/**
 * Auto-zoom: a cursor track in, a set of zoom moves out.
 *
 * This is the reason the recorder composites *after* the take rather than
 * during it. A zoom that begins when the cursor arrives is already late — the
 * viewer sees the move, then the zoom chases it. A zoom that begins half a
 * second *before* the cursor settles reads as though the camera knew, and there
 * is no way to know during a live capture. Loom and Screen Studio both record
 * raw and compose afterwards for exactly this; `LOOKAHEAD_MS` is where that
 * decision is spent.
 *
 * The shape of the answer is a small list of non-overlapping `ZoomSegment`s,
 * each with four instants — ease in, hold, ease out — rather than a value per
 * frame. Two reasons: a segment list is a few dozen numbers where a per-frame
 * track is tens of thousands (the same argument `serialize.ts` makes about not
 * returning `animation.ax`), and a segment is something a person can read in a
 * debug dump and say "that zoom is wrong" about.
 *
 * Pure, DOM-free, no store. Coordinates are **frame pixels of the screen
 * capture**, not display points and not timeline units — the composite pass is
 * the only consumer and that is the space it draws in.
 */

import type { Size } from "./captureSettings";
import type { ZoomStrength } from "./recordSettings";

export type CursorSample = {
  /** Milliseconds from the start of the recording. */
  t: number;
  /** Frame pixels. */
  x: number;
  y: number;
};

/**
 * One zoom move.
 *
 * `inStart <= inEnd <= outStart <= outEnd`, and segments never overlap, so
 * `sampleZoom` can answer with a single scan and no blending between moves.
 */
export type ZoomSegment = {
  /** Zoom begins moving away from 1×. */
  inStart: number;
  /** Full `scale` reached. */
  inEnd: number;
  /** Zoom begins returning to 1×. */
  outStart: number;
  /** Back at 1×. */
  outEnd: number;
  scale: number;
  /** Where the frame is centred at full zoom, in frame pixels. */
  cx: number;
  cy: number;
};

export type ZoomView = { scale: number; cx: number; cy: number };

/** How far in the picture a zoom pushes, by strength. */
const STRENGTH_SCALES: Record<ZoomStrength, number> = {
  off: 1,
  subtle: 1.4,
  strong: 1.9,
};

/**
 * How still the cursor has to be to count as settled, as a fraction of the
 * frame's shorter side.
 *
 * Deliberately generous. Somebody reading a paragraph moves the pointer in
 * small aimless arcs; somebody who has stopped to work on one control does not
 * hold it to the pixel. Too tight and a dwell never forms; too loose and the
 * whole take is one dwell.
 */
const DWELL_RADIUS_FRACTION = 0.06;

/** How long the cursor must stay settled before a zoom is earned. */
const MIN_DWELL_MS = 900;

/** How far ahead of the dwell the zoom starts. The whole point of the module. */
const LOOKAHEAD_MS = 500;

const EASE_IN_MS = 650;
const EASE_OUT_MS = 550;

/**
 * The shortest a zoom may hold at full scale.
 *
 * A move that zooms in and immediately back out is worse than no move: it reads
 * as a glitch rather than as emphasis. Anything that cannot hold this long is
 * dropped.
 */
const MIN_HOLD_MS = 1200;

/** Two dwells closer than this in time are candidates for merging. */
const MERGE_GAP_MS = 1500;

/**
 * ...and close enough in space, as a fraction of the frame's shorter side.
 *
 * Merging on time alone would slide the frame between two distant points during
 * the hold, which is a pan nobody asked for.
 */
const MERGE_RADIUS_FRACTION = 0.12;

/** Smoothstep. Zero velocity at both ends, which is what stops a zoom snapping. */
export function smoothstep(t: number): number {
  const p = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return p * p * (3 - 2 * p);
}

export function zoomScaleFor(strength: ZoomStrength): number {
  return STRENGTH_SCALES[strength] ?? 1;
}

/**
 * Keep the zoomed viewport inside the frame.
 *
 * At scale `s` the visible box is `frame / s`, so its centre may only travel
 * within `[halfWidth, frameWidth - halfWidth]`. Without this a zoom onto
 * something in the corner shows the void beyond the screen edge — and since the
 * composite pass draws from a decoded frame, "the void" is whatever the canvas
 * was last cleared to.
 */
export function clampCenter(
  cx: number,
  cy: number,
  scale: number,
  frame: Size,
): { cx: number; cy: number } {
  const s = Number.isFinite(scale) && scale > 1 ? scale : 1;
  const halfWidth = frame.width / (2 * s);
  const halfHeight = frame.height / (2 * s);

  return {
    cx: Math.min(frame.width - halfWidth, Math.max(halfWidth, cx)),
    cy: Math.min(frame.height - halfHeight, Math.max(halfHeight, cy)),
  };
}

/**
 * The source rectangle to draw from, for a given view.
 *
 * This is what the composite pass hands `drawImage` — or, better, what it hands
 * `new VideoFrame(frame, { visibleRect })`, which crops without copying. Either
 * way the picture drawn is real captured pixels: a 2× zoom on a native-
 * resolution Retina capture still has more than 1080p of them, which is the
 * whole reason capture size is pinned to the display's own.
 */
export function visibleRectFor(
  view: ZoomView,
  frame: Size,
): { x: number; y: number; width: number; height: number } {
  const scale = Number.isFinite(view.scale) && view.scale > 1 ? view.scale : 1;
  const width = frame.width / scale;
  const height = frame.height / scale;
  const { cx, cy } = clampCenter(view.cx, view.cy, scale, frame);

  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

type Dwell = { start: number; end: number; cx: number; cy: number };

/** Usable samples, in order. Anything unreadable is dropped, never thrown on. */
function cleanSamples(samples: readonly CursorSample[]): CursorSample[] {
  return samples
    .filter(
      (sample) =>
        sample != null &&
        Number.isFinite(sample.t) &&
        Number.isFinite(sample.x) &&
        Number.isFinite(sample.y),
    )
    .slice()
    .sort((a, b) => a.t - b.t);
}

/**
 * Find the stretches where the cursor stopped moving.
 *
 * Greedy and single-pass: extend the current run while every sample in it stays
 * within `radius` of the run's own centroid, and close the run when one does
 * not. Centroid rather than "within radius of the first sample", which would
 * let a slow drift walk the run across the screen a pixel at a time and call
 * the whole journey a dwell.
 */
export function findDwells(
  samples: readonly CursorSample[],
  frame: Size,
): Dwell[] {
  const ordered = cleanSamples(samples);
  if (ordered.length === 0) {
    return [];
  }

  const radius = Math.min(frame.width, frame.height) * DWELL_RADIUS_FRACTION;
  const dwells: Dwell[] = [];

  let start = 0;
  let sumX = 0;
  let sumY = 0;
  let count = 0;

  const close = (endIndex: number) => {
    if (count === 0) {
      return;
    }
    const first = ordered[start];
    const last = ordered[endIndex];
    if (last.t - first.t >= MIN_DWELL_MS) {
      dwells.push({
        start: first.t,
        end: last.t,
        cx: sumX / count,
        cy: sumY / count,
      });
    }
  };

  for (let index = 0; index < ordered.length; index += 1) {
    const sample = ordered[index];

    if (count > 0) {
      const cx = sumX / count;
      const cy = sumY / count;
      const dx = sample.x - cx;
      const dy = sample.y - cy;

      if (Math.hypot(dx, dy) > radius) {
        close(index - 1);
        start = index;
        sumX = 0;
        sumY = 0;
        count = 0;
      }
    }

    sumX += sample.x;
    sumY += sample.y;
    count += 1;
  }

  close(ordered.length - 1);

  return dwells;
}

/**
 * Turn dwells into moves, then make the moves legal.
 *
 * "Legal" is three rules, applied in this order because each can create work
 * for the next:
 *
 *  1. Every move holds for at least `MIN_HOLD_MS`, or it is dropped.
 *  2. Two moves at the same place close together become one, rather than
 *     zooming out and straight back in.
 *  3. Two moves at different places may not overlap in time — the later one
 *     gives way, and is dropped if that leaves it too short.
 *
 * The result is sorted and non-overlapping, which is what `sampleZoom` assumes.
 */
export function planZoom(
  samples: readonly CursorSample[],
  frame: Size,
  strength: ZoomStrength,
  durationMs: number,
): ZoomSegment[] {
  const scale = zoomScaleFor(strength);
  if (scale <= 1 || !Number.isFinite(durationMs) || durationMs <= 0) {
    return [];
  }
  if (frame.width <= 0 || frame.height <= 0) {
    return [];
  }

  const mergeRadius =
    Math.min(frame.width, frame.height) * MERGE_RADIUS_FRACTION;

  const built: ZoomSegment[] = [];

  for (const dwell of findDwells(samples, frame)) {
    const inStart = Math.max(0, dwell.start - LOOKAHEAD_MS);
    const inEnd = inStart + EASE_IN_MS;
    const outStart = Math.max(inEnd, dwell.end);
    const outEnd = Math.min(durationMs, outStart + EASE_OUT_MS);

    if (outStart - inEnd < MIN_HOLD_MS || outEnd <= outStart) {
      continue;
    }

    const centered = clampCenter(dwell.cx, dwell.cy, scale, frame);
    built.push({
      inStart,
      inEnd,
      outStart,
      outEnd,
      scale,
      cx: centered.cx,
      cy: centered.cy,
    });
  }

  const merged: ZoomSegment[] = [];

  for (const segment of built) {
    const previous = merged[merged.length - 1];

    if (previous == null) {
      merged.push(segment);
      continue;
    }

    const gap = segment.inStart - previous.outEnd;
    const near =
      Math.hypot(segment.cx - previous.cx, segment.cy - previous.cy) <=
      mergeRadius;

    if (gap <= MERGE_GAP_MS && near) {
      // Same place, near enough in time: one held move rather than two. The
      // centre is weighted by how long each half holds, so the longer look
      // decides where the frame sits.
      const previousHold = previous.outStart - previous.inEnd;
      const segmentHold = segment.outStart - segment.inEnd;
      const total = previousHold + segmentHold || 1;
      const centered = clampCenter(
        (previous.cx * previousHold + segment.cx * segmentHold) / total,
        (previous.cy * previousHold + segment.cy * segmentHold) / total,
        scale,
        frame,
      );

      merged[merged.length - 1] = {
        ...previous,
        outStart: Math.max(previous.outStart, segment.outStart),
        outEnd: Math.max(previous.outEnd, segment.outEnd),
        cx: centered.cx,
        cy: centered.cy,
      };
      continue;
    }

    if (segment.inStart < previous.outEnd) {
      // Different place, overlapping windows: the earlier move keeps its
      // ease-out and the later one starts after it. Sliding directly from one
      // centre to the other would be a pan across the screen at full zoom,
      // which is the most nauseating thing this module could produce.
      const inStart = previous.outEnd;
      const inEnd = inStart + EASE_IN_MS;
      if (segment.outStart - inEnd < MIN_HOLD_MS) {
        continue;
      }
      merged.push({ ...segment, inStart, inEnd });
      continue;
    }

    merged.push(segment);
  }

  return merged;
}

/**
 * The view at one instant.
 *
 * Scale and centre move together on the same eased parameter, so a zoom is one
 * gesture rather than a pan and a push that happen to overlap. Outside every
 * segment the answer is the identity view — full frame, centred — which is what
 * makes an empty plan and a disabled auto-zoom the same code path.
 */
export function sampleZoom(
  segments: readonly ZoomSegment[],
  tMs: number,
  frame: Size,
): ZoomView {
  const identity: ZoomView = {
    scale: 1,
    cx: frame.width / 2,
    cy: frame.height / 2,
  };

  if (!Number.isFinite(tMs)) {
    return identity;
  }

  const segment = segments.find(
    (candidate) => tMs >= candidate.inStart && tMs < candidate.outEnd,
  );

  if (segment == null) {
    return identity;
  }

  let progress: number;

  if (tMs < segment.inEnd) {
    const span = segment.inEnd - segment.inStart;
    progress = span > 0 ? smoothstep((tMs - segment.inStart) / span) : 1;
  } else if (tMs < segment.outStart) {
    progress = 1;
  } else {
    const span = segment.outEnd - segment.outStart;
    progress = span > 0 ? 1 - smoothstep((tMs - segment.outStart) / span) : 0;
  }

  // Clamped at the segment's *own* scale, once, and then travelled toward on
  // the same eased parameter as the zoom. Re-clamping at the interpolated scale
  // instead would pull the centre back toward the middle early in the ease and
  // let it out again later, so the pan would lag the push and then catch up —
  // two motions rather than one.
  //
  // It cannot leave the frame. Writing `d = |target - centre|`, the clamp gives
  // `d <= (W/2)(1 - 1/S)` and the constraint at progress `p` is
  // `p·d <= (W/2)(1 - 1/s)` with `s = 1 + (S - 1)p`. Both sides are zero at
  // `p = 0`, and the right grows faster there — `S - 1` against `(S - 1)/S` —
  // so the inequality holds across the whole ease for every `S > 1`.
  const scale = 1 + (segment.scale - 1) * progress;
  const centered = clampCenter(segment.cx, segment.cy, segment.scale, frame);

  return {
    scale,
    cx: identity.cx + (centered.cx - identity.cx) * progress,
    cy: identity.cy + (centered.cy - identity.cy) * progress,
  };
}
