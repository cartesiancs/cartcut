/**
 * The eighty tables Cartcut ships, as formulas.
 *
 * Each is a short list of `colorMath.ts` steps. `scripts/generateLuts.ts`
 * evaluates them at every node of a 17³ cube and writes the `.cube` files under
 * `assets/presets/luts/`; `lutCatalogue.test.ts` regenerates a sample and
 * compares byte for byte, so the checked-in files and this file cannot drift.
 *
 * ## The rules the catalogue is held to
 *
 * The same three `fx/catalogue.test.ts` states for shaders, adapted:
 *
 * 1. **One look per slot.** Two presets that grade alike are one preset with a
 *    worse name. `lutCatalogue.test.ts` measures the distance between every
 *    pair of tables and refuses any that are too close, which is the LUT
 *    equivalent of the "distinct shader pipeline" rule.
 * 2. **Every category earns its heading.** Six presets minimum, so no section
 *    of the panel is a heading with two tiles under it.
 * 3. **Nothing is traced.** Every table here is generated from published
 *    colour science or from an authored curve. None is derived from anyone
 *    else's LUT, and the film-stock names describe the *look being aimed at*,
 *    the way "Portra-like" describes a look — they are not conversions of, or
 *    claims to reproduce, those products.
 *
 * ## What `log-convert` does and does not claim
 *
 * Those six apply the **published transfer function** for the format —
 * `colorMath.ts#logDecode` — and a neutral Rec.709 render on top. They do not
 * apply a camera's primaries matrix, because that varies by camera body and
 * mode and guessing at it would be worse than leaving it alone, and they carry
 * no manufacturer "look". So they are the transform that makes flat log
 * footage viewable and gradeable — a correct and useful base — and they are not
 * a substitute for a vendor conversion LUT where one exists. That distinction
 * is repeated in the panel copy.
 */

import type { LutCategory } from "../fx/presetTypes";
import {
  asc,
  bleachBypass,
  channelCurve,
  type ColorStep,
  contrast,
  exposure,
  filmS,
  hueBand,
  liftGammaGain,
  logDecode,
  logToRec709,
  matte,
  monoMix,
  type Rgb,
  rgbCurve,
  runSteps,
  saturation,
  softWhites,
  splitTone,
  temperature,
  tint,
  vibrance,
} from "./colorMath";

export type LutRecipe = {
  /** Folder name, and the last segment of the preset id. */
  slug: string;
  /** Shown on the tile. */
  name: string;
  category: LutCategory;
  /** One line, for the manifest and the tile's tooltip. */
  note: string;
  steps: ColorStep[];
};

/** Evaluate a recipe at one colour. */
export function gradeWith(recipe: LutRecipe, input: Rgb): Rgb {
  return runSteps(recipe.steps, input);
}

const neutral: Rgb = [0.5, 0.5, 0.5];

/** Warm highlights, cool shadows — the move behind most of `cinematic`. */
const cinematicSplit = (strength: number, shadow: Rgb, highlight: Rgb) =>
  splitTone(shadow, highlight, strength);

/** Keep skin out of a grade that would otherwise turn it. */
const protectSkin = (amount: number) =>
  hueBand({ center: 28, width: 46, satScale: 1 - amount * 0.45 });

export const LUT_RECIPES: LutRecipe[] = [
  // ------------------------------------------------------------------ film
  {
    slug: "print-2383",
    name: "Print 2383",
    category: "film",
    note: "Dense print stock: deep neutral blacks, warm highlight roll-off.",
    steps: [
      filmS(0.55),
      splitTone([0.44, 0.47, 0.56], [0.55, 0.51, 0.44], 0.1),
      saturation(1.08),
      liftGammaGain([0.005, 0.004, 0.012], [1, 1, 0.98], [1, 1, 0.99]),
    ],
  },
  {
    slug: "print-2393",
    name: "Print 2393",
    category: "film",
    note: "Higher contrast print with punchier reds than Print 2383.",
    steps: [
      filmS(0.78),
      hueBand({ center: 5, width: 60, satScale: 1.18 }),
      splitTone([0.46, 0.47, 0.54], [0.55, 0.5, 0.45], 0.08),
      saturation(1.05),
    ],
  },
  {
    slug: "print-3513",
    name: "Print 3513",
    category: "film",
    note: "Cooler, gentler print: open shadows and restrained saturation.",
    steps: [
      filmS(0.4),
      temperature(-0.12),
      matte(0.05, [0.46, 0.5, 0.58]),
      saturation(0.96),
    ],
  },
  {
    slug: "eterna-soft",
    name: "Eterna Soft",
    category: "film",
    note: "Low-contrast stock look — flat, gentle, easy to grade further.",
    steps: [
      contrast(0.86),
      matte(0.09, [0.48, 0.5, 0.53]),
      saturation(0.82),
      temperature(-0.05),
    ],
  },
  {
    slug: "portrait-neg",
    name: "Portrait Neg",
    category: "film",
    note: "Portrait negative: creamy skin, restrained greens, soft highlights.",
    steps: [
      exposure(0.08),
      hueBand({ center: 28, width: 60, satScale: 1.12, hueShift: -3 }),
      hueBand({ center: 120, width: 70, satScale: 0.82 }),
      softWhites(0.03),
      filmS(0.28),
    ],
  },
  {
    slug: "daylight-neg",
    name: "Daylight Neg",
    category: "film",
    note: "Daylight-balanced negative: clean neutrals, gentle blue shadows.",
    steps: [
      filmS(0.32),
      splitTone([0.46, 0.49, 0.56], [0.53, 0.52, 0.48], 0.07),
      saturation(1.02),
    ],
  },
  {
    slug: "tungsten-neg",
    name: "Tungsten Neg",
    category: "film",
    note: "Tungsten stock shot warm: cyan shadows, amber practicals.",
    steps: [
      temperature(-0.18),
      splitTone([0.42, 0.5, 0.6], [0.58, 0.51, 0.42], 0.16),
      hueBand({ center: 200, width: 80, satScale: 1.2 }),
      filmS(0.38),
    ],
  },
  {
    slug: "reversal-slide",
    name: "Reversal Slide",
    category: "film",
    note: "Slide film: high contrast, saturated, and unforgiving of highlights.",
    steps: [
      // Skin is protected *before* the saturation push rather than clawed back
      // after it: a band applied to already-extreme colours is a much steeper
      // function, and a 17-node cube reconstructs it several 8-bit steps out.
      protectSkin(0.4),
      filmS(0.8),
      saturation(1.2),
      hueBand({ center: 210, width: 95, satScale: 1.2 }),
    ],
  },
  {
    slug: "archive-neg",
    name: "Archive Neg",
    category: "film",
    note: "Aged negative: dye shift toward yellow, blacks never quite closing.",
    steps: [
      matte(0.14, [0.5, 0.47, 0.38]),
      temperature(0.12),
      saturation(0.78),
      contrast(1.05),
    ],
  },
  {
    slug: "scan-neutral",
    name: "Scan Neutral",
    category: "film",
    note: "A flat film scan: everything present, nothing decided yet.",
    steps: [contrast(0.82), matte(0.06, neutral), saturation(0.9)],
  },

  // ------------------------------------------------------------- cinematic
  {
    slug: "teal-orange",
    name: "Teal & Orange",
    category: "cinematic",
    note: "The blockbuster separation: warm faces against cool everything else.",
    steps: [
      cinematicSplit(0.19, [0.4, 0.51, 0.6], [0.58, 0.51, 0.42]),
      hueBand({ center: 28, width: 55, satScale: 1.2 }),
      hueBand({ center: 200, width: 90, satScale: 1.15 }),
      filmS(0.4),
    ],
  },
  {
    slug: "blockbuster",
    name: "Blockbuster",
    category: "cinematic",
    note: "Teal and orange pushed hard, with contrast to match.",
    steps: [
      cinematicSplit(0.3, [0.36, 0.5, 0.64], [0.62, 0.51, 0.38]),
      contrast(1.15),
      saturation(1.12),
      filmS(0.5),
    ],
  },
  {
    slug: "night-city",
    name: "Night City",
    category: "cinematic",
    note: "Deep blue night with sodium and neon left burning.",
    steps: [
      exposure(-0.25),
      splitTone([0.36, 0.44, 0.66], [0.58, 0.5, 0.44], 0.24),
      hueBand({ center: 300, width: 80, satScale: 1.3 }),
      hueBand({ center: 45, width: 50, satScale: 1.25 }),
      contrast(1.12),
    ],
  },
  {
    slug: "desert-heat",
    name: "Desert Heat",
    category: "cinematic",
    note: "Bleached sand and hard sun: warm, dry, low blue.",
    steps: [
      temperature(0.26),
      hueBand({ center: 210, width: 90, satScale: 0.6 }),
      contrast(1.1),
      softWhites(0.04),
      saturation(0.95),
    ],
  },
  {
    slug: "nordic-noir",
    name: "Nordic Noir",
    category: "cinematic",
    note: "Desaturated cold: grey skies, no warmth anywhere.",
    steps: [
      temperature(-0.24),
      saturation(0.62),
      matte(0.08, [0.46, 0.5, 0.55]),
      contrast(1.08),
    ],
  },
  {
    slug: "moonlight",
    name: "Moonlight",
    category: "cinematic",
    note: "Day for night: dark, blue, and still readable.",
    steps: [
      exposure(-0.85),
      temperature(-0.35),
      splitTone([0.38, 0.46, 0.64], [0.48, 0.52, 0.6], 0.2),
      saturation(0.72),
      contrast(1.12),
    ],
  },
  {
    slug: "amber-dusk",
    name: "Amber Dusk",
    category: "cinematic",
    note: "The last twenty minutes of light, held.",
    steps: [
      temperature(0.2),
      splitTone([0.46, 0.46, 0.54], [0.6, 0.52, 0.4], 0.2),
      exposure(-0.1),
      filmS(0.35),
    ],
  },
  {
    slug: "steel-blue",
    name: "Steel Blue",
    category: "cinematic",
    note: "Cold industrial: hard contrast, blue-grey neutrals.",
    steps: [
      temperature(-0.2),
      contrast(1.22),
      saturation(0.8),
      splitTone([0.42, 0.48, 0.58], [0.5, 0.52, 0.56], 0.14),
    ],
  },
  {
    slug: "golden-hour",
    name: "Golden Hour",
    category: "cinematic",
    note: "Low warm sun with the shadows left open.",
    steps: [
      temperature(0.24),
      exposure(0.12),
      matte(0.06, [0.5, 0.48, 0.44]),
      hueBand({ center: 40, width: 60, satScale: 1.2 }),
      filmS(0.25),
    ],
  },
  {
    slug: "cyber-neon",
    name: "Cyber Neon",
    category: "cinematic",
    note: "Magenta and cyan, pushed until the neutrals pick a side.",
    steps: [
      splitTone([0.38, 0.46, 0.64], [0.62, 0.44, 0.6], 0.3),
      hueBand({ center: 320, width: 120, satScale: 1.35 }),
      hueBand({ center: 185, width: 120, satScale: 1.32 }),
      contrast(1.18),
    ],
  },

  // --------------------------------------------------------------- vintage
  {
    slug: "faded-seventies",
    name: "Faded Seventies",
    category: "vintage",
    note: "Warm fade with brown-lifted blacks and dulled blues.",
    steps: [
      matte(0.18, [0.55, 0.47, 0.36]),
      temperature(0.16),
      saturation(0.76),
      softWhites(0.05),
      contrast(1.04),
    ],
  },
  {
    slug: "super-eight",
    name: "Super 8",
    category: "vintage",
    note: "Home-movie stock: yellow-green cast, crushed reds, soft whites.",
    steps: [
      channelCurve({
        r: [
          [0, 0.06],
          [0.5, 0.52],
          [1, 0.95],
        ],
        g: [
          [0, 0.05],
          [0.5, 0.53],
          [1, 0.97],
        ],
        b: [
          [0, 0.1],
          [0.5, 0.44],
          [1, 0.86],
        ],
      }),
      saturation(0.88),
      temperature(0.1),
    ],
  },
  {
    slug: "tape-transfer",
    name: "Tape Transfer",
    category: "vintage",
    note: "Analogue tape colour: smeared magenta, milky blacks, low contrast.",
    steps: [
      matte(0.16, [0.52, 0.46, 0.52]),
      contrast(0.9),
      hueBand({ center: 330, width: 90, satScale: 1.25 }),
      saturation(0.86),
    ],
  },
  {
    slug: "three-strip",
    name: "Three Strip",
    category: "vintage",
    note: "Dye-transfer saturation: primaries loud, everything else obedient.",
    steps: [
      saturation(1.45),
      hueBand({ center: 0, width: 50, satScale: 1.25 }),
      hueBand({ center: 120, width: 60, satScale: 1.15 }),
      contrast(1.15),
      filmS(0.4),
    ],
  },
  {
    slug: "sepia-print",
    name: "Sepia Print",
    category: "vintage",
    note: "Monochrome toned to warm brown, the way a print ages.",
    steps: [monoMix([0.35, 0.5, 0.15], [0.76, 0.6, 0.42]), filmS(0.35)],
  },
  {
    slug: "albumen",
    name: "Albumen",
    category: "vintage",
    note: "Early photographic print: pale, yellowed, low in contrast.",
    steps: [
      monoMix([0.4, 0.45, 0.15], [0.78, 0.68, 0.48]),
      contrast(0.85),
      matte(0.14, [0.62, 0.57, 0.44]),
    ],
  },
  {
    slug: "instant-pack",
    name: "Instant Pack",
    category: "vintage",
    note: "Instant film: cyan shadows, cream highlights, nothing fully black.",
    steps: [
      matte(0.15, [0.4, 0.5, 0.55]),
      softWhites(0.04),
      splitTone([0.42, 0.51, 0.58], [0.58, 0.54, 0.46], 0.18),
      saturation(0.9),
    ],
  },
  {
    slug: "silver-retained",
    name: "Silver Retained",
    category: "vintage",
    note: "Bleach bypass: contrast up and colour down, together.",
    steps: [bleachBypass(0.68), contrast(1.08), saturation(0.9)],
  },

  // ------------------------------------------------------------------ mono
  {
    slug: "mono-neutral",
    name: "Mono Neutral",
    category: "mono",
    note: "Plain Rec.709 luminance. The honest black and white.",
    steps: [monoMix([0.2126, 0.7152, 0.0722])],
  },
  {
    slug: "mono-contrast",
    name: "Mono Contrast",
    category: "mono",
    note: "Hard black and white: closed blacks, bright whites.",
    steps: [monoMix([0.2126, 0.7152, 0.0722]), filmS(1.0), contrast(1.1)],
  },
  {
    slug: "mono-red",
    name: "Mono Red",
    category: "mono",
    note: "Shot through red glass: dark dramatic skies, bright skin.",
    steps: [monoMix([0.72, 0.24, 0.04]), filmS(0.45)],
  },
  {
    slug: "mono-orange",
    name: "Mono Orange",
    category: "mono",
    note: "Through orange glass: the portrait standard, skies still darkened.",
    steps: [monoMix([0.56, 0.38, 0.06]), filmS(0.35)],
  },
  {
    slug: "mono-yellow",
    name: "Mono Yellow",
    category: "mono",
    note: "Through yellow glass: a gentle sky, close to how the eye reads it.",
    steps: [monoMix([0.4, 0.5, 0.1]), filmS(0.28)],
  },
  {
    slug: "mono-green",
    name: "Mono Green",
    category: "mono",
    note: "Through green glass: foliage separates, skin goes heavy.",
    steps: [monoMix([0.15, 0.72, 0.13]), filmS(0.3)],
  },
  {
    slug: "mono-infrared",
    name: "Mono Infrared",
    category: "mono",
    note: "Faux infrared: white leaves, near-black sky, glowing highlights.",
    steps: [
      hueBand({ center: 100, width: 140, lumScale: 1.55 }),
      monoMix([0.35, 0.62, 0.03]),
      filmS(0.7),
      softWhites(-0.02),
    ],
  },
  {
    slug: "mono-platinum",
    name: "Mono Platinum",
    category: "mono",
    note: "Platinum print: long tonal scale, warm-cool split, open shadows.",
    steps: [
      monoMix([0.28, 0.6, 0.12]),
      contrast(0.88),
      matte(0.09, [0.52, 0.5, 0.47]),
      splitTone([0.48, 0.5, 0.54], [0.54, 0.51, 0.47], 0.12),
    ],
  },

  // ------------------------------------------------------------------ warm
  {
    slug: "warm-soft",
    name: "Warm Soft",
    category: "warm",
    note: "A quarter-CTO worth of warmth and nothing else.",
    steps: [temperature(0.2), matte(0.06, [0.54, 0.5, 0.45]), vibrance(0.08)],
  },
  {
    slug: "warm-punch",
    name: "Warm Punch",
    category: "warm",
    note: "Warm with contrast and saturation to carry it.",
    steps: [temperature(0.2), contrast(1.14), vibrance(0.25), filmS(0.3)],
  },
  {
    slug: "sunset-glow",
    name: "Sunset Glow",
    category: "warm",
    note: "Orange highlights over a violet sky.",
    steps: [
      splitTone([0.5, 0.46, 0.58], [0.64, 0.5, 0.36], 0.26),
      temperature(0.14),
      hueBand({ center: 20, width: 60, satScale: 1.3 }),
    ],
  },
  {
    slug: "candlelight",
    name: "Candlelight",
    category: "warm",
    note: "Very warm and slightly under: firelight, not daylight.",
    steps: [
      temperature(0.4),
      exposure(-0.2),
      matte(0.05, [0.55, 0.45, 0.35]),
      saturation(0.95),
    ],
  },
  {
    slug: "honey",
    name: "Honey",
    category: "warm",
    note: "Golden midtones with the blues kept quiet.",
    steps: [
      temperature(0.22),
      hueBand({ center: 45, width: 70, satScale: 1.3, lumScale: 1.05 }),
      hueBand({ center: 220, width: 80, satScale: 0.7 }),
      filmS(0.25),
    ],
  },
  {
    slug: "terracotta",
    name: "Terracotta",
    category: "warm",
    note: "Earthy red-brown: warm shadows, restrained highlights.",
    steps: [
      splitTone([0.58, 0.48, 0.42], [0.55, 0.51, 0.47], 0.22),
      saturation(0.92),
      contrast(1.06),
    ],
  },
  {
    slug: "tungsten-warm",
    name: "Tungsten Warm",
    category: "warm",
    note: "Uncorrected tungsten: amber everything, deep blue windows.",
    steps: [
      temperature(0.34),
      hueBand({ center: 220, width: 70, satScale: 1.35 }),
      contrast(1.05),
    ],
  },
  {
    slug: "summer-skin",
    name: "Summer Skin",
    category: "warm",
    note: "Flattering warmth aimed at faces, greens left alone.",
    steps: [
      hueBand({ center: 28, width: 55, satScale: 1.15, lumScale: 1.06 }),
      temperature(0.1),
      exposure(0.08),
      softWhites(0.03),
    ],
  },

  // ------------------------------------------------------------------ cool
  {
    slug: "cool-soft",
    name: "Cool Soft",
    category: "cool",
    note: "A quarter-CTB worth of cool and nothing else.",
    steps: [temperature(-0.2), matte(0.06, [0.45, 0.5, 0.55]), vibrance(0.08)],
  },
  {
    slug: "cool-punch",
    name: "Cool Punch",
    category: "cool",
    note: "Cool with contrast and saturation to carry it.",
    steps: [temperature(-0.2), contrast(1.14), vibrance(0.22), filmS(0.3)],
  },
  {
    slug: "arctic",
    name: "Arctic",
    category: "cool",
    note: "White and blue, almost no warmth left in the picture.",
    steps: [
      temperature(-0.32),
      saturation(0.7),
      exposure(0.12),
      contrast(1.1),
      hueBand({ center: 200, width: 90, satScale: 1.25 }),
    ],
  },
  {
    slug: "twilight",
    name: "Twilight",
    category: "cool",
    note: "The blue half hour, with a little magenta left in the sky.",
    steps: [
      temperature(-0.24),
      tint(0.08),
      exposure(-0.2),
      splitTone([0.42, 0.46, 0.6], [0.52, 0.5, 0.58], 0.18),
    ],
  },
  {
    slug: "ocean",
    name: "Ocean",
    category: "cool",
    note: "Cyan-green water and a clean sky.",
    steps: [
      hueBand({ center: 190, width: 90, satScale: 1.35, lumScale: 1.04 }),
      temperature(-0.14),
      contrast(1.08),
      vibrance(0.15),
    ],
  },
  {
    slug: "mist",
    name: "Mist",
    category: "cool",
    note: "Low contrast, lifted blacks, colour nearly gone.",
    steps: [
      matte(0.2, [0.5, 0.52, 0.55]),
      contrast(0.82),
      saturation(0.6),
      temperature(-0.08),
    ],
  },
  {
    slug: "moonrise",
    name: "Moonrise",
    category: "cool",
    note: "Cool and dark with the highlights left silver.",
    steps: [
      exposure(-0.5),
      temperature(-0.28),
      splitTone([0.4, 0.46, 0.6], [0.52, 0.53, 0.55], 0.2),
      contrast(1.15),
    ],
  },
  {
    slug: "winter-blue",
    name: "Winter Blue",
    category: "cool",
    note: "Cold daylight: blue shadows, neutral highlights, low saturation.",
    steps: [
      splitTone([0.4, 0.47, 0.62], [0.51, 0.51, 0.51], 0.22),
      saturation(0.8),
      contrast(1.06),
    ],
  },

  // ----------------------------------------------------------------- vivid
  {
    slug: "vivid-pop",
    name: "Vivid Pop",
    category: "vivid",
    note: "Everything louder, with skin protected from the worst of it.",
    steps: [vibrance(0.5), saturation(1.1), protectSkin(0.5), contrast(1.1)],
  },
  {
    slug: "vivid-punch",
    name: "Vivid Punch",
    category: "vivid",
    note: "Saturation and contrast together, no protection at all.",
    steps: [saturation(1.4), filmS(0.6), contrast(1.08)],
  },
  {
    slug: "hdr-look",
    name: "HDR Look",
    category: "vivid",
    note: "Compressed range: shadows opened, highlights held, colour up.",
    steps: [
      rgbCurve([
        [0, 0.05],
        [0.25, 0.36],
        [0.5, 0.55],
        [0.75, 0.74],
        [1, 0.96],
      ]),
      vibrance(0.35),
      saturation(1.1),
    ],
  },
  {
    slug: "landscape",
    name: "Landscape",
    category: "vivid",
    note: "Greens and blues lifted, everything else steady.",
    steps: [
      hueBand({ center: 110, width: 80, satScale: 1.3, lumScale: 1.03 }),
      hueBand({ center: 215, width: 80, satScale: 1.3 }),
      contrast(1.1),
      vibrance(0.2),
    ],
  },
  {
    slug: "food-fresh",
    name: "Food Fresh",
    category: "vivid",
    note: "Warm and appetising: reds and yellows up, greens crisp.",
    steps: [
      temperature(0.08),
      hueBand({ center: 15, width: 55, satScale: 1.3 }),
      hueBand({ center: 60, width: 50, satScale: 1.2 }),
      exposure(0.12),
      vibrance(0.25),
    ],
  },
  {
    slug: "product-clean",
    name: "Product Clean",
    category: "vivid",
    note: "Neutral whites, hard contrast, no colour cast anywhere.",
    steps: [
      contrast(1.18),
      saturation(1.12),
      liftGammaGain([0, 0, 0], [1, 1, 1], [1.02, 1.02, 1.02]),
    ],
  },
  {
    slug: "neon-pop",
    name: "Neon Pop",
    category: "vivid",
    note: "Saturated magenta and cyan against a dark, contrasty base.",
    steps: [
      contrast(1.25),
      hueBand({ center: 310, width: 110, satScale: 1.4 }),
      hueBand({ center: 180, width: 110, satScale: 1.35 }),
      saturation(1.15),
    ],
  },
  {
    slug: "chrome",
    name: "Chrome",
    category: "vivid",
    note: "Cool, bright and hard — saturated without going warm.",
    steps: [temperature(-0.1), filmS(0.7), saturation(1.25), vibrance(0.15)],
  },

  // ----------------------------------------------------------------- matte
  {
    slug: "matte-black",
    name: "Matte Black",
    category: "matte",
    note: "Neutral lifted blacks and nothing else changed.",
    steps: [matte(0.16, neutral)],
  },
  {
    slug: "matte-soft",
    name: "Matte Soft",
    category: "matte",
    note: "Lifted blacks and lowered whites: the flattest of the set.",
    steps: [matte(0.14, neutral), softWhites(0.08), saturation(0.94)],
  },
  {
    slug: "matte-faded",
    name: "Matte Faded",
    category: "matte",
    note: "Faded print: warm lift, dropped saturation, soft top end.",
    steps: [
      matte(0.2, [0.55, 0.5, 0.44]),
      softWhites(0.06),
      saturation(0.74),
    ],
  },
  {
    slug: "matte-cream",
    name: "Matte Cream",
    category: "matte",
    note: "Warm cream lift with the highlights kept clean.",
    steps: [matte(0.17, [0.6, 0.55, 0.46]), contrast(0.95), vibrance(0.1)],
  },
  {
    slug: "matte-charcoal",
    name: "Matte Charcoal",
    category: "matte",
    note: "Cool grey lift: the shadows go to slate rather than to black.",
    steps: [matte(0.18, [0.44, 0.47, 0.52]), saturation(0.85)],
  },
  {
    slug: "matte-dusty",
    name: "Matte Dusty",
    category: "matte",
    note: "Dry warm haze — a fade with the colour partly gone.",
    steps: [
      matte(0.22, [0.56, 0.52, 0.45]),
      saturation(0.66),
      softWhites(0.05),
      temperature(0.06),
    ],
  },
  {
    slug: "matte-pastel",
    name: "Matte Pastel",
    category: "matte",
    note: "Everything pulled toward the middle: pale, soft, low contrast.",
    steps: [
      contrast(0.72),
      matte(0.12, [0.55, 0.54, 0.55]),
      saturation(0.88),
      exposure(0.15),
    ],
  },
  {
    slug: "matte-film",
    name: "Matte Film",
    category: "matte",
    note: "A print curve over a matte base: soft ends, honest middle.",
    steps: [filmS(0.45), matte(0.13, [0.5, 0.5, 0.53]), softWhites(0.04)],
  },

  // ----------------------------------------------------------- log-convert
  {
    slug: "slog3-rec709",
    name: "S-Log3 to Rec.709",
    category: "log-convert",
    note: "Published S-Log3 transfer function, rendered to Rec.709. Not a vendor look.",
    steps: [logToRec709(logDecode.slog3, 0.4), filmS(0.3), saturation(1.05)],
  },
  {
    slug: "logc3-rec709",
    name: "LogC3 to Rec.709",
    category: "log-convert",
    note: "Published LogC3 (EI 800) transfer function, rendered to Rec.709.",
    steps: [logToRec709(logDecode.logc3, 0.35), filmS(0.3), saturation(1.05)],
  },
  {
    slug: "vlog-rec709",
    name: "V-Log to Rec.709",
    category: "log-convert",
    note: "Published V-Log transfer function, rendered to Rec.709.",
    steps: [logToRec709(logDecode.vlog, 0.4), filmS(0.3), saturation(1.05)],
  },
  {
    slug: "clog3-rec709",
    name: "C-Log3 to Rec.709",
    category: "log-convert",
    note: "Published C-Log3 transfer function, rendered to Rec.709.",
    steps: [logToRec709(logDecode.clog3, 0.35), filmS(0.3), saturation(1.05)],
  },
  {
    slug: "dlog-rec709",
    name: "D-Log to Rec.709",
    category: "log-convert",
    note: "Published D-Log transfer function, rendered to Rec.709.",
    steps: [logToRec709(logDecode.dlog, 0.3), filmS(0.32), saturation(1.06)],
  },
  {
    slug: "hlg-rec709",
    name: "HLG to Rec.709",
    category: "log-convert",
    note: "BT.2100 HLG rolled down to an SDR Rec.709 picture.",
    steps: [logToRec709(logDecode.hlg, 1.2), filmS(0.25), saturation(1.02)],
  },

  // --------------------------------------------------------------- utility
  {
    slug: "identity",
    name: "None (Identity)",
    category: "utility",
    note: "Changes nothing. Useful for checking a pipeline end to end.",
    steps: [],
  },
  {
    slug: "contrast-plus",
    name: "Contrast +",
    category: "utility",
    note: "One stop of S-curve contrast, no colour change at all.",
    steps: [filmS(0.5)],
  },
  {
    slug: "contrast-minus",
    name: "Contrast −",
    category: "utility",
    note: "Flatten the curve without lifting the blacks.",
    steps: [contrast(0.78)],
  },
  {
    slug: "exposure-plus",
    name: "Exposure +",
    category: "utility",
    note: "Two-thirds of a stop brighter, in linear light.",
    steps: [exposure(0.67)],
  },
  {
    slug: "exposure-minus",
    name: "Exposure −",
    category: "utility",
    note: "Two-thirds of a stop darker, in linear light.",
    steps: [exposure(-0.67)],
  },
  {
    slug: "rec709-legal",
    name: "Broadcast Safe",
    category: "utility",
    note: "Squeeze into 16-235: nothing clips on a broadcast scope.",
    steps: [
      asc(
        [(235 - 16) / 255, (235 - 16) / 255, (235 - 16) / 255],
        [16 / 255, 16 / 255, 16 / 255],
        [1, 1, 1],
      ),
    ],
  },
];
