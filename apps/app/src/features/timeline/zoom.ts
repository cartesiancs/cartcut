/**
 * The zoom mapping, in one place.
 *
 * Three callers used to own a copy of this and disagree about it: the slider
 * (`elementTimelineRange.updateRange`) mapped its position through
 * `sigmoid(x) * 10`, its inverse re-derived `x` with a logit, and the ctrl+wheel
 * handler clamped with `next < 5 ? ... : next > -8` — comparing a *range* value
 * of 0..10 against the slider's *logit* bounds. Since range is never negative,
 * `next > -8` was always true and zooming out was effectively unclamped.
 *
 * Two things changed beyond collecting them.
 *
 * The ceiling moved. `sigmoid(x) * 10` cannot exceed 10 however far the slider
 * travels, and at range 10 one 60fps frame is 8.3px — barely enough to see a
 * frame grid, let alone edit against it. Frame-accurate work needs a frame to
 * be a comfortable target, so the ceiling is now 60, where a 60fps frame is
 * exactly 50px.
 *
 * And the curve is exponential rather than logistic. A sigmoid saturates at
 * both ends, so raising its ceiling piles the entire useful range into the last
 * few percent of slider travel. An exponential gives a constant *ratio* of
 * magnification per unit of travel, which is what every NLE's zoom control
 * does and what makes the far end usable at all.
 *
 * The floor is unchanged, deliberately: it is the exact value the old mapping
 * produced at the slider's minimum, so zooming *out* behaves exactly as before.
 */

import { DEFAULT_FPS, normalizeFps } from "./frames";

/** `sigmoid(-8) * 10` — the old mapping's floor, preserved exactly. */
export const MIN_RANGE = 10 / (1 + Math.E ** 8);

/** At 60fps this puts one frame at exactly 50px. */
export const MAX_RANGE = 60;

/**
 * How far in a project at `fps` may zoom.
 *
 * The ceiling above is a *frame* measurement wearing a millisecond's clothes:
 * 60 is not a round number, it is "the range at which one 60fps frame is 50px
 * wide". Left as a constant it silently means something different at every
 * other rate — a 120fps frame gets 25px at the same ceiling, and a 240fps one
 * 12.5px, which is below the width the frame grid is even willing to draw at.
 * So the ceiling is derived from the same statement it always encoded, and
 * `MAX_RANGE` keeps its meaning as the 60fps case of it.
 *
 * The `max(1, …)` is what keeps this from being a regression at low rates.
 * Scaling in both directions would put a 30fps project's ceiling at 30 — where
 * one frame is still 50px, so nothing about frame-accurate editing is lost, but
 * where the user can nonetheless zoom *less far in absolute time* than they
 * could yesterday. Nothing is gained by taking that away. The rule is therefore
 * "always far enough that a frame is 50px, and never less far than before".
 */
export function maxRangeForFps(fps: number): number {
  return MAX_RANGE * Math.max(1, normalizeFps(fps) / DEFAULT_FPS);
}

/**
 * Natural log of the full zoom span.
 *
 * The exponential mapping is defined by its two endpoints, and the top one now
 * moves with the project, so the span has to be recomputed rather than
 * precomputed. It is one `Math.log` on a path that already does a handful of
 * float operations per pointer move. At `DEFAULT_FPS` it produces exactly the
 * constant it replaced, so the 60fps mapping is unchanged bit for bit.
 */
function spanFor(fps: number): number {
  return Math.log(maxRangeForFps(fps) / MIN_RANGE);
}

function clamp01(t: number): number {
  if (!Number.isFinite(t)) {
    return 0;
  }
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Slider position `t` in `[0, 1]` to a zoom range. */
export function rangeFromSlider(t: number, fps: number = DEFAULT_FPS): number {
  return MIN_RANGE * Math.exp(spanFor(fps) * clamp01(t));
}

/** The inverse, for pushing a store change back into the slider. */
export function sliderFromRange(
  range: number,
  fps: number = DEFAULT_FPS,
): number {
  if (!Number.isFinite(range) || range <= 0) {
    return 0;
  }
  return clamp01(Math.log(range / MIN_RANGE) / spanFor(fps));
}

/**
 * Hold a range inside the mapping's bounds.
 *
 * A non-finite range means something upstream produced garbage; falling back to
 * the floor leaves the whole project on screen, which is a recoverable state.
 *
 * Also the place a *lowered* ceiling takes effect: switching a project from 120
 * to 30fps has to pull a range of 120 back down to 60, or the slider would sit
 * past its own end.
 */
export function clampRange(range: number, fps: number = DEFAULT_FPS): number {
  // `NaN` compares false against everything, so it has to be caught first or it
  // would fall through to the identity branch and stay `NaN`. The infinities,
  // by contrast, clamp correctly on their own — `Infinity > maxRange` is the
  // honest answer for "zoomed in further than the ceiling".
  if (Number.isNaN(range)) {
    return MIN_RANGE;
  }
  const maxRange = maxRangeForFps(fps);
  return range < MIN_RANGE ? MIN_RANGE : range > maxRange ? maxRange : range;
}
