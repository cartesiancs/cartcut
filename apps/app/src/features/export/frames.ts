/**
 * How many frames an export produces.
 *
 * `duration` is a float in seconds, so the obvious `duration * fps` is not an
 * integer: `10.05 * 60` is `603.0000000000001`, and a `for` loop bounded by
 * that runs 604 times, rendering one frame past the end of the project. Every
 * caller has to agree on the count — the frame loop, the progress denominator,
 * and anything that partitions the range — so it is derived here and nowhere
 * else.
 */
export function frameCount(options: {
  duration: number;
  fps: number;
}): number {
  const { duration, fps } = options;
  if (!(duration > 0) || !(fps > 0)) {
    return 0;
  }
  return Math.round(duration * fps);
}

/** The timeline position, in ms, of an absolute frame index. */
export function frameTimeMs(frameIndex: number, fps: number): number {
  return (frameIndex / fps) * 1000;
}

/** Raw RGBA bytes of one frame at this size. */
export function frameByteLength(width: number, height: number): number {
  return width * height * 4;
}

/** Most bytes allowed to sit in the pipe at once, across all in-flight frames. */
const IN_FLIGHT_BYTE_BUDGET = 64 * 1024 * 1024;
const MIN_IN_FLIGHT = 2;
const MAX_IN_FLIGHT = 4;

/**
 * How many frames may be in flight to FFmpeg at once.
 *
 * With a window of one, the renderer and FFmpeg take strict turns: each idles
 * while the other works. Measured at 1080p, that cost ~38 ms per frame against
 * ~25 ms once two or more were allowed to overlap — FFmpeg's own consumption
 * is only ~5 ms of it, so most of the gap was the stall, not the encoder.
 *
 * Ordering is safe at any window size because the main-process handler writes
 * to stdin synchronously before it awaits anything, and `invoke` messages are
 * delivered in send order.
 *
 * Bounded by bytes rather than a flat count: a window of four is 32 MB at
 * 1080p but 126 MB at 4K, which is not a reasonable amount of memory to hold
 * for a few milliseconds of overlap.
 */
export function inFlightWindow(width: number, height: number): number {
  const bytes = frameByteLength(width, height);
  if (!(bytes > 0)) {
    return MIN_IN_FLIGHT;
  }
  const affordable = Math.floor(IN_FLIGHT_BYTE_BUDGET / bytes);
  return Math.max(MIN_IN_FLIGHT, Math.min(MAX_IN_FLIGHT, affordable));
}
