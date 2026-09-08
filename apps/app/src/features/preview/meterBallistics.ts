/**
 * How the level meter moves, as opposed to what it reads.
 *
 * `audioLevel.compositeLevel` answers a fresh number every repaint — up to 120
 * of them a second on this project's footage — and a bar drawn straight from
 * that is a strobe, not a reading. Every meter in every audio tool therefore
 * has ballistics: fast attack, slow release, and a peak marker that hangs.
 *
 * A reducer with an injected clock, for the reason `asset/assetHover.ts` states
 * at length: the boundaries that matter here — what the bar shows 200ms into a
 * decay, whether a peak marker is still up at 999ms and gone at 1001ms — are
 * only observable if the arithmetic is separable from the `requestAnimationFrame`
 * loop that drives it. There is no DOM test environment in this repo, so logic
 * left inside the Lit component is logic that cannot be tested at all.
 *
 * Pure and DOM-free.
 */

/** Rise is instant, so there is no attack constant — only a release. */
export type MeterState = {
  /** What the bar draws, 0..1. */
  level: number;
  /** The peak marker's height, 0..1. */
  hold: number;
  /** When the marker starts falling. Clock-relative, ms. */
  holdUntilMs: number;
  /** The clock reading this state was computed at, ms. */
  atMs: number;
};

export const SILENT: MeterState = {
  level: 0,
  hold: 0,
  holdUntilMs: 0,
  atMs: 0,
};

/**
 * Fraction of the remaining level left after one second of decay.
 *
 * Chosen rather than derived: 0.02 puts a full-scale transient at roughly a
 * fifth of the bar after 400ms, which reads as a fall the eye can follow
 * without the bar still visibly hanging around a second later.
 */
const RELEASE_PER_SECOND = 0.02;

/** How long the peak marker stays put before it starts falling. */
export const HOLD_MS = 1000;

/** The marker's own fall, slower than the bar's so it stays readable. */
const HOLD_FALL_PER_SECOND = 0.35;

/**
 * Below this the meter is at rest, and the caller may stop asking.
 *
 * An exponential decay never actually reaches zero, so without a floor the
 * bottom of every fade would keep a `requestAnimationFrame` loop alive for the
 * rest of the session, repainting a bar nobody can see move.
 */
export const SILENCE_EPSILON = 0.0005;

/** Whether this state still has somewhere to fall. */
export function isMoving(state: MeterState): boolean {
  return state.level > SILENCE_EPSILON || state.hold > SILENCE_EPSILON;
}

/**
 * The meter one clock reading later.
 *
 * Rise is instant and fall is exponential: a peak that is missed is a peak that
 * was not shown, whereas a fall that lags is exactly what makes the bar
 * legible.
 *
 * **Returns its input by identity when nothing moved.** The repo's decline
 * convention, and load-bearing here rather than tidy: the drawing loop tests
 * the returned state against the one it had, so a meter sitting at zero through
 * a long silent stretch stops repainting instead of clearing and refilling the
 * same pixels sixty times a second.
 *
 * A `nowMs` at or before the previous reading elapses no time. Not defensive
 * padding: `performance.now()` is monotonic but the *first* call after a state
 * built at zero is not, and the honest answer for zero elapsed time is the
 * state unchanged.
 */
export function advanceMeter(
  state: MeterState,
  target: number,
  nowMs: number,
): MeterState {
  const clamped = Number.isFinite(target) ? Math.min(1, Math.max(0, target)) : 0;
  const elapsedMs = Math.max(0, nowMs - state.atMs);
  const seconds = elapsedMs / 1000;

  let level: number;
  if (clamped >= state.level) {
    level = clamped;
  } else {
    level = state.level * RELEASE_PER_SECOND ** seconds;
    if (level < clamped) {
      level = clamped;
    }
  }
  if (level < SILENCE_EPSILON) {
    level = 0;
  }

  let hold = state.hold;
  let holdUntilMs = state.holdUntilMs;
  // Strictly greater, not `>=`. Re-arming on equality restarts the hold window
  // on every frame of a sustained tone and on every frame of silence, which
  // makes the identity return below unreachable exactly when it is worth most.
  // A level that merely *matches* the marker still keeps it up, because the
  // fall below clamps to `level` and so cannot move it.
  if (level > hold) {
    hold = level;
    holdUntilMs = nowMs + HOLD_MS;
  } else if (nowMs >= holdUntilMs) {
    hold = hold - HOLD_FALL_PER_SECOND * seconds;
    if (hold < level) {
      hold = level;
    }
    if (hold < SILENCE_EPSILON) {
      hold = 0;
    }
  }

  if (
    level === state.level &&
    hold === state.hold &&
    holdUntilMs === state.holdUntilMs
  ) {
    return state;
  }

  return { level, hold, holdUntilMs, atMs: nowMs };
}

/** A meter reset to rest at `nowMs` — what stopping playback leaves behind. */
export function silentAt(nowMs: number): MeterState {
  return { level: 0, hold: 0, holdUntilMs: 0, atMs: nowMs };
}
