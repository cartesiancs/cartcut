/**
 * The five cards a first-run user pages through, transcribed from the Figma
 * frames `1090:2`, `1090:14`, `1099:111`, `1338:7` and `1099:208`.
 *
 * Kept free of DOM and of Lit so the sequencing can be tested under
 * `environment: "node"` — the overlay component is then only markup and event
 * wiring around this table.
 */

/**
 * The card, at the literal pixels it is drawn at rather than scaled to the
 * window. `sass/style/_onboarding.scss` carries the same two numbers; they are
 * here so a placement below can be stated as "reaches the edge" and checked.
 */
export const ONBOARDING_CARD = { width: 657, height: 465 } as const;

/**
 * An illustration, sized and placed the way it was drawn.
 *
 * Both dimensions are pinned here rather than left to `auto`: the art has to
 * occupy the box the designer gave it, and no two of the five share an aspect
 * ratio.
 *
 * The Figma file places the three screenshots as whole app windows that run
 * off the card, and the committed `.webp`s are already cropped to the part
 * that survives. So each one is placed at the *visible* box, which reaches the
 * card's right and bottom edges, and not at the much larger window the file
 * draws. `object-fit: cover` in the stylesheet absorbs the half-pixel the two
 * aspect ratios differ by.
 */
export interface OnboardingArt {
  src: string;
  width: number;
  height: number;
  /** Distance from the top of the card, in px. */
  top: number;
  /**
   * Distance from the card's left edge, in px. Absent centres the art, which
   * is how the wordmark and the trophy are drawn; the screenshots are placed
   * off-centre and run to the card's far corner instead.
   */
  left?: number;
  /**
   * Which edge the art travels in from when its card arrives.
   *
   * Absent means it only fades up, which is what the two drawings do. The two
   * screenshots cut off at a side come in from that side, so the motion
   * continues the picture rather than contradicting it; the one drawn whole
   * rises from below instead. Leaving is always a plain fade, whatever the
   * arrival was.
   *
   * `motion.ts` holds the distances and the springs; `_onboarding.scss` has
   * one rule per direction, and `motion.test.ts` pins the two lists together.
   */
  enter?: "bottom" | "right" | "left";
}

/**
 * The gradient that sinks a screenshot into the card, so the title above it
 * and the buttons over it have something to sit on.
 *
 * It always reaches the card's bottom edge, so `top` is the only geometry it
 * needs. `fadeFrom` is a percentage of the band `top` opens, not of the card,
 * which is why the card whose art starts highest also fades earliest.
 */
export interface OnboardingScrim {
  /** Distance from the top of the card, in px. */
  top: number;
  /** Percent down the band at which the card colour starts taking over. */
  fadeFrom: number;
}

export interface OnboardingStep {
  /** Locale key. Absent on the first card, which shows the wordmark instead. */
  titleKey?: string;
  subtitleKey?: string;
  art: OnboardingArt;
  /** Absent on the two cards whose art is an illustration with nothing to sink. */
  scrim?: OnboardingScrim;
  /** The last card swaps Skip/Next for a single full-width Finish. */
  isLast: boolean;
}

/**
 * Paths are relative to `apps/app/index.html`, which is what the renderer
 * loads.
 *
 * These live under `apps/app/`, not the top-level `assets/`. That directory is
 * an `extraResources` entry, and electron-builder excludes an extraResources
 * source from the app package itself — so in a packaged build it exists only at
 * `Contents/Resources/assets`, which nothing inside the asar can reach by a
 * relative path. `apps/` is in the asar, so this resolves in dev and in a
 * packaged build alike — same reasoning as `page/splash.html`.
 */
const IMAGE_DIR = "./assets/images";

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    subtitleKey: "onboarding.welcome_subtitle",
    art: {
      src: `${IMAGE_DIR}/cartcut-wordmark.svg`,
      width: 182,
      height: 42,
      top: 170,
    },
    isLast: false,
  },
  {
    titleKey: "onboarding.free_open_source",
    art: {
      src: `${IMAGE_DIR}/onboarding-1.webp`,
      width: 517,
      height: 312,
      top: 133,
      left: 70,
      enter: "bottom",
    },
    scrim: { top: 139, fadeFrom: 29.523 },
    isLast: false,
  },
  {
    titleKey: "onboarding.utilities",
    art: {
      src: `${IMAGE_DIR}/onboarding-2.webp`,
      width: 584,
      height: 337,
      top: 128,
      left: 73,
      enter: "right",
    },
    scrim: { top: 139, fadeFrom: 14.824 },
    isLast: false,
  },
  {
    titleKey: "onboarding.ai_transcription",
    art: {
      src: `${IMAGE_DIR}/onboarding-3.webp`,
      width: 657,
      height: 359,
      top: 106,
      left: 0,
      enter: "left",
    },
    scrim: { top: 123, fadeFrom: 9.675 },
    isLast: false,
  },
  {
    titleKey: "onboarding.lets_start",
    art: {
      src: `${IMAGE_DIR}/undraw_winner_x40e.svg`,
      width: 201,
      height: 195,
      top: 144,
    },
    isLast: true,
  },
];

/**
 * Clamps at the last card. Advancing off the end is not "finish" — the last
 * card's own Finish button is, so the two cannot be confused.
 */
export const nextStep = (index: number): number =>
  Math.min(index + 1, ONBOARDING_STEPS.length - 1);
