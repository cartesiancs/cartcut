/**
 * What each colour adjustment is: its group, its range, and what its number
 * means physically.
 *
 * One table, read by the resolver (`renderer/adjust.ts`), the pixel maths
 * (`tone.ts`, `finishMath.ts`), the panel and the agent command. Nothing else
 * states a range or a scale, so a slider that moves further than the maths
 * expects is unrepresentable rather than merely unlikely.
 *
 * ## Two kinds of control, and they are applied in different places
 *
 * - **Tone** — the colour and lightness groups. Every one of them is a pure
 *   function of the pixel's own colour, so the ten of them together are baked
 *   into one 3D LUT (`bake.ts`) and applied through the existing clip-LUT
 *   applier. That inherits a shader that is already pinned to ffmpeg's `lut3d`.
 * - **Finish** — the effects group. Sharpen, clarity and particles need a
 *   pixel's neighbours or its position, vignette needs its position within the
 *   clip, and fade must come *after* a LUT to keep its matte blacks. They run in
 *   their own pass (`renderer/adjust/`), after the clip's LUT.
 *
 * DOM-free and store-free, so the node suites and the renderer can both load it.
 */

import {
  COLOR_ADJUSTMENT_KEYS,
  type ColorAdjustmentKey,
} from "../../@types/timeline";

export type AdjustGroup = "color" | "lightness" | "effects";

/** The panel's three sections, in order. */
export const ADJUST_GROUPS: readonly AdjustGroup[] = [
  "color",
  "lightness",
  "effects",
];

export type AdjustmentSpec = {
  group: AdjustGroup;
  /** Slider range, in the stored units. Zero is always inside it and is neutral. */
  min: number;
  max: number;
  /** English label, and the fallback when a locale has no entry. */
  label: string;
};

const BIPOLAR = { min: -100, max: 100 } as const;
const UNIPOLAR = { min: 0, max: 100 } as const;

/**
 * Every adjustment, keyed by its stored name.
 *
 * Bipolar controls run −100..100, as Lightroom's do. The effects that have no
 * meaningful negative — you cannot un-sharpen with a sharpen slider — run
 * 0..100. Vignette is the exception in that group: negative lightens the edges,
 * which is what both CapCut and Lumetri offer.
 */
export const ADJUSTMENTS: Readonly<Record<ColorAdjustmentKey, AdjustmentSpec>> =
  {
    temperature: { group: "color", ...BIPOLAR, label: "Temperature" },
    tint: { group: "color", ...BIPOLAR, label: "Tint" },
    saturation: { group: "color", ...BIPOLAR, label: "Saturation" },
    exposure: { group: "lightness", ...BIPOLAR, label: "Exposure" },
    contrast: { group: "lightness", ...BIPOLAR, label: "Contrast" },
    highlights: { group: "lightness", ...BIPOLAR, label: "Highlights" },
    shadows: { group: "lightness", ...BIPOLAR, label: "Shadows" },
    whites: { group: "lightness", ...BIPOLAR, label: "Whites" },
    blacks: { group: "lightness", ...BIPOLAR, label: "Blacks" },
    brilliance: { group: "lightness", ...BIPOLAR, label: "Brilliance" },
    sharpen: { group: "effects", ...UNIPOLAR, label: "Sharpen" },
    clarity: { group: "effects", ...UNIPOLAR, label: "Clarity" },
    particles: { group: "effects", ...UNIPOLAR, label: "Particles" },
    fade: { group: "effects", ...UNIPOLAR, label: "Fade" },
    vignette: { group: "effects", ...BIPOLAR, label: "Vignette" },
  };

/** The keys of one group, in panel order. */
export function keysOfGroup(group: AdjustGroup): ColorAdjustmentKey[] {
  return COLOR_ADJUSTMENT_KEYS.filter((key) => ADJUSTMENTS[key].group === group);
}

/** Baked into the tone LUT. */
export const TONE_KEYS: readonly ColorAdjustmentKey[] = COLOR_ADJUSTMENT_KEYS.filter(
  (key) => ADJUSTMENTS[key].group !== "effects",
);

/** Applied by the finish pass. */
export const FINISH_KEYS: readonly ColorAdjustmentKey[] = keysOfGroup("effects");

/** The locale key for an adjustment's label: `adjust.<key>`. */
export function labelKeyOf(key: ColorAdjustmentKey): string {
  return `adjust.${key}`;
}

/** The locale key for a group's heading: `adjust.group_<group>`. */
export function groupLabelKeyOf(group: AdjustGroup): string {
  return `adjust.group_${group}`;
}

// --------------------------------------------------------- physical scales
//
// What 100 on a slider means. Each is the value at full travel; the maths
// scales linearly from zero. Kept together so a "this is too strong" tweak is
// one number, and so the tests can state their expectations in these terms
// rather than in restated magic numbers.

/** Stops of exposure at ±100. Lumetri offers ±4; a video clip rarely wants more than two. */
export const EXPOSURE_STOPS = 2;

/** The white-balance argument at ±100. */
export const WHITE_BALANCE_SCALE = 1;

/**
 * Channel gains per unit of temperature and of tint, in light.
 *
 * The same coefficients `lut/colorMath.ts#temperature` and `#tint` use, so a
 * warm LUT recipe and a warm slider lean the same way. Restated rather than
 * called, because those two run through the piecewise sRGB curve and these
 * run through `DISPLAY_GAMMA` — see there.
 */
export const TEMPERATURE_GAINS = [0.34, 0.02, -0.3] as const;
export const TINT_GAINS = [0.13, -0.2, 0.13] as const;

/**
 * The transfer function light-domain adjustments are applied through: a pure
 * 2.2 power, the usual stand-in for sRGB.
 *
 * Not the piecewise sRGB curve, and the reason is measured. Under a pure power
 * law a gain in light is a gain in the coded signal — `x · g^(1/2.2)` — so
 * white balance and exposure together are one per-channel multiplication,
 * which a LUT reproduces *exactly* at any size. Through piecewise sRGB, +2 EV
 * bends the toe so sharply inside the first cube cell that a 33³ table was 2.7
 * 8-bit steps out near black, and still 1.8 at 65³ in combination with warm
 * white balance — a table size whose bake would stutter a slider drag. The two
 * curves differ only below about 4% signal.
 */
export const DISPLAY_GAMMA = 2.2;

/** The `colorMath.filmS` strength at +100. */
export const CONTRAST_S_STRENGTH = 0.75;

/** How far −100 contrast pulls toward mid grey: 0.5 halves every distance from it. */
export const CONTRAST_FLATTEN = 0.5;

/** Mid grey, the fixed point of the contrast control. */
export const CONTRAST_PIVOT = 0.5;

/** Saturation multiplier is `1 + v/100 * SATURATION_SCALE`: −100 is monochrome. */
export const SATURATION_SCALE = 1;

/**
 * The tone curve's control points, and how far each slider moves each one at
 * ±100 (as a fraction of full scale).
 *
 * Highlights and shadows pull their own region hardest and their neighbours a
 * little; whites and blacks move only the ends. That falloff is what makes the
 * four controls independent enough to be worth having as four.
 */
export const TONE_CURVE_X = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1] as const;

export const TONE_CURVE_WEIGHTS: Readonly<
  Record<
    "blacks" | "shadows" | "highlights" | "whites" | "brilliance",
    readonly number[]
  >
> = {
  //            0      0.1    0.25   0.5    0.75   0.9    1
  blacks: [0.08, 0.05, 0.01, 0, 0, 0, 0],
  shadows: [0, 0.05, 0.12, 0.03, 0, 0, 0],
  highlights: [0, 0, 0, 0.03, 0.12, 0.05, 0],
  whites: [0, 0, 0, 0, 0, 0.05, 0.08],
  // Brighten the dark half, pull the bright half in: Apple's description of
  // Brilliance, and CapCut's. Negative does the opposite.
  brilliance: [0, 0.03, 0.08, 0.02, -0.06, -0.03, 0],
};

/**
 * The smallest rise allowed between neighbouring control points.
 *
 * Extreme combinations — blacks lifted, shadows crushed — would otherwise put a
 * later point below an earlier one, and a falling tone curve is an inversion
 * the user sees as solarisation. Forcing a rise makes that unrepresentable.
 */
export const TONE_CURVE_MIN_RISE = 0.01;

/** The vibrance brilliance adds alongside its curve, at ±100. */
export const BRILLIANCE_VIBRANCE = 0.15;

// Finish.

/** `amount` of the unsharp mask at 100. The Sharpen effect preset tops out at 4. */
export const SHARPEN_STRENGTH = 1.6;

/** The unsharp mask's tap spacing, in the clip's own pixels. */
export const SHARPEN_RADIUS_PX = 1;

/** How strongly clarity pushes local contrast at 100. */
export const CLARITY_STRENGTH = 0.8;

/** Clarity's blur radius, as a fraction of the clip's shorter side. */
export const CLARITY_RADIUS_FRACTION = 0.02;

/** Peak-to-peak grain, as a fraction of full scale, at 100. */
export const PARTICLES_STRENGTH = 0.18;

/** One grain cell, in the clip's own pixels. */
export const PARTICLES_CELL_PX = 1.5;

/** Where fade lifts black to, and pulls white down by, at 100. */
export const FADE_BLACK = 0.16;
export const FADE_WHITE = 0.06;
/** How much saturation fade takes out at 100. */
export const FADE_DESATURATE = 0.2;

/** The fraction of the colour vignette removes (or adds, negative) at the corners, at ±100. */
export const VIGNETTE_STRENGTH = 0.75;
/** Normalised radius where the vignette begins, and where it is at full strength. */
export const VIGNETTE_INNER = 0.35;
export const VIGNETTE_OUTER = 1.05;
