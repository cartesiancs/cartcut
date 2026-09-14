/**
 * How fast the edit lands.
 *
 * When a transcript comes back the session cuts the silences and places every
 * caption, and doing that in one write would show the user a timeline that was
 * one thing and is now another, with nothing in between to say what happened.
 * So the steps are dealt out from the start of the project forwards, and this
 * module is the only thing that decides when each one is due.
 *
 * It is arithmetic over an elapsed time, with no clock of its own, because the
 * clock is injected: the session drives it from `FrameScheduler`, and the suite
 * drives it from a counter.
 *
 * ## The pace is per step, inside bounds
 *
 * A fixed total would make three captions crawl and two hundred flicker. A
 * fixed interval would make two hundred take nine seconds, which is no longer
 * an animation, it is a wait. So the interval is the quantity that is fixed,
 * and the total it implies is clamped at both ends.
 *
 * There is no cap on how many steps may fall in one frame. Past about 26 steps
 * the interval is shorter than a frame and several land together, which is
 * correct: the work is the same either way, and the alternative is dropping
 * steps the user asked for to keep a cadence nobody can see.
 */

/** How long one step would like to have, in ms. */
export const REVEAL_STEP_MS = 45;

/** Below this the cascade reads as a stutter rather than a sweep. */
export const REVEAL_MIN_MS = 240;

/** Above this it stops being an animation and becomes a wait. */
export const REVEAL_MAX_MS = 1400;

/**
 * How long the whole reveal takes.
 *
 * Zero for an empty plan, which is what makes "nothing to reveal" finish
 * immediately rather than after a beat of nothing happening.
 */
export function revealDurationMs(totalSteps: number): number {
  if (totalSteps <= 0) {
    return 0;
  }
  return Math.min(
    REVEAL_MAX_MS,
    Math.max(REVEAL_MIN_MS, totalSteps * REVEAL_STEP_MS),
  );
}

/**
 * How many steps are due by `elapsedMs`.
 *
 * Monotone, starts above zero and ends exactly at `totalSteps`. The first step
 * is due at the first tick rather than at the first interval's end: the reveal
 * begins the moment the user has stopped waiting, and an empty beat at the
 * front reads as the app having missed the press.
 */
export function stepsDueAt(elapsedMs: number, totalSteps: number): number {
  if (totalSteps <= 0) {
    return 0;
  }

  const duration = revealDurationMs(totalSteps);
  if (elapsedMs >= duration) {
    return totalSteps;
  }

  const fraction = Math.max(0, elapsedMs) / duration;
  return Math.min(totalSteps, Math.floor(fraction * totalSteps) + 1);
}

/** Whether the reveal has finished. The session's exit condition. */
export function revealDone(elapsedMs: number, totalSteps: number): boolean {
  return stepsDueAt(elapsedMs, totalSteps) >= totalSteps;
}
