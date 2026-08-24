/**
 * Where the ruler's ticks go, and what they say.
 *
 * The ruler was the last part of the timeline still computing its own geometry,
 * and its ladder of scales stopped at one rung from the bottom: the smallest
 * tick it could draw was 100ms and the smallest label one second. That was
 * enough while the zoom ceiling was ~9.93, where a second is 497px. With the
 * ceiling raised for frame editing a second is 3,000px, and a 400px viewport
 * shows one labelled tick — often none. The ruler stops telling the time
 * exactly when the user has zoomed in to look at it closely.
 *
 * So the ladder now runs down through frames. Below a second the rungs are
 * frame counts rather than round milliseconds, because at that scale the
 * meaningful unit is the frame — a tick at 100ms falls between frames at 60fps
 * and lands on nothing the picture can show.
 *
 * One thing that did *not* need fixing, despite appearances: the old ruler's
 * `× 1.1111111111` looks like a fudge factor pasted next to `18`, and it is
 * exactly `10/9`, which turns that 18 into the 20 that `msToPxSigned` uses.
 * `term` and `msToPxSigned(100, range)` agree at every zoom. Ruler and clips
 * were never misaligned; the ladder was just too short.
 */

import { msToPxSigned } from "./geometry";
import { frameDurationMs, normalizeFps } from "./frames";

/** Narrowest a minor tick may be before the ladder steps up a rung. */
export const MIN_TICK_PX = 8;
/** Narrowest a *labelled* tick may be, so timecodes never collide. */
export const MIN_LABEL_PX = 64;

/** Frame counts worth ruling at, below one second. */
const FRAME_RUNGS = [1, 2, 5, 10, 15, 30];
/** Seconds, then minutes, then hours. */
const SECOND_RUNGS = [1, 2, 5, 10, 15, 30];
const MINUTE_RUNGS = [1, 2, 5, 10, 15, 30];
const HOUR_RUNGS = [1, 2, 4, 8, 12, 24];
/** How many minor ticks a label may span. */
const LABEL_GROUPS = [1, 2, 5, 10];

export type RulerTick = {
  /** Canvas x, already scrolled. */
  x: number;
  ms: number;
  /** Labelled ticks are drawn taller. */
  major: boolean;
  /** Present only on major ticks. */
  label?: string;
};

export type RulerPlan = {
  ticks: RulerTick[];
  /** Spacing between minor ticks, in ms. */
  stepMs: number;
  /** Minor ticks per labelled tick. */
  majorEvery: number;
};

/**
 * Every spacing the ruler may use, ascending.
 *
 * Frame rungs that reach a second are dropped rather than kept: at 24fps
 * thirty frames is 1,250ms, which would sort above the one-second rung and make
 * the ladder non-monotonic — the selector would then pick a *coarser* tick as
 * the user zoomed in.
 */
export function tickLadder(fps: number): number[] {
  const frame = frameDurationMs(normalizeFps(fps));
  const rungs: number[] = [];

  for (const count of FRAME_RUNGS) {
    const ms = frame * count;
    if (ms < 1000) {
      rungs.push(ms);
    }
  }
  for (const count of SECOND_RUNGS) {
    rungs.push(count * 1000);
  }
  for (const count of MINUTE_RUNGS) {
    rungs.push(count * 60_000);
  }
  for (const count of HOUR_RUNGS) {
    rungs.push(count * 3_600_000);
  }

  return rungs;
}

/** The finest spacing whose ticks are still far enough apart to read. */
export function chooseStepMs(range: number, fps: number): number {
  const rungs = tickLadder(fps);
  for (const ms of rungs) {
    if (msToPxSigned(ms, range) >= MIN_TICK_PX) {
      return ms;
    }
  }
  return rungs[rungs.length - 1];
}

/** How many minor ticks one label should cover. */
export function chooseMajorEvery(stepMs: number, range: number): number {
  const stepPx = msToPxSigned(stepMs, range);
  for (const group of LABEL_GROUPS) {
    if (stepPx * group >= MIN_LABEL_PX) {
      return group;
    }
  }
  return LABEL_GROUPS[LABEL_GROUPS.length - 1];
}

/**
 * What to write on a labelled tick.
 *
 * Below a second the frame is named, because that is the unit being ruled and
 * "2s" repeated six times across a second says nothing. Above it the existing
 * shapes are kept — `3s`, `1m 5s`, `5m`, `1h 05m` — so the ruler reads the same
 * at the zooms it already worked at.
 */
export function formatTickLabel(
  ms: number,
  stepMs: number,
  fps: number,
): string {
  const rate = normalizeFps(fps);

  if (stepMs < 1000) {
    const totalFrames = Math.round((ms / 1000) * rate);
    const seconds = Math.floor(totalFrames / rate);
    const frames = totalFrames - seconds * rate;
    const minutes = Math.floor(seconds / 60);
    const restSeconds = seconds - minutes * 60;
    const head =
      minutes > 0 ? `${minutes}m ${restSeconds}s` : `${restSeconds}s`;
    return frames === 0 ? head : `${head} ${frames}f`;
  }

  const totalSeconds = Math.round(ms / 1000);

  if (stepMs < 60_000) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds - minutes * 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  const totalMinutes = Math.round(totalSeconds / 60);

  if (stepMs < 3_600_000) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes - hours * 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

export type RulerInput = {
  range: number;
  hScroll: number;
  /** Visible width of the ruler, in px. */
  width: number;
  fps: number;
};

export function planRulerTicks(input: RulerInput): RulerPlan {
  const { range, hScroll, width, fps } = input;

  const stepMs = chooseStepMs(range, fps);
  const majorEvery = chooseMajorEvery(stepMs, range);
  const stepPx = msToPxSigned(stepMs, range);

  if (!(stepPx > 0) || !(width > 0)) {
    return { ticks: [], stepMs, majorEvery };
  }

  // Only the ticks on screen. The old loop counted from zero every time and
  // relied on `count % range` to thin them out, which meant a timeline scrolled
  // an hour in still walked every tick from the beginning.
  const first = Math.max(0, Math.floor(hScroll / stepPx));
  const last = Math.ceil((hScroll + width) / stepPx);

  const ticks: RulerTick[] = [];
  for (let index = first; index <= last; index++) {
    const ms = index * stepMs;
    const major = index % majorEvery === 0;
    ticks.push({
      x: msToPxSigned(ms, range) - hScroll,
      ms,
      major,
      ...(major ? { label: formatTickLabel(ms, stepMs, fps) } : {}),
    });
  }

  return { ticks, stepMs, majorEvery };
}
