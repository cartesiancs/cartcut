import type { CostCurve } from "./cost";

/**
 * How long an export has left.
 *
 * Split deliberately into `observeEta`, which folds in a new measurement, and
 * `readEta`, which is a function of the wall clock alone. That split is the
 * whole reason the display can tick down once a second: the estimate keeps
 * moving between frames, and a frame loop that stalls on a slow seek makes the
 * number grow instead of freezing it, which is what the old inline estimator in
 * `ControlRender` could not do.
 *
 * Pure, and `now` is always a parameter — so every case here is a table-driven
 * test with no timers and no DOM.
 */
export type EtaConfig = {
  /** Predicted work in the whole export, from `cost.ts#buildCostCurve`. */
  totalUnits: number;
  /** FFmpeg's flush after stdin closes, which reports nothing. */
  tailMs: number;
};

export type EtaState = {
  readonly config: EtaConfig;
  /** Work units completed. */
  readonly units: number;
  /** `now` at the first observation, or null before it. */
  readonly firstAt: number | null;
  /** `now` at the most recent observation. */
  readonly lastAt: number;
  /** Milliseconds per work unit — an EMA in the *work* domain. */
  readonly rate: number | null;
};

export type EtaReading =
  | { kind: "warmup" }
  | { kind: "remaining"; ms: number }
  | { kind: "finalizing" };

/**
 * The rate EMA's horizon, as a fraction of the total work.
 *
 * In the *work* domain, not the wall-clock one, and that is the point. A
 * wall-clock time constant cannot be chosen: five seconds is a third of a
 * 15-second smoke export and 0.4% of an 18-minute one, so the same number means
 * two entirely different amounts of smoothing. A fraction of the job means the
 * same thing at both sizes — and because the step is driven by the work done
 * rather than by the number of samples, a 10Hz callback and a 1Hz one still
 * produce the same curve.
 */
const HORIZON_FRACTION = 0.05;

/** Floor, so a very short export is not steered by two frames of noise. */
const MIN_HORIZON_UNITS = 24;

/**
 * Never average over more than half the work that is left.
 *
 * Without this the estimator carries the memory of a stall into the final
 * percent, where there is no work left to correct it — and the last ten seconds
 * are exactly where a wrong number is most obvious.
 */
const HORIZON_SHRINK = 0.5;

/**
 * How much of the global average is blended in, at most.
 *
 * A variance reducer for the early, noisy part of the run and nothing more.
 * Letting this grow toward 1 as progress rises — the obvious "confidence
 * increases with time" design — is measurably worse, because a real export
 * accelerates: it loads assets cold and warms up, so the cumulative average
 * stays biased by a beginning that will not be repeated, and over-estimates
 * badly near the end. Saying "3 minutes left" and finishing in 100 seconds is
 * the single worst thing a progress dialog can do, so the blend is capped and
 * held.
 */
const CUM_WEIGHT_MAX = 0.25;

/** Progress at which the blend reaches its cap. */
const CUM_WEIGHT_FULL_AT = 0.25;

/** Work that must be done before any number is shown. */
const WARMUP_MIN_UNITS = 12;

/**
 * Wall clock that must pass before any number is shown.
 *
 * Loading the timeline's assets and rendering frame zero measures ~550ms, and
 * it is not representative of anything that follows. A first estimate that is
 * three times wrong poisons the whole run — the countdown can only go down, so
 * a bad first value has to be paid off by a visible pause.
 */
const WARMUP_MIN_MS = 1500;

/** How long a single frame may take before its overrun counts against the ETA. */
const STALL_GRACE_MS = 2000;
const STALL_GRACE_RATE_MULTIPLE = 8;

/**
 * The most one frame may claim the *rest* of the job will cost, as a multiple
 * of the rate so far.
 *
 * A stalled frame is unbounded above and its instantaneous rate is
 * `stallDuration / 1`, so without this a single 30-second seek tells the EMA
 * that every remaining frame costs 30 seconds — measured, that multiplied the
 * estimate twentyfold and took thousands of frames to decay back out. What a
 * long frame is actually evidence of is *that frame*, not the five thousand
 * behind it, and the time it really cost is already charged honestly by
 * `stallExcess` below. So the stall is paid for once, as elapsed time, rather
 * than twice and forever as a rate.
 *
 * Only the upper side needs clamping: an unusually *fast* frame is bounded
 * below by zero and cannot distort the average by more than the average.
 */
const MAX_INSTANT_RATE_MULTIPLE = 10;

const TAIL_BASE_MS = 300;
const TAIL_PER_FRAME_MS = 0.15;
const TAIL_MIN_MS = 500;
const TAIL_MAX_MS = 8000;

/**
 * How long FFmpeg keeps working after the last frame.
 *
 * `finishStream` closes stdin and returns immediately, so this tail reports
 * nothing at all: measured from the last progress sample to `PROCESSING_FINISH`
 * it is ~0.5s at 600 frames, ~1.0s at 2,400 and ~3.1s at 18,000. Output size
 * does not fit those points (54MB is 21x 2.6MB but only 3x the tail); frame
 * count does, roughly, and three points measured through a 500ms poll do not
 * justify more than a line.
 *
 * Its accuracy barely matters, because the display switches to a "finalizing"
 * label with no number the moment the frame loop ends. It exists so the
 * countdown does not reach zero several seconds early.
 */
export function finishTailMs(totalFrames: number): number {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
    return TAIL_MIN_MS;
  }
  return Math.min(
    TAIL_MAX_MS,
    Math.max(TAIL_MIN_MS, TAIL_BASE_MS + totalFrames * TAIL_PER_FRAME_MS),
  );
}

export function createEtaState(config: EtaConfig): EtaState {
  const totalUnits =
    Number.isFinite(config.totalUnits) && config.totalUnits > 0
      ? config.totalUnits
      : 0;
  const tailMs =
    Number.isFinite(config.tailMs) && config.tailMs > 0 ? config.tailMs : 0;

  return {
    config: { totalUnits, tailMs },
    units: 0,
    firstAt: null,
    lastAt: 0,
    rate: null,
  };
}

/**
 * Fold one measurement into the estimate.
 *
 * Returns its input **by identity** when the observation carries nothing — a
 * repeated or decreasing frame index — which is the same convention the
 * timeline's pure ops use for a declined edit.
 */
export function observeEta(
  state: EtaState,
  units: number,
  now: number,
): EtaState {
  if (!Number.isFinite(units) || !Number.isFinite(now)) {
    return state;
  }
  if (!(units > state.units)) {
    return state;
  }

  if (state.firstAt == null) {
    return { ...state, units, firstAt: now, lastAt: now };
  }

  const dUnits = units - state.units;
  const dt = Math.max(0, now - state.lastAt);
  const raw = dt / dUnits;
  const instant =
    state.rate == null
      ? raw
      : Math.min(raw, state.rate * MAX_INSTANT_RATE_MULTIPLE);

  const remaining = Math.max(0, state.config.totalUnits - units);
  const nominal = Math.max(
    MIN_HORIZON_UNITS,
    HORIZON_FRACTION * state.config.totalUnits,
  );
  const capped = Math.max(MIN_HORIZON_UNITS, remaining * HORIZON_SHRINK);
  const horizon = Math.min(nominal, capped);

  const alpha = 1 - Math.exp(-dUnits / horizon);
  const rate =
    state.rate == null ? instant : state.rate + alpha * (instant - state.rate);

  return { ...state, units, lastAt: now, rate };
}

/**
 * What to show at `now`.
 *
 * A function of the wall clock, so it keeps moving with no new observations.
 */
export function readEta(state: EtaState, now: number): EtaReading {
  const { totalUnits, tailMs } = state.config;
  if (!(totalUnits > 0)) {
    return { kind: "finalizing" };
  }

  const remaining = totalUnits - state.units;
  if (remaining <= 0) {
    return { kind: "finalizing" };
  }

  if (state.rate == null || state.firstAt == null) {
    return { kind: "warmup" };
  }

  const elapsed = now - state.firstAt;
  if (state.units < WARMUP_MIN_UNITS || elapsed < WARMUP_MIN_MS) {
    return { kind: "warmup" };
  }

  // Measured to the last observation, not to `now`. Taking it to `now` would
  // make the blended rate creep upward during every ordinary gap between
  // frames, so the estimate drifted a little every time it was read and the
  // stall term below double-counted the same waiting. Keeping the rate a
  // function of observations alone leaves `stallExcess` as the single place
  // where the passage of time enters, which is what makes the two separable.
  const cumulative = (state.lastAt - state.firstAt) / state.units;
  const progress = state.units / totalUnits;
  const weight = CUM_WEIGHT_MAX * Math.min(1, progress / CUM_WEIGHT_FULL_AT);
  const rate = state.rate * (1 - weight) + cumulative * weight;

  if (!Number.isFinite(rate) || rate < 0) {
    return { kind: "warmup" };
  }

  // The frame in flight right now. `rate * remaining` already budgets one
  // frame's worth for it, so only the *overrun* is time that still has to
  // elapse — this is what stops a thirty-second stall reading "8s left"
  // throughout, without a merely slow frame nudging the number every time.
  const grace = Math.max(STALL_GRACE_MS, rate * STALL_GRACE_RATE_MULTIPLE);
  const stallExcess = Math.max(0, now - state.lastAt - grace);

  const ms = rate * remaining + stallExcess + tailMs;
  return { kind: "remaining", ms: Number.isFinite(ms) ? Math.max(0, ms) : 0 };
}

/** Work completed once `framesDone` frames are done, through the cost curve. */
export function unitsFor(curve: CostCurve, framesDone: number): number {
  return curve.before(framesDone);
}
