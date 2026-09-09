import type { Timeline } from "../../@types/timeline";
import { exportStore } from "../../states/exportStore";
import { buildCostCurve, type CostCurve } from "./cost";
import {
  COUNTDOWN_TICK_MS,
  countdownSeconds,
  createCountdown,
  tickCountdown,
  type CountdownState,
} from "./countdown";
import {
  createEtaState,
  finishTailMs,
  observeEta,
  readEta,
  type EtaState,
} from "./eta";

/**
 * The export's progress estimate, and the ticker that keeps it moving.
 *
 * A module singleton rather than state on a component, and it has to be:
 * `finishStream` closes FFmpeg's stdin and returns without waiting, so
 * `requestIPCVideoExport` resolves while FFmpeg is still muxing and the click
 * handler's `finally` runs during the tail. The finalizing phase therefore
 * outlives the function that started the export, and only `PROCESSING_FINISH`
 * in `event.ts` can end it.
 *
 * It used to paint `#progress` and `#remainingTime` inside a Bootstrap modal.
 * That modal is gone — it was also, incidentally, the only thing stopping the
 * user editing during a render — so this now **publishes into `exportStore`**
 * and the title bar's button draws from there. The maths did not move: `eta`,
 * `cost` and `countdown` are reached through exactly the same three calls.
 *
 * The phase lives in the store too, so there is one answer to "is an export
 * running" rather than two that can disagree.
 */

/**
 * The eye cannot read faster than this, and each write now wakes a Lit render
 * on a thread that is also drawing frames and pushing 8MB into a pipe.
 */
const BAR_PAINT_MS = 100;

let timer: number | null = null;
let curve: CostCurve | null = null;
let eta: EtaState | null = null;
let countdown: CountdownState | null = null;
let lastBarPaintAt = 0;
/** The percentage last published, so the ticker can republish it unchanged. */
let lastPercent = 0;

function isRunning(): boolean {
  return exportStore.getState().phase === "running";
}

/**
 * The interval body. Owns the remaining time; republishes the last percentage.
 *
 * `report` takes both numbers together so the button is woken once rather than
 * twice, and declines outright when neither the whole percent nor the whole
 * second has moved — which is what makes a 250ms ticker free.
 */
function tick(): void {
  if (!isRunning() || eta == null || countdown == null) {
    return;
  }

  const now = performance.now();
  const reading = readEta(eta, now);
  const estimate = reading.kind === "remaining" ? reading.ms : null;
  countdown = tickCountdown(countdown, estimate, now);

  // `null` is "no number to show": the component draws "Estimating…" before
  // the first real reading and "Finalizing…" once the tail has begun. Both
  // strings belong to the component, which is the half that can reach a
  // `LocaleController`.
  const remainingMs =
    reading.kind === "finalizing" || !countdown.primed
      ? null
      : countdownSeconds(countdown) * 1000;

  exportStore.getState().report(lastPercent, remainingMs);
}

function clearTimer(): void {
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
}

/** Drop the ticker and every estimate, without touching the phase. */
function reset(): void {
  clearTimer();
  curve = null;
  eta = null;
  countdown = null;
  lastBarPaintAt = 0;
  lastPercent = 0;
}

export const exportProgress = {
  /**
   * Throw away the last run's estimate and start a new one.
   *
   * **`reset`, not `stop`.** `stop` settles the phase, and `exportSession`
   * calls this immediately *before* `exportStore.begin` — so dispatching
   * `settled` here would knock the phase back to idle one line after the
   * session set it running, and the title-bar button would sit as a pill for
   * the whole export.
   *
   * Clearing the numbers is the other half: the remaining-time line used to
   * keep the previous run's value on screen until the first sample of the next
   * one landed, and the bar was authored at a hardcoded 25%.
   */
  begin(timeline: Timeline, totalFrames: number, fps: number): void {
    reset();

    curve = buildCostCurve(timeline, totalFrames, fps);
    eta = createEtaState({
      totalUnits: curve.total,
      tailMs: finishTailMs(totalFrames),
    });
    countdown = createCountdown(performance.now());

    timer = window.setInterval(tick, COUNTDOWN_TICK_MS);
  },

  /**
   * One frame has been drawn, captured, and handed to the pipe.
   *
   * On the hot path. The estimate is folded in on **every** frame — about ten
   * flops and one object literal, against a frame that costs milliseconds — and
   * only the store writes are throttled. Separating the two is the point: the
   * old code sampled and painted together, so the estimator saw a tenth of the
   * data it could have.
   *
   * `currentFrame` is 0-based and names the frame just finished, so the count
   * done is one more than it. Without the `+ 1` the bar tops out at
   * `(N-1)/N` and never reaches 100%.
   */
  onFrame(currentFrame: number, totalFrames: number): void {
    if (!isRunning() || eta == null || curve == null) {
      return;
    }

    const now = performance.now();
    const framesDone = currentFrame + 1;
    const units = curve.before(framesDone);
    eta = observeEta(eta, units, now);

    const isLast = framesDone >= totalFrames;
    if (now - lastBarPaintAt < BAR_PAINT_MS && !isLast) {
      return;
    }
    lastBarPaintAt = now;

    // Work done, not frames done. A busy stretch of timeline costs several
    // times what a sparse one does, so a frame-counted bar advances in jerks;
    // this one advances at a roughly constant rate in *time*, which is most of
    // what makes a progress bar feel honest. It also keeps the bar and the
    // remaining time consistent with each other, since both read the same axis.
    lastPercent = curve.total > 0 ? (units / curve.total) * 100 : 0;
    exportStore.getState().report(lastPercent, readRemaining());
  },

  /**
   * The frame loop is done and FFmpeg is flushing.
   *
   * Nothing is animating any more, so the ticker is pure cost — the label is
   * static until the main process reports the file is written.
   */
  finalizing(): void {
    if (exportStore.getState().phase === "idle") {
      return;
    }
    clearTimer();
    lastPercent = 100;
    // `null` remaining is what the button draws as "Finalizing…".
    exportStore.getState().report(100, null);
    exportStore.getState().dispatch("frameLoopDone");
  },

  /** `PROCESSING_FINISH`. */
  finish(): void {
    lastPercent = 100;
    exportStore.getState().report(100, null);
    this.stop();
  },

  /**
   * Error, cancel, or teardown.
   *
   * Idempotent and safe from anywhere: `PROCESSING_FINISH` and the click
   * handler's `finally` race each other, and the Cancel button dismisses the
   * dialog before `render:v2:cancelled` arrives.
   */
  stop(): void {
    reset();
    exportStore.getState().dispatch("settled");
  },
};

/** The remaining time as `tick` would compute it, for the per-frame write. */
function readRemaining(): number | null {
  if (eta == null || countdown == null) {
    return null;
  }
  const reading = readEta(eta, performance.now());
  if (reading.kind === "finalizing" || !countdown.primed) {
    return null;
  }
  return countdownSeconds(countdown) * 1000;
}
