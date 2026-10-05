/**
 * Where a note's pin sits on the timeline canvas, what a press lands on, and
 * how the pin is drawn.
 *
 * Drawn by the canvas rather than laid over it as DOM, so a pin is placed from
 * the same layout as the clips in the same frame and cannot drift from them
 * during a scroll, a zoom or a row resize. Hit tests read the pins the last
 * paint placed, for the reason `elementTimelineCanvas#drawCanvas` gives about
 * `this.layout`.
 *
 * The shape is a comment pin: a round bubble with its bottom-left corner left
 * square, and that corner is the point the note is about.
 */

import {
  timeAtX,
  trackAtY,
  xAtTime,
  type TimelineLayout,
  type TrackRow,
} from "../timeline/layout";
import type { TimelineNote } from "./notes";

export const NOTE_PIN_PX = 20;

const PIN_RADIUS = NOTE_PIN_PX / 2;
const PIN_FONT = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif';
const PIN_FILL = "#f1f3f5";
const PIN_TEXT = "#0f1012";
const PIN_OPEN_FILL = "#3d7eff";
const PIN_OPEN_TEXT = "#ffffff";
const PIN_OUTLINE = "rgba(0, 0, 0, 0.6)";

export type NotePin = {
  id: string;
  /** The label, 1-based, in the order the notes were made. */
  n: number;
  /** The pin's top-left, in canvas px. Its tip is at (`x`, `y + NOTE_PIN_PX`). */
  x: number;
  y: number;
};

export type NoteAnchor = { trackId: string; atMs: number };

/**
 * Where a note made at canvas point (`x`, `y`) belongs.
 *
 * A point between or below the rows goes to the nearest one, so every part of
 * the canvas can take a note. `null` only when there is no row at all.
 */
export function noteAnchorAt(
  layout: TimelineLayout,
  x: number,
  y: number,
  range: number,
  hScroll: number,
): NoteAnchor | null {
  const trackId = trackAtY(layout, y) ?? nearestRow(layout.rows, y)?.trackId;
  if (trackId == null) {
    return null;
  }
  return { trackId, atMs: Math.max(0, Math.round(timeAtX(x, range, hScroll))) };
}

function nearestRow(rows: readonly TrackRow[], y: number): TrackRow | null {
  let best: TrackRow | null = null;
  let bestDistance = Infinity;
  for (const row of rows) {
    const distance =
      y < row.top ? row.top - y : Math.max(0, y - (row.top + row.height));
    if (distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The pins to draw, in the order they are drawn.
 *
 * A note on a track the layout does not have (deleted, waiting for an undo) has
 * no pin and takes no number. Pins outside the viewport are numbered and then
 * left out.
 */
export function placeNotePins(
  notes: readonly TimelineNote[],
  layout: TimelineLayout,
  range: number,
  hScroll: number,
  viewport: { w: number; h: number },
): NotePin[] {
  const rows = new Map(layout.rows.map((row) => [row.trackId, row]));
  const pins: NotePin[] = [];
  let n = 0;
  for (const note of notes) {
    const row = rows.get(note.trackId);
    if (row == null) {
      continue;
    }
    n += 1;
    const x = xAtTime(note.atMs, range, hScroll);
    const y = row.top + (row.height - NOTE_PIN_PX) / 2;
    if (
      x + NOTE_PIN_PX < 0 ||
      x > viewport.w ||
      y + NOTE_PIN_PX < 0 ||
      y > viewport.h
    ) {
      continue;
    }
    pins.push({ id: note.id, n, x, y });
  }
  return pins;
}

/** The note whose pin is under (`x`, `y`). The pin drawn last wins an overlap. */
export function notePinAt(
  pins: readonly NotePin[],
  x: number,
  y: number,
): string | null {
  for (let i = pins.length - 1; i >= 0; i -= 1) {
    const pin = pins[i];
    if (
      x >= pin.x &&
      x <= pin.x + NOTE_PIN_PX &&
      y >= pin.y &&
      y <= pin.y + NOTE_PIN_PX
    ) {
      return pin.id;
    }
  }
  return null;
}

export function drawNotePins(
  ctx: CanvasRenderingContext2D,
  pins: readonly NotePin[],
  openId: string | null,
): void {
  if (pins.length === 0) {
    return;
  }
  ctx.save();
  ctx.font = PIN_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;
  ctx.strokeStyle = PIN_OUTLINE;
  for (const pin of pins) {
    const open = pin.id === openId;
    ctx.beginPath();
    ctx.roundRect(pin.x, pin.y, NOTE_PIN_PX, NOTE_PIN_PX, [
      PIN_RADIUS,
      PIN_RADIUS,
      PIN_RADIUS,
      0,
    ]);
    ctx.fillStyle = open ? PIN_OPEN_FILL : PIN_FILL;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = open ? PIN_OPEN_TEXT : PIN_TEXT;
    ctx.fillText(
      String(pin.n),
      pin.x + NOTE_PIN_PX / 2,
      pin.y + NOTE_PIN_PX / 2 + 0.5,
    );
  }
  ctx.restore();
}
