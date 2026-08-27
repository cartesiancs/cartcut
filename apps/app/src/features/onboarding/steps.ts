/**
 * The four cards a first-run user pages through, transcribed from the Figma
 * frames `1090:2`, `1090:14`, `1099:111` and `1099:208`.
 *
 * Kept free of DOM and of Lit so the sequencing can be tested under
 * `environment: "node"` — the overlay component is then only markup and event
 * wiring around this table.
 */

/**
 * An illustration, sized the way it was drawn.
 *
 * The undraw source files are ~960px wide, so both dimensions are pinned here
 * rather than left to `auto`: the art has to occupy the box the designer gave
 * it, and each of the three has a different aspect ratio.
 */
export interface OnboardingArt {
  src: string;
  width: number;
  height: number;
  /** Distance from the top of the card, in px. */
  top: number;
}

export interface OnboardingStep {
  /** Locale key. Absent on the first card, which shows the wordmark instead. */
  titleKey?: string;
  subtitleKey?: string;
  art: OnboardingArt;
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
      src: `${IMAGE_DIR}/undraw_organizing-work_gmo9.svg`,
      width: 236,
      height: 208,
      top: 145,
    },
    isLast: false,
  },
  {
    titleKey: "onboarding.ai_edit_mcp",
    art: {
      src: `${IMAGE_DIR}/undraw_progress-bar_o44f.svg`,
      width: 298,
      height: 172,
      top: 146,
    },
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

/** Clamps at the first card, which offers Skip rather than Prev. */
export const prevStep = (index: number): number => Math.max(index - 1, 0);

/** The key the completion flag is stored under, via `store:set`/`store:get`. */
export const ONBOARDING_STORE_KEY = "ONBOARDING_COMPLETED";
