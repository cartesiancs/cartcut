import { criticalDamping, springDurationMs, springEasing, type Spring } from "./spring";
import type { CascadeStep } from "./cascade";
import type { StylePort } from "./hoverSpring";

/**
 * How the asset browser moves between the user's folder and the cloud, and
 * how a list of tiles arrives in it.
 *
 * Into the cloud: the folder's controls and tiles fade where they stand, the
 * search field opens out of the cloud button's side, and the cloud's tiles
 * arrive down the panel as the field opens. Back out, the same three in
 * reverse: the tiles leave up the panel, the field closes into the button,
 * the folder fades back.
 *
 * One table, read by `<asset-browser>` for the steps it times itself and
 * handed to `_browse.scss` as custom properties for the field, which is a CSS
 * transition so an interrupted switch turns round from wherever it got to.
 * The same reason as `hoverSpring.ts`: a delay in the stylesheet and a timer
 * in the component that have to agree cannot drift apart if both are this.
 */

/**
 * The field opening. Critically damped, because its left edge stops at the
 * bar's padding: an overshoot would carry it past the tiles' left edge and
 * back, and a field that is briefly wider than the panel reads as a glitch.
 */
export const SEARCH_SPRING: Spring = {
  stiffness: 450,
  damping: criticalDamping({ stiffness: 450 }),
};

export const BROWSE_MOTION = {
  /** The folder's controls and list fading out, and the swap after it. */
  outMs: 140,
  /** The field starts opening this far into the fade, so the two overlap. */
  growDelayMs: 90,
  growMs: springDurationMs(SEARCH_SPRING),
  growEase: springEasing(SEARCH_SPRING),
  /** Closing into the button, accelerating, the way the opening slowed. */
  shrinkMs: 200,
  shrinkEase: "cubic-bezier(0.4, 0, 0.7, 0.2)",
  /** The folder fading back once the field has mostly closed over it. */
  inDelayMs: 120,
  inMs: 200,

  /**
   * A list arriving. Each block drops `revealTravelPx` into place as it fades
   * in; the last one on screen starts `revealSpreadMs` after the first.
   */
  revealMs: 340,
  revealSpreadMs: 240,
  revealTravelPx: 8,
  revealEase: "cubic-bezier(0.22, 1, 0.36, 1)",
  /** From the swap to the first cloud tile: the field is about a third open. */
  revealLeadMs: 80,

  /** The cloud's tiles leaving, faster than they came, bottom first. */
  hideMs: 150,
  hideSpreadMs: 110,
  hideTravelPx: 6,
  hideEase: "cubic-bezier(0.4, 0, 1, 1)",
} as const;

/** A list arriving down the panel, after `leadMs`. */
export function revealStep(reduced: boolean, leadMs = 0): CascadeStep {
  const m = BROWSE_MOTION;
  return {
    order: "down",
    // Reduced motion keeps the fade and drops the travel and the stagger.
    keyframes: reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: `translateY(-${m.revealTravelPx}px)` },
          { opacity: 1, transform: "none" },
        ],
    durationMs: reduced ? 120 : m.revealMs,
    spreadMs: reduced ? 0 : m.revealSpreadMs,
    leadMs: reduced ? 0 : leadMs,
    easing: m.revealEase,
    // Held at the first frame through the delay, or a tile waiting its turn
    // shows at full strength and then blinks out to start.
    fill: "backwards",
  };
}

/**
 * A list leaving up the panel.
 *
 * One keyframe, so each block starts from whatever it shows now: a tile still
 * arriving leaves from where its own fade had got to rather than jumping to
 * full strength first. Held at the end, since what follows removes it.
 */
export function hideStep(reduced: boolean): CascadeStep {
  const m = BROWSE_MOTION;
  return {
    order: "up",
    keyframes: reduced
      ? [{ opacity: 0 }]
      : [{ opacity: 0, transform: `translateY(-${m.hideTravelPx}px)` }],
    durationMs: reduced ? 80 : m.hideMs,
    spreadMs: reduced ? 0 : m.hideSpreadMs,
    leadMs: 0,
    easing: m.hideEase,
    fill: "forwards",
  };
}

/** What `_browse.scss` reads for the field, in the order it reads them. */
export const BROWSE_MOTION_PROPERTIES: ReadonlyArray<readonly [string, string]> = [
  ["--browse-grow", `${BROWSE_MOTION.growMs}ms`],
  ["--browse-grow-ease", BROWSE_MOTION.growEase],
  ["--browse-grow-delay", `${BROWSE_MOTION.growDelayMs}ms`],
  ["--browse-shrink", `${BROWSE_MOTION.shrinkMs}ms`],
  ["--browse-shrink-ease", BROWSE_MOTION.shrinkEase],
];

/** Hand the table to CSS, once, at the root, as `installHoverMotion` does. */
export function installBrowseMotion(port: StylePort): void {
  for (const [name, value] of BROWSE_MOTION_PROPERTIES) {
    port.setProperty(name, value);
  }
}
