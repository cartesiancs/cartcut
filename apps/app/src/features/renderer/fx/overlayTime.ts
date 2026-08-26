/**
 * Where a looping overlay is in its own media, at a given moment.
 *
 * Deliberately **not** in `geometry.ts`, and it must not move there. That
 * module enforces one invariant — `trim` is a window into the source file, and
 * `duration === trim.endTime - trim.startTime` — and every clip obeys it. An
 * overlay effect obeys a different rule: it has no `trim` at all, it repeats,
 * and its position is a modulo rather than an offset. Putting the two sets of
 * arithmetic in one file is how three subsystems came to disagree about `trim`
 * in the first place; keeping them apart is cheap insurance against a repeat.
 *
 * Pure and DOM-free.
 */

import type { EffectElementType } from "../../../@types/timeline";

/**
 * Source milliseconds an overlay should be showing at timeline time `t`.
 *
 * Wraps, so a two-second rain loop covers a thirty-second effect. Returns 0
 * when the media length is not yet known — a `<video>` reports `duration` as
 * `NaN` until it has metadata, and `NaN % n` is `NaN`, which would seek the
 * handle to an invalid position and leave it there.
 */
export function overlaySourceTimeAt(
  element: EffectElementType,
  timeInMs: number,
  sourceDurationMs: number,
): number {
  if (!(sourceDurationMs > 0) || !Number.isFinite(sourceDurationMs)) {
    return 0;
  }
  const elapsed = timeInMs - element.startTime;
  if (elapsed <= 0) {
    return 0;
  }
  return elapsed % sourceDurationMs;
}

/**
 * Whether a handle sitting at `currentMs` is close enough to `wantMs`.
 *
 * The wrap is what makes this more than a subtraction: at the end of a loop the
 * handle is at 1990ms and the target is 10ms, which is 20ms apart, not 1980.
 * Comparing naively would seek on every wrap and stutter the loop once per
 * cycle.
 */
export function overlayDriftMs(
  currentMs: number,
  wantMs: number,
  sourceDurationMs: number,
): number {
  if (!(sourceDurationMs > 0) || !Number.isFinite(sourceDurationMs)) {
    return Math.abs(currentMs - wantMs);
  }
  const raw = Math.abs(currentMs - wantMs) % sourceDurationMs;
  return Math.min(raw, sourceDurationMs - raw);
}
