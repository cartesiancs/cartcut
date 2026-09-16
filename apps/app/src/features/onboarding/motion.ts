import {
  criticalDamping,
  springDurationMs,
  springEasing,
  type Spring,
} from "./spring";

/**
 * Every duration and curve the tour animates with, resolved once.
 *
 * Here rather than in the component so the springs can be chosen against the
 * card's geometry and then *checked* against it in a node suite: each one below
 * is picked for a reason that is a fact about the layout, and
 * `motion.test.ts` states those reasons as assertions.
 *
 * The component's only job is to hand these to CSS as custom properties on the
 * scrim, the way `--onboarding-fade` has always been handed over, so a
 * stylesheet and a timer can never disagree about how long something takes.
 */

/** A plain crossfade: the card's contents leaving, and the title arriving. */
export const FADE_MS = 200;

/**
 * The first screenshot rises into place from below.
 *
 * Under-damped on purpose, and travelling far enough that the overshoot is
 * worth having: a bounce is a percentage of the distance travelled, so the
 * same spring over 20px would be a wobble nobody can see.
 *
 * Rising is what gives it that room. It overshoots *upwards*, so the gap it
 * opens is at the art's bottom edge, which is under the part of the scrim that
 * has already gone fully to the card colour; the only thing above it to collide
 * with is the title, and `motion.test.ts` holds it clear of that.
 */
export const ART_RISE_SPRING: Spring = { stiffness: 240, damping: 18 };

/** How far the rise travels, in px. */
export const ART_RISE_PX = 96;

/**
 * The other two screenshots slide in from the side.
 *
 * **Critically damped, and that is a layout constraint rather than a taste.**
 * Both are cropped flush to a card edge, so there is no picture beyond it: a
 * spring that overshoots would pull the art off its own edge and open a strip
 * of bare card, in the one frame nobody would think to screenshot.
 */
export const ART_SLIDE_SPRING: Spring = {
  stiffness: 420,
  damping: criticalDamping({ stiffness: 420 }),
};

/** How far a slide travels, in px. */
export const ART_SLIDE_PX = 64;

/**
 * Next widening into Finish.
 *
 * Under-damped, so it arrives with the snap the design asks for, but only
 * just: the button is right-anchored, so its overshoot grows leftwards into
 * the card's 30px gutter, and a spring loose enough to eat the gutter reads as
 * a layout bug rather than as momentum.
 */
export const BUTTON_MORPH_SPRING: Spring = { stiffness: 300, damping: 26 };

/** The card's gutter, in px: how much room the morph has to overshoot into. */
export const CARD_GUTTER_PX = 30;

/**
 * The bottom of the title, in px from the top of the card: `.onboarding-title`
 * sits at 75 with a 38px line box. Here so the rise's overshoot can be checked
 * against the thing it would actually run into.
 */
export const TITLE_BOTTOM_PX = 75 + 38;

/** Next's width, and Finish's, in px. The morph travels between them. */
export const BUTTON_WIDTH_PX = 123;
export const WIDE_BUTTON_WIDTH_PX = 597;

const riseMs = springDurationMs(ART_RISE_SPRING);
const slideMs = springDurationMs(ART_SLIDE_SPRING);

/**
 * What the component writes onto the scrim, and the one timer it still keeps.
 *
 * `enterMs` is the longest of the entrances, not each one's own: it only has to
 * outlast whichever animation is running before the class that carries it is
 * taken off again.
 */
export const ONBOARDING_MOTION = {
  fadeMs: FADE_MS,

  riseMs,
  riseEase: springEasing(ART_RISE_SPRING),
  riseFromPx: ART_RISE_PX,

  slideMs,
  slideEase: springEasing(ART_SLIDE_SPRING),
  slideFromPx: ART_SLIDE_PX,

  morphMs: springDurationMs(BUTTON_MORPH_SPRING),
  morphEase: springEasing(BUTTON_MORPH_SPRING),

  enterMs: Math.max(riseMs, slideMs),
} as const;

/**
 * The scrim's inline style: every number above, as a custom property.
 *
 * One string so the template stays readable and so nothing can be added to the
 * table without being handed to CSS.
 */
export const onboardingMotionStyle = (): string =>
  [
    `--onboarding-fade: ${ONBOARDING_MOTION.fadeMs}ms`,
    `--onboarding-rise: ${ONBOARDING_MOTION.riseMs}ms`,
    `--onboarding-rise-ease: ${ONBOARDING_MOTION.riseEase}`,
    `--onboarding-rise-from: ${ONBOARDING_MOTION.riseFromPx}px`,
    `--onboarding-slide: ${ONBOARDING_MOTION.slideMs}ms`,
    `--onboarding-slide-ease: ${ONBOARDING_MOTION.slideEase}`,
    `--onboarding-slide-from: ${ONBOARDING_MOTION.slideFromPx}px`,
    `--onboarding-morph: ${ONBOARDING_MOTION.morphMs}ms`,
    `--onboarding-morph-ease: ${ONBOARDING_MOTION.morphEase}`,
  ].join("; ");
