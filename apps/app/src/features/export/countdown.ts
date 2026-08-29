/**
 * The number the user actually reads, and the rule that it only ever falls.
 *
 * Kept separate from the estimate in `eta.ts` on purpose. An estimate is
 * allowed to be noisy and to move in both directions; a countdown is not. A
 * remaining time that jumps from "12s" back up to "20s" reads as broken even
 * when it is the more honest of the two numbers, so this layer converts an
 * estimate into a display that decreases at a rate it chooses.
 *
 * Pure, `now` as a parameter, no timers. The interval lives in the UI.
 */
export type CountdownState = {
  /** Milliseconds currently shown, unrounded. Non-increasing after priming. */
  readonly displayMs: number;
  /** `now` at the last tick. */
  readonly at: number;
  /** False until the first real estimate has arrived. */
  readonly primed: boolean;
};

/**
 * How often the UI should tick.
 *
 * Four times a second rather than once, for two reasons: a 1000ms interval
 * beats against the whole-second rounding below and produces visibly skipped
 * and repeated seconds, and a large downward correction would take up to a full
 * second to start showing. Four wakeups a second against a frame loop moving
 * 8MB per frame is not measurable.
 */
export const COUNTDOWN_TICK_MS = 250;

/**
 * The slowest the display may fall, as a multiple of real time.
 *
 * Not zero: a number that stops moving entirely reads as a hung application.
 * At a tenth of real time the user still sees it tick off a second every ten.
 */
export const COUNTDOWN_MIN_RATE = 0.1;

/**
 * The fastest the display may fall.
 *
 * A hard snap down to a lower estimate would let one noisy sample destroy the
 * display permanently. Capping the catch-up keeps a genuine correction quick —
 * a ten-minute over-estimate is paid off in a little over three minutes — while
 * a single spurious low reading is absorbed.
 */
export const COUNTDOWN_MAX_RATE = 3;

export function createCountdown(now: number): CountdownState {
  return { displayMs: 0, at: now, primed: false };
}

/**
 * Advance the display to `now`.
 *
 * The rate is `displayMs / estimateMs`, and that is the only interesting line
 * here. It is the unique rate at which the display reaches zero at the same
 * instant the estimate does: if the estimate is truthful it falls at one
 * millisecond per millisecond, so with `u = D/E` the derivative
 * `u' = (D'E - DE')/E²` is `(-D + D)/E²`, which is zero. The ratio is
 * invariant, so a display that is twenty percent low stays twenty percent low
 * *proportionally* and still lands on zero on time — rather than hitting zero
 * early and sitting there, which is the usual failure of a hand-rolled
 * countdown.
 *
 * The three behaviours fall out of that one expression:
 *
 * - the estimate agrees with the display, and it counts down at 1s per second;
 * - the estimate drops, and it falls faster, bounded by `COUNTDOWN_MAX_RATE`;
 * - the estimate rises, and it slows rather than rising, bounded below by
 *   `COUNTDOWN_MIN_RATE`.
 *
 * Monotonicity is structural: `dt >= 0` and the rate is positive, so the result
 * is never above `displayMs` at any step except the single priming one.
 */
export function tickCountdown(
  state: CountdownState,
  estimateMs: number | null,
  now: number,
): CountdownState {
  if (!Number.isFinite(now)) {
    return state;
  }
  const dt = Math.max(0, now - state.at);

  // Warming up, or finalizing: there is nothing to count toward. Advance the
  // clock so the next tick measures from here rather than replaying the gap.
  if (estimateMs == null || !Number.isFinite(estimateMs)) {
    return { ...state, at: now };
  }

  // The one moment the display is allowed to rise. Everything after is monotone.
  if (!state.primed) {
    return { displayMs: Math.max(0, estimateMs), at: now, primed: true };
  }

  // `estimateMs + dt` is the estimate as it stood at the *start* of this step,
  // reconstructed rather than stored: a truthful estimate falls at one
  // millisecond per millisecond, so it was `dt` larger a moment ago. Dividing
  // by the end-of-step value instead is the obvious version and it is wrong in
  // a way that compounds — the display then runs progressively ahead and
  // reaches zero a whole tick before the estimate does, having drained 25% of
  // its remaining value over the final second. This costs nothing and makes the
  // invariance below exact at every step rather than only in the limit.
  const rate = Math.min(
    COUNTDOWN_MAX_RATE,
    Math.max(COUNTDOWN_MIN_RATE, state.displayMs / Math.max(estimateMs + dt, 1)),
  );

  return {
    displayMs: Math.max(0, state.displayMs - dt * rate),
    at: now,
    primed: true,
  };
}

/**
 * The whole seconds to show.
 *
 * `ceil`, so "1s left" stands until there genuinely is none; and never zero,
 * because the running phase has no honest way to say "no time left" — when
 * there is nothing left to count the UI changes to its finalizing label
 * instead. This is the honest version of the bar that sits at 99% forever.
 */
export function countdownSeconds(state: CountdownState): number {
  if (!Number.isFinite(state.displayMs)) {
    return 1;
  }
  return Math.max(1, Math.ceil(state.displayMs / 1000));
}
