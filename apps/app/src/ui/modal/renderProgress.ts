import type { Timeline } from "../../@types/timeline";
import { buildCostCurve, type CostCurve } from "../../features/export/cost";
import {
  COUNTDOWN_TICK_MS,
  countdownSeconds,
  createCountdown,
  tickCountdown,
  type CountdownState,
} from "../../features/export/countdown";
import {
  createEtaState,
  finishTailMs,
  observeEta,
  readEta,
  type EtaState,
} from "../../features/export/eta";
import { formatRemaining } from "../../utils/time";

/**
 * The export progress dialog's bar and its remaining-time line.
 *
 * A module singleton rather than state on `ControlRender`, and it has to be:
 * `finishStream` closes FFmpeg's stdin and returns without waiting, so
 * `requestIPCVideoExport` resolves while FFmpeg is still muxing and the click
 * handler's `finally` runs during the tail. The finalizing phase therefore
 * outlives the function that started the export, and only `PROCESSING_FINISH`
 * in `event.ts` can end it. Shaped after `utils/modal.ts#rendererModal`, which
 * is the existing precedent for one imperative object that both `event.ts` and
 * a component drive.
 *
 * Its strings are hardcoded English, like the rest of this dialog
 * (`"Rendering..."`, `"Cancel"`) — `LocaleController` needs a Lit host and this
 * is not a component.
 */
type Phase = "idle" | "running" | "finalizing";

const ESTIMATING_LABEL = "Estimating…";
const FINALIZING_LABEL = "Finalizing…";

/**
 * The eye cannot read faster than this, and each write invalidates layout on a
 * thread that is also drawing frames.
 */
const BAR_PAINT_MS = 100;

let phase: Phase = "idle";
let timer: number | null = null;
let curve: CostCurve | null = null;
let eta: EtaState | null = null;
let countdown: CountdownState | null = null;
let lastBarPaintAt = 0;
let lastBarText = "";
let lastRemainingText = "";

function progressBar(): HTMLElement | null {
  return document.querySelector("#progress");
}

function remainingLine(): HTMLElement | null {
  return document.querySelector("#remainingTime");
}

function paintBar(percent: number): void {
  const bar = progressBar();
  if (bar == null) {
    return;
  }
  const clamped = Math.max(0, Math.min(100, percent));
  const text = `${Math.round(clamped)}%`;
  bar.style.width = `${clamped}%`;
  bar.setAttribute("aria-valuenow", String(Math.round(clamped)));
  // `#progress`'s text is scraped by the e2e harness and parsed as a number, and
  // a parse failure there does not reset its stall timer — so this element
  // carries a percentage and nothing else. Every other state goes to
  // `#remainingTime`.
  if (text !== lastBarText) {
    bar.textContent = text;
    lastBarText = text;
  }
}

function paintRemaining(text: string): void {
  if (text === lastRemainingText) {
    return;
  }
  const line = remainingLine();
  if (line == null) {
    return;
  }
  line.textContent = text;
  lastRemainingText = text;
}

/** The interval body. Owns `#remainingTime`; never touches the bar. */
function tick(): void {
  if (phase !== "running" || eta == null || countdown == null) {
    return;
  }

  const now = performance.now();
  const reading = readEta(eta, now);
  const estimate = reading.kind === "remaining" ? reading.ms : null;
  countdown = tickCountdown(countdown, estimate, now);

  if (reading.kind === "finalizing") {
    paintRemaining(FINALIZING_LABEL);
    return;
  }
  if (!countdown.primed) {
    paintRemaining(ESTIMATING_LABEL);
    return;
  }
  paintRemaining(`${formatRemaining(countdownSeconds(countdown) * 1000)} left`);
}

function clearTimer(): void {
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
}

export const renderProgress = {
  /**
   * Reset the dialog and start estimating.
   *
   * Stops anything already running first, which is also what clears the
   * previous export's numbers — `#remainingTime` used to keep the last run's
   * value on screen until the first sample of the next one landed, and the bar
   * was authored at a hardcoded 25%.
   */
  begin(timeline: Timeline, totalFrames: number, fps: number): void {
    this.stop();

    curve = buildCostCurve(timeline, totalFrames, fps);
    eta = createEtaState({
      totalUnits: curve.total,
      tailMs: finishTailMs(totalFrames),
    });
    countdown = createCountdown(performance.now());
    lastBarPaintAt = 0;
    lastBarText = "";
    lastRemainingText = "";
    phase = "running";

    paintBar(0);
    paintRemaining(ESTIMATING_LABEL);

    timer = window.setInterval(tick, COUNTDOWN_TICK_MS);
  },

  /**
   * One frame has been drawn, captured, and handed to the pipe.
   *
   * On the hot path. The estimate is folded in on **every** frame — about ten
   * flops and one object literal, against a frame that costs milliseconds — and
   * only the bar's DOM writes are throttled. Separating the two is the point:
   * the old code sampled and painted together, so the estimator saw a tenth of
   * the data it could have.
   *
   * `currentFrame` is 0-based and names the frame just finished, so the count
   * done is one more than it. Without the `+ 1` the bar tops out at
   * `(N-1)/N` and never reaches 100%.
   */
  onFrame(currentFrame: number, totalFrames: number): void {
    if (phase !== "running" || eta == null || curve == null) {
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
    paintBar(curve.total > 0 ? (units / curve.total) * 100 : 0);
  },

  /**
   * The frame loop is done and FFmpeg is flushing.
   *
   * Nothing is animating any more, so the ticker is pure cost — the label is
   * static until the main process reports the file is written.
   */
  finalizing(): void {
    if (phase === "idle") {
      return;
    }
    phase = "finalizing";
    clearTimer();
    paintBar(100);
    paintRemaining(FINALIZING_LABEL);
  },

  /** `PROCESSING_FINISH`. */
  finish(): void {
    paintBar(100);
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
    clearTimer();
    phase = "idle";
    curve = null;
    eta = null;
    countdown = null;
  },
};
