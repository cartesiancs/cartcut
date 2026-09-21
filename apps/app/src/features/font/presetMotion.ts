import {
  springDurationMs,
  springEasing,
  type Spring,
} from "../onboarding/spring";

/**
 * How a text-preset tile's highlight opens under the pointer.
 *
 * The tiles used to switch a flat `background-color` on, which lands at full
 * strength on the first frame: sweeping the pointer down a grid of sixty tiles
 * strobes. The band now scales open from `PRESET_HOVER_FROM` and fades in as it
 * goes, which is the shape shadcn gives everything it opens (`zoom-in-95` with
 * `fade-in-0`), driven by a real spring rather than a bezier drawn to look like
 * one.
 *
 * The spring is sampled into a CSS `linear()` here rather than written into the
 * stylesheet by hand, for the reason `features/onboarding/motion.ts` gives at
 * length: a curve and a duration that come out of the same numbers cannot drift
 * apart. The panel hands these to CSS as custom properties on the grid, and
 * `_asset.scss` carries a fallback for a stylesheet loaded without them.
 *
 * The spring maths lives under `features/onboarding/` because the tour was the
 * first thing to need it; `spring.ts` itself is DOM-free and knows nothing
 * about the tour.
 */

/**
 * Under-damped on purpose. A hover that only eases in is a fade with a scale
 * attached, and the small pass beyond the target is the whole of what reads as
 * a spring. 271ms end to end, with the travel all but finished inside 140ms.
 */
export const PRESET_HOVER_SPRING: Spring = { stiffness: 1200, damping: 38 };

/**
 * The scale the band opens from: shadcn's `zoom-in-95`, one step deeper.
 * A tile is about 100px tall, where 5% is five pixels of travel that nobody
 * sees; 10% is an opening.
 */
export const PRESET_HOVER_FROM = 0.9;

/**
 * The fade, in ms, deliberately shorter than the spring: the colour arrives
 * while the scale is still settling, so the tile answers the pointer at once
 * and the bounce is the part that finishes late.
 */
export const PRESET_HOVER_FADE_MS = 140;

/**
 * Leaving, in ms. Flat, quick, and with no spring in it: a bounce on the way
 * out of one tile collides with the entrance of whichever tile the pointer
 * landed on next, and the two are usually neighbours.
 */
export const PRESET_HOVER_EXIT_MS = 120;

/** Every number the stylesheet needs, resolved once. */
export const PRESET_HOVER_MOTION = {
  from: PRESET_HOVER_FROM,
  enterMs: springDurationMs(PRESET_HOVER_SPRING),
  enterEase: springEasing(PRESET_HOVER_SPRING),
  fadeMs: PRESET_HOVER_FADE_MS,
  exitMs: PRESET_HOVER_EXIT_MS,
} as const;

/**
 * The grid's inline style: the table above, as custom properties.
 *
 * One string so nothing can be added to the table without being handed to CSS,
 * and so the panel's template stays a template.
 */
export const presetHoverMotionStyle = (): string =>
  [
    `--preset-hover-from: ${PRESET_HOVER_MOTION.from}`,
    `--preset-hover-enter: ${PRESET_HOVER_MOTION.enterMs}ms`,
    `--preset-hover-ease: ${PRESET_HOVER_MOTION.enterEase}`,
    `--preset-hover-fade: ${PRESET_HOVER_MOTION.fadeMs}ms`,
    `--preset-hover-exit: ${PRESET_HOVER_MOTION.exitMs}ms`,
  ].join("; ");
