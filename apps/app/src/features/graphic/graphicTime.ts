/**
 * Where a graphic's program is in its own time.
 *
 * The graphic counterpart of `renderer/fx/effectTime.ts`, with the same two
 * rules (element-local, snapped to the frame grid by `frameStartMs` so the
 * preview and the export ask the same question) and one more: a graphic's
 * clock survives a cut. `clockHead` is the program time cut off before this
 * piece and `clockTail` the time cut off after it, so
 *
 *   t   = clockHead + local
 *   dur = clockHead + duration + clockTail
 *
 * and the two halves of a split play the original's frames, exit animation
 * included, where `t` and `dur` alone would have restarted the right half and
 * played the exit at the cut on the left.
 *
 * DOM-free and store-free.
 */

import { frameStartMs } from "../timeline/frames";

export type GraphicTime = {
  /** Program time, ms. Negative when the clip was extended at the front. */
  tMs: number;
  /** The whole program's length, ms, across every piece of a split. */
  durMs: number;
  /** `tMs / durMs`, clamped to 0..1. */
  progress: number;
  /** This piece's own elapsed time, ms, 0..duration. */
  localMs: number;
};

type Clocked = {
  startTime: number;
  duration: number;
  clockHead?: number;
  clockTail?: number;
};

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The program time at a timeline cursor.
 *
 * `local` is clamped to the piece's own span. A transition draws a clip past
 * its ends through `drawOne`, which checks no visibility, and a graphic has
 * unlimited handles; outside its span it holds its first or last frame, the
 * way a still image would.
 */
export function graphicTimeOf(
  element: Clocked,
  timeInMs: number,
  fps: number,
): GraphicTime {
  const start = finite(element.startTime, 0);
  const duration = Math.max(0, finite(element.duration, 0));
  const head = finite(element.clockHead, 0);
  const tail = Math.max(0, finite(element.clockTail, 0));

  const snapped = frameStartMs(timeInMs, fps);
  const localMs = Math.min(duration, Math.max(0, snapped - start));
  const tMs = head + localMs;
  const durMs = Math.max(0, head + duration + tail);
  const progress =
    durMs > 0 ? Math.min(1, Math.max(0, tMs / durMs)) : 1;
  return { tMs, durMs, progress, localMs };
}

/**
 * The element with its clock moved, keys deleted at their defaults.
 *
 * `clockHead` may go negative (a front trim extended past where the program
 * began, which shows the program's before-state); `clockTail` may not, because
 * the end of a program cannot be later than its own length.
 */
export function withClockShift<T extends Clocked>(
  element: T,
  headDelta: number,
  tailDelta: number,
): T {
  const head = finite(element.clockHead, 0) + headDelta;
  const tail = Math.max(0, finite(element.clockTail, 0) + tailDelta);
  const { clockHead: _head, clockTail: _tail, ...rest } = element as T & Clocked;
  return {
    ...(rest as T),
    ...(head !== 0 ? { clockHead: head } : {}),
    ...(tail !== 0 ? { clockTail: tail } : {}),
  };
}
