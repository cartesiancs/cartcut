/**
 * The frame as the atomic unit of editing.
 *
 * Before this module the timeline's finest unit was the millisecond:
 * `applyDrag` rounded a pixel delta to an integer ms and a clip could sit
 * anywhere. The exporter, meanwhile, samples the timeline at exactly
 * `currentFrame / fps * 1000` (`features/export/renderTimeline.ts`), so an edit
 * and its render disagreed by construction — at 60fps a frame is 16.666…ms, a
 * number no integer millisecond can name.
 *
 * Hence the one invariant everything here exists to serve:
 *
 *   every timeline instant an edit produces is exactly `n * 1000 / fps`
 *   for some integer `n`.
 *
 * The way to keep it is to never accumulate. `frameToMs` recomputes from an
 * integer index every time, so a thousand steps forward lands on the same
 * double as one jump of a thousand — which repeated addition does not:
 * adding `1000/60` sixty times gives 999.9999999999991, not 1000. That is the
 * bug behind the arrow keys, and it is why frame arithmetic goes through a
 * frame *index* rather than a millisecond *step*.
 *
 * Pure and DOM-free, and fps arrives as an argument rather than being read from
 * a store — the same shape as `geometry.ts` and `snapping.ts`, so this runs
 * under `environment: "node"`.
 */

import { msToPxSigned, pxToMsSigned } from "./geometry";

/** Used when a project carries no usable frame rate. */
export const DEFAULT_FPS = 60;

/**
 * Slack for `floor`/`ceil` at a frame boundary.
 *
 * `ms * fps / 1000` does not land exactly on the integer it mathematically is:
 * over the first 100,000 frames at 60fps, a bare `Math.floor` returns `n - 1`
 * for 2,793 of them. The absolute error is under 1e-11 there, so a 1e-6
 * tolerance absorbs it with vast margin while only mis-rounding instants within
 * 17 nanoseconds of a boundary — nothing an edit can express.
 *
 * `Math.round` needs none of this: the same sweep produces zero failures,
 * because half a frame is an enormous distance next to 1e-11.
 */
const FRAME_EPSILON = 1e-6;

/** Narrowest a frame may be drawn before the grid appears, in px. */
export const GRID_SHOW_PX = 7;
/**
 * ...and how narrow it must get before the grid goes away again.
 *
 * Two thresholds rather than one: with a single value the grid strobes on and
 * off while the zoom slider is dragged across it.
 */
export const GRID_HIDE_PX = 5;

/**
 * A backstop for `planFrameGrid`.
 *
 * The caller is expected to gate on `shouldShowFrameGrid`, but the planner is
 * public and a mis-set zoom should degrade to "no grid" rather than to a
 * million-element array.
 */
const MAX_GRID_LINES = 4096;

/**
 * A usable frame rate, whatever was passed in.
 *
 * `null` and `undefined` are in the signature on purpose: the callers are
 * reading an optional field off a store or a draw option, and making each of
 * them guard separately is how one of them ends up not doing it.
 */
export function normalizeFps(fps: number | null | undefined): number {
  return typeof fps === "number" && Number.isFinite(fps) && fps > 0
    ? fps
    : DEFAULT_FPS;
}

/**
 * Collapse `-0` to `0`.
 *
 * `Math.ceil(-1e-6)`, `Math.round(-0.2)` and `(-0 / fps) * 1000` all produce
 * negative zero, which compares equal to zero under `===` and *not* under
 * `Object.is`. Left alone it escapes into frame indices and pixel coordinates,
 * where it is invisible right up until something serialises it as `-0` or an
 * assertion fails for a reason that has nothing to do with the code under test.
 * Frame zero is frame zero.
 */
function noNegativeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** How long one frame lasts, in ms. Irrational-looking at 60fps, and exact. */
export function frameDurationMs(fps: number): number {
  return 1000 / normalizeFps(fps);
}

/** The frame `ms` falls nearest to. */
export function msToFrame(ms: number, fps: number): number {
  return noNegativeZero(Math.round((ms * normalizeFps(fps)) / 1000));
}

/** The last frame at or before `ms`. */
export function msToFrameFloor(ms: number, fps: number): number {
  return noNegativeZero(Math.floor((ms * normalizeFps(fps)) / 1000 + FRAME_EPSILON));
}

/** The first frame at or after `ms`. */
export function msToFrameCeil(ms: number, fps: number): number {
  return noNegativeZero(Math.ceil((ms * normalizeFps(fps)) / 1000 - FRAME_EPSILON));
}

/**
 * Where frame `frame` begins, in timeline ms.
 *
 * Always computed from the index, and — deliberately — computed with the *same
 * expression* the exporter uses:
 *
 *     features/export/renderTimeline.ts:47
 *     const timeInMs = (currentFrame / fps) * 1000;
 *
 * `(k / fps) * 1000` and `(k * 1000) / fps` are equal in arithmetic and not in
 * IEEE-754: over the first 200,000 frames at 60fps they disagree on 54,901 of
 * them, by up to 4.7e-10 ms. That is minuscule and it is still enough to put a
 * clip's start one ULP above the instant the exporter samples, at which point
 * `t >= start` is false and the clip loses its own first frame.
 *
 * Matching the expression makes the two bit-identical by construction, which is
 * a stronger guarantee than any tolerance. Mirror any change to `renderTimeline`
 * here.
 */
export function frameToMs(frame: number, fps: number): number {
  return noNegativeZero((frame / normalizeFps(fps)) * 1000);
}

/**
 * Whether `ms` sits on a frame boundary.
 *
 * Tolerant, because a quantized time reaches the document as
 * `startTime + (target - startTime)` and IEEE-754 does not promise that equals
 * `target` — it misses by up to ~4e-11 ms. Tests assert alignment through this
 * rather than with `toBe`.
 */
export function isFrameAligned(
  ms: number,
  fps: number,
  toleranceMs = 1e-6,
): boolean {
  return Math.abs(ms - snapMsToFrame(ms, fps)) <= toleranceMs;
}

/**
 * Move a playhead by whole frames.
 *
 * Recovers the frame index, adds an integer, and re-derives the time — so a
 * thousand presses land exactly where one jump of a thousand would. Replaces
 * `increaseCursor(1000 / 60)`, which accumulated: adding `1000/60` sixty times
 * gives 999.9999999999991.
 *
 * A cursor that was off-grid is pulled onto it by the first press, which is what
 * every NLE does.
 */
export function stepCursorByFrames(
  ms: number,
  deltaFrames: number,
  fps: number,
): number {
  return Math.max(0, frameToMs(msToFrame(ms, fps) + deltaFrames, fps));
}

/**
 * `ms` moved to the nearest frame boundary.
 *
 * An already-aligned input comes back bit-identical, which the drag code relies
 * on: a gesture that moves nothing must produce a delta of exactly zero so
 * `withCheckpoint` records no undo step.
 */
export function snapMsToFrame(ms: number, fps: number): number {
  return frameToMs(msToFrame(ms, fps), fps);
}

/**
 * The instant to address a *decoder* at, to get the frame covering `ms`.
 *
 * Not the same question as "what time is this frame", which is `frameToMs`.
 * This one is about picking a discrete source frame through a continuous,
 * lossily-quantised parameter, and the two answers differ by half a frame.
 *
 * A professional NLE never faces this: it converts a timeline frame index to a
 * *source frame index* with integer or rational arithmetic, and addresses the
 * decoder by presentation timestamp in the stream's own timebase, compared
 * exactly. No float seconds are involved anywhere, so there is no tie to lose.
 *
 * An HTML `<video>` gives us no such handle. The only address is
 * `currentTime`, a double in seconds, and the frame it selects is the one whose
 * presentation interval `[pts, pts + duration)` contains that value. Asking for
 * exactly `pts` is therefore a boundary case — and Chromium stores the
 * assignment as whole **microseconds**, so whenever `1e6 / fps` is not an
 * integer the request lands one microsecond *below* the boundary and the
 * decoder correctly returns the previous frame. Measured against this app:
 * requesting `0.0666667` read back as `0.066666`, and the composited frame
 * carried source index 1 where 2 was wanted. At 30fps that spoiled a third of
 * every export; at 60fps, two thirds.
 *
 * Sampling at the frame's **centre** removes the tie. It is the same convention
 * as sampling a texel at its centre rather than its corner, and it is what the
 * comparable seek in the E2E suite does for the same reason
 * (`tests/e2e/harness/decode.ts` seeks to `(N - 0.25) / fps`). The margin it
 * buys is half a frame — 8,333 microseconds at 60fps against a 1 microsecond
 * quantisation, a factor of over eight thousand — so no rounding this side of a
 * rewrite can push the request into a neighbouring frame.
 *
 * Snapping to the covering frame first, rather than simply adding half a frame
 * to whatever came in, is what makes this exact for an off-grid `ms` too: the
 * centre wanted is the centre of the frame that *contains* `ms`, which is only
 * `ms + half` when `ms` already sits on a boundary.
 *
 * The real fix is to stop addressing frames by float seconds at all — WebCodecs
 * `VideoDecoder` takes an integer timestamp — but that is a rewrite of the
 * media layer, and this is correct in the meantime rather than merely adequate.
 */
export function frameSampleMs(ms: number, fps: number): number {
  const rate = normalizeFps(fps);
  return frameToMs(msToFrameFloor(ms, rate), rate) + frameDurationMs(rate) / 2;
}

/** How wide one frame is on screen at this zoom, in px. */
export function framePx(range: number, fps: number): number {
  return msToPxSigned(frameDurationMs(fps), range);
}

/**
 * Whether to draw the frame grid.
 *
 * `wasShowing` carries the hysteresis without making this stateful — the
 * component holds the last answer and hands it back, so the decision stays a
 * pure function of three numbers and can be tested as one.
 */
export function shouldShowFrameGrid(
  range: number,
  fps: number,
  wasShowing: boolean,
): boolean {
  const width = framePx(range, fps);
  if (width >= GRID_SHOW_PX) {
    return true;
  }
  if (width < GRID_HIDE_PX) {
    return false;
  }
  return wasShowing;
}

export type FrameGridInput = {
  range: number;
  hScroll: number;
  /** Left edge of the band to fill, in canvas px. */
  x0: number;
  /** Right edge, exclusive. */
  x1: number;
  fps: number;
};

/**
 * The x of every frame boundary inside `[x0, x1]`.
 *
 * Aligned to the **global** timeline grid (`t = n / fps`), never to the clip
 * being drawn. That is what makes the lines continue across a cut instead of
 * restarting at each clip's left edge — the difference between a grid and a
 * set of stripes. It is also the honest one: what the renderer samples is
 * timeline frames, so a clip with `speed !== 1` still cuts on these boundaries
 * and not on its own source frames.
 *
 * Returned x values are rounded to whole pixels. At seven pixels apart,
 * hairlines left on fractional coordinates antialias into a grey wash and
 * moiré against the filmstrip behind them.
 */
export function planFrameGrid(input: FrameGridInput): number[] {
  const { range, hScroll, x0, x1, fps } = input;

  const width = framePx(range, fps);
  if (!(width > 0) || x1 <= x0) {
    return [];
  }
  if ((x1 - x0) / width > MAX_GRID_LINES) {
    return [];
  }

  const first = msToFrameCeil(pxToMsSigned(x0 + hScroll, range), fps);
  const last = msToFrameFloor(pxToMsSigned(x1 + hScroll, range), fps);

  const xs: number[] = [];
  for (let frame = first; frame <= last; frame++) {
    xs.push(
      noNegativeZero(
        Math.round(msToPxSigned(frameToMs(frame, fps), range) - hScroll),
      ),
    );
  }
  return xs;
}
