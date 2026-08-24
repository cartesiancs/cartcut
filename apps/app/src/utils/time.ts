export function millisecondsToPx(ms: number, timelineRange: number) {
  const timeMagnification = timelineRange / 4;
  const convertPixel = (ms / 5) * timeMagnification;
  const result = Number(convertPixel.toFixed(0));
  if (result <= 0) {
    return 0;
  }

  return result;
}

export function pxToMilliseconds(px: number, timelineRange: number) {
  const timeMagnification = timelineRange / 4;
  const convertMs = (px * 5) / timeMagnification;
  return Number(convertMs.toFixed(0));
}

export function formatSeconds(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Slack at the edges of a clip's window, in ms.
 *
 * Frame-accurate editing puts a clip's start on an exact frame instant, but the
 * value reaches the document as `startTime + (target - startTime)`, and
 * IEEE-754 does not promise that equals `target` — measured over 200,000 random
 * placements it misses by up to 4.4e-11 ms. One ULP high is enough for a strict
 * `t >= start` to reject the very instant the edit was aligned to, and the clip
 * silently loses its first exported frame.
 *
 * A microsecond is five orders of magnitude above that error and six below
 * anything an edit can express, so it absorbs the noise without widening the
 * window in any observable way.
 */
const EDGE_SLACK_MS = 1e-6;

/**
 * Whether `t` falls inside the half-open window `[start, end)`.
 *
 * Both ends shift by the same slack, so the window's *length* — and therefore
 * the number of frames a clip contributes to an export — is unchanged. Shifting
 * only the start would let a clip whose end sits one ULP high claim an extra
 * frame.
 *
 * `isTimeInRange(5, 5, 5)` is still false; an empty window admits nothing.
 */
export function isTimeInRange(t: number, start: number, end: number): boolean {
  return t >= start - EDGE_SLACK_MS && t < end - EDGE_SLACK_MS;
}
