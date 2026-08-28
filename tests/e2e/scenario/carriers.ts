/**
 * The two independent answers to "which frame is this?".
 *
 * Re-exported from the fixture generator's own `geometry.mjs` so the scenario
 * that *places* the carriers and the generator that *builds* them cannot
 * disagree — the same constants, loaded once.
 *
 * `.mjs` is loaded through `createRequire` rather than imported: Playwright
 * transpiles these TypeScript files to CommonJS, and a static `import` of an
 * ESM module from CJS fails at runtime. The fixture scripts have to stay real
 * ESM because node runs them directly.
 */

import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(__filename);

// `geometry.mjs` is data and pure functions only, so reading it as text and
// evaluating the few constants would work — but requiring it keeps one
// definition rather than two. Node resolves `.mjs` through `require` from
// Node 22 onward; the fallback keeps this working on older runtimes.
let geometry: any;
try {
  geometry = require_("../fixtures/geometry.mjs");
} catch {
  geometry = null;
}

/** Frames in one sawtooth cycle of the animation carrier. */
export const ANIM_CARRIER_PERIOD: number = geometry?.ANIM_CARRIER_PERIOD ?? 120;

/** Pixels the animation carrier travels per frame. */
export const ANIM_CARRIER_STEP_PX: number = geometry?.ANIM_CARRIER_STEP_PX ?? 8;

/** How far the ticker pattern travels per frame, in project pixels. */
export const TICKER_SHIFT_PX: number = geometry?.TICKER_SHIFT_PX ?? 32;

/** Seconds between an A/V sync click and its matching flash. */
export const SYNC_PERIOD_SEC = 2;

/**
 * The eight canary colours, in authored (full-range sRGB) values.
 *
 * Primaries and secondaries at full saturation are where a wrong YUV matrix
 * shows up hardest — a bt709 decode of a bt601 encode moves pure green by 42
 * codes while leaving grey untouched — and the two neutrals pin the range
 * conversion, which moves white by 19 and leaves the primaries comparatively
 * alone. Between them the two failure modes are separable.
 */
export const SWATCH_COLORS: ReadonlyArray<{ name: string; rgb: [number, number, number] }> =
  geometry?.SWATCH_COLORS ?? [
    { name: "red", rgb: [255, 0, 0] },
    { name: "green", rgb: [0, 255, 0] },
    { name: "blue", rgb: [0, 0, 255] },
    { name: "cyan", rgb: [0, 255, 255] },
    { name: "magenta", rgb: [255, 0, 255] },
    { name: "yellow", rgb: [255, 255, 0] },
    { name: "grey50", rgb: [128, 128, 128] },
    { name: "white", rgb: [255, 255, 255] },
  ];

export const GEOMETRY_PATH = path.join(__dirname, "..", "fixtures", "geometry.mjs");
