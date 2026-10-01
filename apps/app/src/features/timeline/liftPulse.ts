/**
 * The press a clip gives when the hold frees it from its track.
 *
 * A held clip changes nothing on screen at the moment it comes free, so
 * whether the next vertical move would change row or be ignored as a shaky
 * slide was invisible. This is the answer: the clip sinks in a couple of
 * pixels and springs back, the way a button gives under a finger, and from
 * then on it can be carried to another row.
 *
 * Drawn as a transform over the clip's own rect, never as a smaller rect.
 * Filmstrip tiles are requested at the height they are drawn (`tileH:
 * rect.h`), so a rect that shrank and grew would ask the decoder for a new
 * set of frames on every frame of the animation.
 */

import { springDurationMs, springPosition, type Spring } from "../motion/spring";

export const LIFT = {
  /**
   * How far in from each edge the clip sinks, at the deepest.
   *
   * About an eighth of the 40px row top and bottom: enough to read as a
   * press at a glance, little enough that the label stays legible through it.
   */
  PEAK_PX: 2.5,
  /** Time to sink. Short, because the hold has already been waited out. */
  PRESS_MS: 70,
  /**
   * The way back. Under-damped, so it passes its size by a fraction of a pixel
   * and settles: the bounce is what makes it read as "picked up" rather than
   * as a redraw. Overshoot is about an eighth of the press, and it has
   * settled to a hundredth of a pixel within 300ms.
   */
  SPRING: { stiffness: 1100, damping: 36 } as Spring,
} as const;

const RELEASE_MS = springDurationMs(LIFT.SPRING);

/** The whole pulse, press and release, in ms. */
export const LIFT_DURATION_MS = LIFT.PRESS_MS + RELEASE_MS;

/**
 * How far in from each edge a lifted clip is drawn, `elapsedMs` after the hold
 * completed. Negative during the overshoot. Null once the pulse is over, which
 * is how the caller knows to stop asking for frames.
 */
export function liftInsetAt(elapsedMs: number): number | null {
  if (!(elapsedMs > 0)) {
    // Zero, a clock that ran backwards, or NaN: the pulse has not begun.
    return 0;
  }
  if (elapsedMs < LIFT.PRESS_MS) {
    const u = elapsedMs / LIFT.PRESS_MS;
    // Ease out: the clip gives at once and slows as it bottoms out.
    return LIFT.PEAK_PX * (1 - (1 - u) * (1 - u));
  }
  const t = elapsedMs - LIFT.PRESS_MS;
  if (t >= RELEASE_MS) {
    return null;
  }
  return LIFT.PEAK_PX * (1 - springPosition(LIFT.SPRING, t / 1000));
}

/**
 * The scale that draws a `w` by `h` clip `insetPx` in from each edge.
 *
 * Uniform on a clip narrower than it is tall. On a wider one the long side
 * gives the same pixels as the short one rather than the same fraction:
 * scaled uniformly, a clip ten seconds long would pull each end in by tens of
 * pixels and read as moving, not as pressed.
 */
export function liftScale(
  w: number,
  h: number,
  insetPx: number,
): { sx: number; sy: number } {
  if (!(w > 0) || !(h > 0) || !Number.isFinite(insetPx)) {
    return { sx: 1, sy: 1 };
  }
  const insetX = insetPx * Math.min(1, w / h);
  return {
    sx: Math.max(0, 1 - (2 * insetX) / w),
    sy: Math.max(0, 1 - (2 * insetPx) / h),
  };
}
