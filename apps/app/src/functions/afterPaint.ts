/**
 * Run `fn` once the browser has painted the frame this call belongs to.
 *
 * A `requestAnimationFrame` callback runs *before* the rendering steps, so
 * scheduling work there puts it in front of the very paint it was meant to
 * follow. Posting a task from inside that callback is what lands it after:
 * the frame is committed by the time the task runs.
 *
 * A nested `requestAnimationFrame` is the other common spelling and is worse
 * here. It runs before the *second* paint, so the deferred work costs a whole
 * extra frame of latency for nothing.
 *
 * Used by the timeline canvas so a right press can put its context menu on
 * screen before it rebuilds the option column behind it.
 */
export function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => setTimeout(fn, 0));
}
