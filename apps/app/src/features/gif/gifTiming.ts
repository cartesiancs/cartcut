/**
 * When each frame of a GIF is on screen.
 *
 * Pure and DOM-free. Every frame carries its own delay, and a GIF whose
 * frames differ (a held pose, then a quick burst) plays at the wrong pace
 * when the first frame's delay is applied to all of them, which is what
 * `renderer/gif.ts` used to do.
 */

/**
 * A frame's delay as a browser shows it.
 *
 * A delay of 10ms or less, or none at all, is shown for 100ms by Chromium and
 * Firefox, and ffmpeg's GIF demuxer applies the same rule. Taking the stored
 * value literally would play a "0" frame for nothing and make a whole GIF
 * written with zero delays a strobe.
 */
export function frameDelayMs(raw: number | undefined): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 10 ? raw : 100;
}

export type GifTiming = {
  /** Where each frame starts within one loop, in ms. `starts[0]` is 0. */
  starts: readonly number[];
  /** One pass through every frame, in ms. */
  loopMs: number;
};

export function gifTiming(delays: readonly (number | undefined)[]): GifTiming {
  const starts: number[] = [];
  let at = 0;
  for (const delay of delays) {
    starts.push(at);
    at += frameDelayMs(delay);
  }
  return { starts, loopMs: at };
}

/**
 * The frame showing `localMs` after the clip's start, looping.
 *
 * `localMs` can be negative: a transition draws its incoming clip before the
 * clip begins. The modulo is taken positive so that is a frame near the end
 * of the loop rather than a negative index, and a non-finite time is the
 * first frame rather than a throw in the middle of a paint. `-1` only when
 * there are no frames at all.
 */
export function frameIndexAt(timing: GifTiming, localMs: number): number {
  const { starts, loopMs } = timing;
  if (starts.length === 0) {
    return -1;
  }
  if (!Number.isFinite(localMs) || !(loopMs > 0)) {
    return 0;
  }
  const t = ((localMs % loopMs) + loopMs) % loopMs;

  // The last frame starting at or before `t`.
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= t) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/** The shortest a placed GIF is by default, before rounding up to whole loops. */
export const GIF_DEFAULT_MIN_MS = 3000;

/**
 * How long a GIF is when it is placed without a length.
 *
 * Whole loops, so the clip ends where the animation does instead of cutting
 * it off mid-move, and at least `GIF_DEFAULT_MIN_MS`, so a 1.5s emoji is not
 * gone before anyone sees it. An unknown length gets `fallbackMs`, the length
 * a still gets, and so does a single-frame GIF, whose probe reports 0.
 */
export function defaultGifLengthMs(loopMs: number, fallbackMs: number): number {
  if (!(loopMs > 0) || !Number.isFinite(loopMs)) {
    return fallbackMs;
  }
  return Math.ceil(GIF_DEFAULT_MIN_MS / loopMs) * loopMs;
}

/** What `domProber.gif` reports as a GIF's length: a loop, or 0 for a still. */
export function probedGifLengthMs(timing: GifTiming): number {
  return timing.starts.length > 1 ? timing.loopMs : 0;
}
