import {
  criticalDamping,
  springDurationMs,
  springEasing,
  type Spring,
} from "../motion/spring";

/**
 * Every time the tutorial waits for, and every curve it animates with.
 *
 * The same arrangement as `onboarding/motion.ts`: the numbers live here, the
 * stylesheet reads them as custom properties, and the runner's clock compares
 * against the same constants, so CSS and the timers cannot disagree.
 */

/**
 * How long a finished step shows its check before the next one arrives. Long
 * enough to read "Done", short enough that nobody reaches for Next.
 */
export const DONE_FLASH_MS = 800;

/**
 * How long a *worse* target must persist before the card moves to it.
 *
 * Bootstrap fades a tab pane over 150ms, and a folder is read asynchronously,
 * so there are frames in which the thing a step points at is briefly gone.
 * Without this the card would jump to the fallback and back. A better target
 * is taken at once.
 */
export const FALLBACK_SETTLE_MS = 250;

/** One breath of the ring's pulse. */
export const PULSE_MS = 1600;

/** The check mark scaling in. Shorter than the flash it sits in. */
export const CHECK_MS = 240;

/**
 * The card arriving at a new step, travelling a few pixels towards its target.
 *
 * Critically damped: the card sits next to the thing it points at, and an
 * overshoot would carry its arrow into that thing.
 */
export const CARD_ENTER_SPRING: Spring = {
  stiffness: 380,
  damping: criticalDamping({ stiffness: 380 }),
};

/** How far the card travels as it arrives, in px. */
export const CARD_ENTER_PX = 6;

export const TUTORIAL_MOTION = {
  enterMs: springDurationMs(CARD_ENTER_SPRING),
  enterEase: springEasing(CARD_ENTER_SPRING),
  enterFromPx: CARD_ENTER_PX,
  pulseMs: PULSE_MS,
  checkMs: CHECK_MS,
} as const;

/** The component's inline style: the numbers the stylesheet needs. */
export const tutorialMotionStyle = (): string =>
  [
    `--tutorial-pulse: ${TUTORIAL_MOTION.pulseMs}ms`,
    `--tutorial-check: ${TUTORIAL_MOTION.checkMs}ms`,
  ].join("; ");
