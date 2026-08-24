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

/** `sigmoid(-8) * 10` — the old mapping's floor, preserved exactly. */
export const MIN_RANGE = 10 / (1 + Math.E ** 8);

/** At 60fps this puts one frame at exactly 50px. */
export const MAX_RANGE = 60;

/** Natural log of the full zoom span, precomputed for both directions. */
const SPAN = Math.log(MAX_RANGE / MIN_RANGE);

function clamp01(t: number): number {
  if (!Number.isFinite(t)) {
    return 0;
  }
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Slider position `t` in `[0, 1]` to a zoom range. */
export function rangeFromSlider(t: number): number {
  return MIN_RANGE * Math.exp(SPAN * clamp01(t));
}

/** The inverse, for pushing a store change back into the slider. */
export function sliderFromRange(range: number): number {
  if (!Number.isFinite(range) || range <= 0) {
    return 0;
  }
  return clamp01(Math.log(range / MIN_RANGE) / SPAN);
}

/**
 * Hold a range inside the mapping's bounds.
 *
 * A non-finite range means something upstream produced garbage; falling back to
 * the floor leaves the whole project on screen, which is a recoverable state.
 */
export function clampRange(range: number): number {
  // `NaN` compares false against everything, so it has to be caught first or it
  // would fall through to the identity branch and stay `NaN`. The infinities,
  // by contrast, clamp correctly on their own — `Infinity > MAX_RANGE` is the
  // honest answer for "zoomed in further than the ceiling".
  if (Number.isNaN(range)) {
    return MIN_RANGE;
  }
  return range < MIN_RANGE ? MIN_RANGE : range > MAX_RANGE ? MAX_RANGE : range;
}
