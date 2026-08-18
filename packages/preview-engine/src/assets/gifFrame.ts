/**
 * GIF frame selection.
 *
 * Extracted verbatim from the three renderers, quirks intact: the index is
 * derived from the *absolute* timeline time, not from time elapsed since the
 * element's `startTime`, and the delay of frame 0 is used for every frame rather
 * than accumulating per-frame delays. Two GIFs placed at different start times
 * therefore stay phase-locked to the timeline instead of each starting at frame
 * 0. That is existing behaviour and is preserved deliberately — changing it is a
 * separate decision from consolidating the renderers.
 *
 * The only addition is a guard: the originals divided by `frames[0].delay`
 * without checking it, so a GIF with a 0ms delay produced `NaN` and then an
 * out-of-range frame lookup.
 */

/**
 * Index of the GIF frame to show at `timeMs`.
 * Returns 0 when the input cannot produce a meaningful index.
 */
export function pickGifFrameIndex(
  frameCount: number,
  delayMs: number,
  timeMs: number,
): number {
  if (!Number.isFinite(frameCount) || frameCount <= 0) return 0;
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
  if (!Number.isFinite(timeMs)) return 0;

  const index = Math.round(timeMs / delayMs) % frameCount;
  // `%` keeps the sign of the dividend, so a negative cursor would index backwards.
  return index < 0 ? index + frameCount : index;
}
