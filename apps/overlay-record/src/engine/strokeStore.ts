/**
 * The annotations the compositor draws, as the engine sees them.
 *
 * Strokes are made in the *overlay* window and composited in the *engine*
 * window, which are two renderer processes that share no memory — so they cross
 * through the main process, arriving here as whole strokes rather than as
 * points. An in-progress stroke is re-sent as it grows and replaces its earlier
 * self by id, which is what makes the line appear in the recording as it is
 * being drawn rather than popping in complete when the pen lifts. Idempotent by
 * construction: a dropped or duplicated message costs at most one frame.
 *
 * Coordinates are **normalised to the display**, `0..1` on both axes. The
 * overlay works in CSS pixels of a window covering one display and the
 * compositor works in capture-frame pixels, and those differ by the scale
 * factor, by the quality setting, and by whatever `captureSizeLadder` had to
 * negotiate down to. Normalised is the only space both can agree on without one
 * of them knowing the other's business.
 *
 * The fade is timed from **when a stroke stopped changing**, measured on the
 * engine's own clock. The alternative — trusting the timestamps in the points —
 * would mix two renderers' `performance.now()` origins, which share no epoch.
 */

import {
  STROKE_FADE_MS,
  STROKE_HOLD_MS,
} from "@app/features/record/strokeRender";

/** A stroke as it crosses the wire. Normalised, and with no timestamps in it. */
export type LiveStroke = {
  id: string;
  color: string;
  /** Line width as a fraction of the frame's height, so it scales with it. */
  widthN: number;
  points: { x: number; y: number }[];
};

export type StrokeMessage =
  | { kind: "stroke"; stroke: LiveStroke }
  | { kind: "clear" };

type Entry = { stroke: LiveStroke; lastUpdate: number };

const entries = new Map<string, Entry>();

export function upsertStroke(stroke: LiveStroke, now: number): void {
  entries.set(stroke.id, { stroke, lastUpdate: now });
}

/**
 * Whether there is anything to draw at all.
 *
 * Asked once per encoded frame to decide between the compositing path and the
 * zero-copy one, so it allocates nothing. Counts strokes that are still fading
 * as present — `visibleStrokes` is what actually retires them.
 */
export function hasStrokes(): boolean {
  return entries.size > 0;
}

export function clearStrokes(): void {
  entries.clear();
}

export function applyStrokeMessage(message: StrokeMessage, now: number): void {
  if (message.kind === "clear") {
    clearStrokes();
  } else if (message.stroke?.id != null) {
    upsertStroke(message.stroke, now);
  }
}

/**
 * What to draw, and how strongly, at `now`.
 *
 * Fully faded strokes are dropped as they are found, so a long take does not
 * accumulate every line ever drawn — this runs once per encoded frame.
 */
export function visibleStrokes(
  now: number,
): { stroke: LiveStroke; alpha: number }[] {
  const visible: { stroke: LiveStroke; alpha: number }[] = [];

  for (const [id, entry] of entries) {
    const since = now - entry.lastUpdate - STROKE_HOLD_MS;

    if (since <= 0) {
      visible.push({ stroke: entry.stroke, alpha: 1 });
      continue;
    }

    const alpha = 1 - since / STROKE_FADE_MS;

    if (alpha <= 0) {
      entries.delete(id);
      continue;
    }

    visible.push({ stroke: entry.stroke, alpha });
  }

  return visible;
}
