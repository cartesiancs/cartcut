import { springDurationMs, springEasing, type Spring } from "./spring";

/**
 * How an `.asset` tile's highlight opens under the pointer.
 *
 * One table for every grid of tiles in the sidebar: text presets, utilities,
 * effects, transitions, LUTs, templates, animation presets, GIF presets and the
 * file browser. They are the same control drawn at three column widths, and a
 * panel that sprang open while the one beside it switched a fill on would read
 * as a bug in whichever of the two the user saw second.
 *
 * The tiles used to switch a flat `background-color` on, which lands at full
 * strength on the first frame: sweeping the pointer down a grid of sixty tiles
 * strobes. The band now scales open from `HOVER_FROM` and fades in as it goes,
 * which is the shape shadcn gives everything it opens (`zoom-in-95` with
 * `fade-in-0`), driven by a real spring rather than a bezier drawn to look like
 * one.
 *
 * The spring is sampled into a CSS `linear()` here rather than written into the
 * stylesheet by hand, for the reason `features/onboarding/motion.ts` gives at
 * length: a curve and a duration that come out of the same numbers cannot drift
 * apart. `index.ts` hands the table to the document root once at boot, and
 * `_asset.scss` carries a fallback for a stylesheet loaded without it.
 */

/**
 * Under-damped on purpose. A hover that only eases in is a fade with a scale
 * attached, and the small pass beyond the target is the whole of what reads as
 * a spring. 271ms end to end, with the travel all but finished inside 140ms.
 */
export const HOVER_SPRING: Spring = { stiffness: 1200, damping: 38 };

/**
 * The scale the band opens from: shadcn's `zoom-in-95`, one step deeper.
 * A tile is about 100px tall, where 5% is five pixels of travel that nobody
 * sees; 10% is an opening.
 */
export const HOVER_FROM = 0.9;

/**
 * The fade, in ms, deliberately shorter than the spring: the colour arrives
 * while the scale is still settling, so the tile answers the pointer at once
 * and the bounce is the part that finishes late.
 */
export const HOVER_FADE_MS = 140;

/**
 * Leaving, in ms. Flat, quick, and with no spring in it: a bounce on the way
 * out of one tile collides with the entrance of whichever tile the pointer
 * landed on next, and the two are usually neighbours.
 */
export const HOVER_EXIT_MS = 120;

/** Every number the stylesheet needs, resolved once. */
export const HOVER_MOTION = {
  from: HOVER_FROM,
  enterMs: springDurationMs(HOVER_SPRING),
  enterEase: springEasing(HOVER_SPRING),
  fadeMs: HOVER_FADE_MS,
  exitMs: HOVER_EXIT_MS,
} as const;

/** The table as CSS custom properties, in the order `_asset.scss` reads them. */
export const HOVER_MOTION_PROPERTIES: ReadonlyArray<readonly [string, string]> =
  [
    ["--asset-hover-from", String(HOVER_MOTION.from)],
    ["--asset-hover-enter", `${HOVER_MOTION.enterMs}ms`],
    ["--asset-hover-ease", HOVER_MOTION.enterEase],
    ["--asset-hover-fade", `${HOVER_MOTION.fadeMs}ms`],
    ["--asset-hover-exit", `${HOVER_MOTION.exitMs}ms`],
  ];

/**
 * The one DOM shape this needs, so the install is testable under `node`:
 * `document.documentElement.style`, and nothing else about a document.
 */
export type StylePort = {
  setProperty(name: string, value: string): void;
};

/**
 * Hand the table to CSS, once, at the root.
 *
 * At the root rather than on each grid: the tiles are spread across nine
 * components, three of which build their class list in a constructor, and a
 * property set per grid is a property a new grid can forget.
 */
export function installHoverMotion(port: StylePort): void {
  for (const [name, value] of HOVER_MOTION_PROPERTIES) {
    port.setProperty(name, value);
  }
}
