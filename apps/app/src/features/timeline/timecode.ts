/**
 * The playhead as a timecode.
 *
 * The readout above the timeline used to be
 * `new Date(cursor).toISOString().slice(11, 22)` — `00:00:01.016` — which was
 * adequate while every project ran at 60fps and nothing in the UI admitted that
 * frames existed. It stops being adequate the moment the rate is a setting,
 * because milliseconds cannot answer the question the user is actually asking:
 * *which frame am I on*. At 30fps, 1.016s and 1.049s are the same frame and
 * read as two different times; at 120fps, two adjacent frames round to the same
 * millisecond.
 *
 * So: `HH:MM:SS:FF`, the form every NLE uses, with the frame counted the way
 * `frameStartMs` counts it — the frame *containing* the instant, because that
 * is the one on screen.
 *
 * No drop-frame notation, and none is needed. The semicolon separator exists
 * for the NTSC rates, where a nominal 30fps clock runs against a real
 * 30000/1001 one and has to skip labels to stay with the wall clock. This app's
 * rates are whole numbers by construction (`frames.ts#coerceFps`), so a second
 * is exactly `fps` frames and the count never drifts.
 *
 * Pure and DOM-free, like the rest of this directory.
 */

import { msToFrameFloor, normalizeFps } from "./frames";

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * `ms` as `HH:MM:SS:FF` at `fps`.
 *
 * The frame field is as wide as the rate needs — two digits up to 99fps, three
 * at 120 — so the string does not change width as the playhead moves, which is
 * what stops the whole readout from jittering during playback.
 *
 * `fps` is rounded to a whole rate. Everything upstream guarantees one already;
 * this is here so that a fractional rate arriving from somewhere unexpected
 * produces a slightly wrong label rather than a frame field that counts past
 * its own second.
 */
export function formatTimecode(ms: number, fps: number): string {
  const rate = Math.max(1, Math.round(normalizeFps(fps)));

  // Before zero there is no frame to name. The cursor is clamped at 0 by the
  // playhead itself; this keeps a stray negative from printing as `-1`.
  const total = Math.max(0, msToFrameFloor(Math.max(0, ms), rate));

  const totalSeconds = Math.floor(total / rate);
  const frames = total - totalSeconds * rate;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;

  const frameWidth = Math.max(2, String(rate - 1).length);

  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}:${pad(
    frames,
    frameWidth,
  )}`;
}
