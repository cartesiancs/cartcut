/**
 * The text presets the "Text" asset panel offers: sixty tiles that pair twenty
 * bundled Google Fonts with three of eleven style recipes each, and forty
 * designs that each pair one face with one look of its own.
 *
 * Three rules shape everything here.
 *
 * **Only properties `renderer/text.ts` actually draws.** A preset is a bag of
 * fields that already have a rendering implementation: `textcolor`,
 * `letterSpacing`, `isBold`/`isItalic`/`align`, `outline` and its opacity, the
 * line `background` with its opacity, padding and corner radius, `shadow`,
 * `glow`, a gradient fill, a text transform, a text opacity and a size
 * multiplier. The panel tile is drawn by the same renderer from the same
 * element the click adds (`features/text/textTile.ts`), so a field the canvas
 * ignored would make the tile and the clip agree on a lie. The frosted
 * backdrop is left out for the same reason: a tile has no picture behind it to
 * blur.
 *
 * **The filename stem is the family name.** `parseFontPath` derives it, the
 * element stores it in `fontname`, and `renderText` puts it straight into
 * `ctx.font` where the canvas resolves it as a CSS family. So an entry names a
 * *file*, and `buildTextPresets` joins that against what the main process
 * actually found on disk: a font that failed to download drops out of the
 * panel instead of producing tiles that silently draw in the fallback.
 *
 * **A recipe tile's id and style never change.** Nothing stores a preset id
 * today, but the sixty were the whole panel for long enough that a user knows
 * them by sight; the designs are added beside them, not over them.
 *
 * Weight comes from the bundled file, not from a property: `renderText` never
 * reads `fontweight`, and the only weight axis `ctx.font` exposes is the binary
 * `bold`. Wanting a heavy Montserrat therefore means bundling
 * `Montserrat-ExtraBold.ttf`, which is what the list below does.
 */

import type { FontEntry } from "./fontFaces";

export type PresetStyle = {
  textcolor: string;
  /**
   * Stroked with `strokeText` at this width, in element-space px. `opacity`
   * (0-100) fades the stroke alone; a glow or shadow is still cast from it.
   */
  outline?: { size: number; color: string; opacity?: number };
  /**
   * The band behind each line. `opacity` is 0-100; `padding` and `radius` are
   * element-space px. Absent fields take `features/text/style.ts`'s defaults
   * (100, 12, 0), and a preset never states a default.
   */
  background?: {
    color: string;
    opacity?: number;
    padding?: number;
    radius?: number;
  };
  /** Drop shadow, in element-space px: see `@types/timeline#TextShadow`. */
  shadow?: { offsetX: number; offsetY: number; blur: number; color: string; opacity: number };
  /** Even halo around the glyphs. */
  glow?: { size: number; color: string; opacity: number };
  /** Gradient glyph fill. Omitted means the flat `textcolor`. */
  gradient?: { from: string; to: string; angle: number };
  letterSpacing?: number;
  isBold?: boolean;
  isItalic?: boolean;
  align?: "left" | "center" | "right";
  /** Drawn case. The element keeps what the user typed. */
  textTransform?: "uppercase" | "lowercase";
  /**
   * 0-100, applied to the lettering as a whole: fill, outline, glow and shadow
   * together. The band is not part of it.
   */
  textOpacity?: number;
  /**
   * Multiplier on the resolution-derived base font size. Display faces carry a
   * title at a larger size than a body serif wants; script faces read small.
   */
  sizeScale?: number;
};

/**
 * The panel section a preset is listed under: the look's main ingredient, so
 * someone after "an outlined title" finds every outlined face in one place.
 */
export const PRESET_GROUPS = [
  "clean",
  "outline",
  "box",
  "shadow",
  "glow",
  "gradient",
] as const;

export type PresetGroup = (typeof PRESET_GROUPS)[number];

/** Section titles, in English for the reason `RECIPE_LABEL` gives. */
export const PRESET_GROUP_LABEL: Record<PresetGroup, string> = {
  clean: "Clean",
  outline: "Outline",
  box: "Box",
  shadow: "Shadow",
  glow: "Glow",
  gradient: "Gradient",
};

export type TextPreset = {
  /** Stable across runs: `"Montserrat-ExtraBold/outline"`. */
  id: string;
  /** Both halves, for the tooltip and the search: `"Montserrat, Outline"`. */
  label: string;
  /** The Google Fonts family: the tile's first label line. */
  fontLabel: string;
  /** The look: the tile's second label line. */
  styleLabel: string;
  group: PresetGroup;
  /** Filename inside `assets/fonts/google`, joined against the real listing. */
  file: string;
  /** CSS family name: the file's stem, and the element's `fontname`. */
  family: string;
  /** Absolute path on disk, filled in by `buildTextPresets`. */
  path: string;
  /** Extension, for `@font-face`'s `format()`. */
  type: string;
  style: PresetStyle;
};

const WHITE = "#ffffff";
const BLACK = "#000000";
const INK = "#111111";
const ACCENT = "#ffd93d";
const HOT = "#ff4d6d";
const NEON = "#4dfff0";

/**
 * The style archetypes, named so the recipe list below reads as an assignment
 * rather than a wall of colour literals.
 */
const RECIPES = {
  clean: { textcolor: WHITE },
  outline: { textcolor: WHITE, outline: { size: 8, color: BLACK } },
  boxed: { textcolor: WHITE, background: { color: BLACK } },
  invert: { textcolor: INK, background: { color: WHITE } },
  pop: { textcolor: ACCENT, outline: { size: 6, color: BLACK } },
  hot: { textcolor: WHITE, background: { color: HOT } },
  tracked: { textcolor: WHITE, letterSpacing: 8, align: "center" },
  softItalic: { textcolor: "#f2efe9", isItalic: true },
  shadowed: {
    textcolor: WHITE,
    shadow: { offsetX: 4, offsetY: 6, blur: 14, color: BLACK, opacity: 65 },
  },
  neon: {
    textcolor: NEON,
    glow: { size: 20, color: NEON, opacity: 90 },
  },
  gradient: {
    textcolor: WHITE,
    gradient: { from: "#ffd93d", to: "#ff4d6d", angle: 90 },
    outline: { size: 3, color: BLACK },
  },
} as const satisfies Record<string, PresetStyle>;

type RecipeName = keyof typeof RECIPES;

/**
 * Recipe labels, in English and only in English.
 *
 * Deliberately not routed through `LocaleController`: these sit directly under
 * a Latin-only type specimen, next to a Latin family name. A localised style
 * label would put Hangul beside lettering that cannot render Hangul, which
 * reads as the tile lying about the face.
 */
const RECIPE_LABEL: Record<RecipeName, string> = {
  clean: "Clean",
  outline: "Outline",
  boxed: "Black Box",
  invert: "White Box",
  pop: "Yellow Pop",
  hot: "Pink Box",
  tracked: "Tracked",
  softItalic: "Italic",
  shadowed: "Drop Shadow",
  neon: "Neon Glow",
  gradient: "Gradient",
};

const RECIPE_GROUP: Record<RecipeName, PresetGroup> = {
  clean: "clean",
  tracked: "clean",
  softItalic: "clean",
  outline: "outline",
  pop: "outline",
  boxed: "box",
  invert: "box",
  hot: "box",
  shadowed: "shadow",
  neon: "glow",
  gradient: "gradient",
};

type FontSpec = {
  file: string;
  /** Human name for the tile: the Google Fonts family, not the file stem. */
  display: string;
  sizeScale?: number;
};

/**
 * Every bundled face. The first twenty carry the recipe tiles; the last eight
 * are display faces that exist for the designs, each a look none of the
 * twenty can make: a comic, a pixel, a stencil, a neon tube.
 */
const FONTS: readonly FontSpec[] = [
  // Sans: the workhorses.
  { file: "Roboto-Bold.ttf", display: "Roboto" },
  { file: "OpenSans-SemiBold.ttf", display: "Open Sans" },
  { file: "Inter-Bold.ttf", display: "Inter" },
  { file: "Poppins-SemiBold.ttf", display: "Poppins" },
  { file: "Montserrat-ExtraBold.ttf", display: "Montserrat", sizeScale: 1.05 },
  { file: "Raleway-SemiBold.ttf", display: "Raleway" },
  { file: "Nunito-Bold.ttf", display: "Nunito" },

  // Condensed and display: titles and thumbnails.
  { file: "Oswald-Bold.ttf", display: "Oswald", sizeScale: 1.15 },
  { file: "BebasNeue-Regular.ttf", display: "Bebas Neue", sizeScale: 1.25 },
  { file: "Anton-Regular.ttf", display: "Anton", sizeScale: 1.2 },
  { file: "ArchivoBlack-Regular.ttf", display: "Archivo Black", sizeScale: 1.1 },

  // Serif: titles with some weight to them.
  { file: "PlayfairDisplay-Bold.ttf", display: "Playfair Display" },
  { file: "Merriweather-Bold.ttf", display: "Merriweather" },
  { file: "Lora-Bold.ttf", display: "Lora" },
  { file: "AbrilFatface-Regular.ttf", display: "Abril Fatface", sizeScale: 1.1 },

  // Script and hand: captions with a voice.
  { file: "Pacifico-Regular.ttf", display: "Pacifico", sizeScale: 0.95 },
  { file: "Lobster-Regular.ttf", display: "Lobster" },
  { file: "Caveat-Bold.ttf", display: "Caveat", sizeScale: 1.15 },
  { file: "PermanentMarker-Regular.ttf", display: "Permanent Marker" },

  // Mono: timestamps, code, terminal looks.
  { file: "RobotoMono-Bold.ttf", display: "Roboto Mono", sizeScale: 0.9 },

  // Display faces for the designs.
  { file: "Bangers-Regular.ttf", display: "Bangers", sizeScale: 1.2 },
  { file: "Righteous-Regular.ttf", display: "Righteous" },
  { file: "PressStart2P-Regular.ttf", display: "Press Start 2P", sizeScale: 0.6 },
  { file: "BlackOpsOne-Regular.ttf", display: "Black Ops One" },
  { file: "Monoton-Regular.ttf", display: "Monoton" },
  { file: "Shrikhand-Regular.ttf", display: "Shrikhand" },
  { file: "GreatVibes-Regular.ttf", display: "Great Vibes", sizeScale: 1.3 },
  { file: "AlfaSlabOne-Regular.ttf", display: "Alfa Slab One" },
];

/**
 * Twenty families, each with the three recipes that suit it. Sans faces get
 * the neutral treatments, display faces the loud ones, script faces the ones
 * that do not fight the letterforms.
 */
const RECIPE_TILES: ReadonlyArray<{
  file: string;
  recipes: readonly [RecipeName, RecipeName, RecipeName];
}> = [
  { file: "Roboto-Bold.ttf", recipes: ["clean", "shadowed", "boxed"] },
  { file: "OpenSans-SemiBold.ttf", recipes: ["clean", "boxed", "invert"] },
  { file: "Inter-Bold.ttf", recipes: ["clean", "shadowed", "tracked"] },
  { file: "Poppins-SemiBold.ttf", recipes: ["clean", "gradient", "pop"] },
  { file: "Montserrat-ExtraBold.ttf", recipes: ["outline", "gradient", "hot"] },
  { file: "Raleway-SemiBold.ttf", recipes: ["clean", "tracked", "invert"] },
  { file: "Nunito-Bold.ttf", recipes: ["clean", "shadowed", "pop"] },
  { file: "Oswald-Bold.ttf", recipes: ["outline", "tracked", "hot"] },
  { file: "BebasNeue-Regular.ttf", recipes: ["neon", "tracked", "pop"] },
  { file: "Anton-Regular.ttf", recipes: ["outline", "gradient", "hot"] },
  { file: "ArchivoBlack-Regular.ttf", recipes: ["outline", "invert", "pop"] },
  { file: "PlayfairDisplay-Bold.ttf", recipes: ["clean", "shadowed", "invert"] },
  { file: "Merriweather-Bold.ttf", recipes: ["clean", "boxed", "invert"] },
  { file: "Lora-Bold.ttf", recipes: ["clean", "softItalic", "shadowed"] },
  { file: "AbrilFatface-Regular.ttf", recipes: ["clean", "outline", "hot"] },
  { file: "Pacifico-Regular.ttf", recipes: ["neon", "outline", "pop"] },
  { file: "Lobster-Regular.ttf", recipes: ["clean", "gradient", "hot"] },
  { file: "Caveat-Bold.ttf", recipes: ["clean", "outline", "pop"] },
  { file: "PermanentMarker-Regular.ttf", recipes: ["clean", "outline", "hot"] },
  { file: "RobotoMono-Bold.ttf", recipes: ["neon", "boxed", "tracked"] },
];

type Design = {
  /** The id's second half, `"<family>/<key>"`, and never reused. */
  key: string;
  label: string;
  file: string;
  group: PresetGroup;
  style: PresetStyle;
};

/** A hard offset copy: a shadow with no blur. */
const hard = (x: number, y: number, color: string, opacity = 100) => ({
  offsetX: x,
  offsetY: y,
  blur: 0,
  color,
  opacity,
});

/**
 * Forty looks, each one face and one style.
 *
 * Every one differs from all eleven recipes, and from every other design, in
 * something a viewer can see: a coloured or translucent stroke, a padded or
 * rounded or translucent band, a hard offset shadow, a glow and a shadow
 * together, a new pair of gradient stops, a case change. `textPresets.test.ts`
 * holds that line by comparing normalised styles, so a forty-first that
 * restates an existing look fails there rather than in the panel.
 *
 * Lengths are element-space px against a 1080-pixel-high frame, the unit the
 * recipes have always used; `textPresetOptions.ts` scales them to the frame.
 */
const DESIGNS: readonly Design[] = [
  // Clean
  {
    key: "cinema",
    label: "Cinema",
    file: "Raleway-SemiBold.ttf",
    group: "clean",
    style: { textcolor: "#ece6d6", textTransform: "uppercase", letterSpacing: 18 },
  },
  {
    key: "elegant",
    label: "Elegant",
    file: "GreatVibes-Regular.ttf",
    group: "clean",
    style: { textcolor: "#f7e7ce" },
  },
  {
    key: "whisper",
    label: "Whisper",
    file: "Nunito-Bold.ttf",
    group: "clean",
    style: { textcolor: WHITE, textTransform: "lowercase", textOpacity: 70 },
  },
  {
    key: "stencil",
    label: "Stencil",
    file: "BlackOpsOne-Regular.ttf",
    group: "clean",
    style: { textcolor: "#c8d5b9", textTransform: "uppercase" },
  },
  {
    key: "seventies",
    label: "Seventies",
    file: "Shrikhand-Regular.ttf",
    group: "clean",
    style: { textcolor: "#ff9f1c" },
  },
  {
    key: "seafoam",
    label: "Seafoam",
    file: "Righteous-Regular.ttf",
    group: "clean",
    style: { textcolor: "#7ef2c4" },
  },

  // Outline
  {
    key: "comic",
    label: "Comic",
    file: "Bangers-Regular.ttf",
    group: "outline",
    style: {
      textcolor: "#ffe14d",
      outline: { size: 6, color: INK },
      shadow: hard(5, 5, "#e63946"),
    },
  },
  {
    key: "sticker",
    label: "Sticker",
    file: "Poppins-SemiBold.ttf",
    group: "outline",
    style: {
      textcolor: WHITE,
      outline: { size: 14, color: INK },
      shadow: hard(0, 6, BLACK, 45),
    },
  },
  {
    key: "candy",
    label: "Candy",
    file: "Shrikhand-Regular.ttf",
    group: "outline",
    style: { textcolor: WHITE, outline: { size: 8, color: "#ff6fae" } },
  },
  {
    key: "cyanEdge",
    label: "Cyan Edge",
    file: "Oswald-Bold.ttf",
    group: "outline",
    style: {
      textcolor: WHITE,
      outline: { size: 5, color: "#00c2ff" },
      textTransform: "uppercase",
    },
  },
  {
    key: "limeEdge",
    label: "Lime Edge",
    file: "BebasNeue-Regular.ttf",
    group: "outline",
    style: { textcolor: INK, outline: { size: 6, color: "#c6ff3d" } },
  },
  {
    key: "softEdge",
    label: "Soft Edge",
    file: "Inter-Bold.ttf",
    group: "outline",
    style: { textcolor: WHITE, outline: { size: 10, color: BLACK, opacity: 45 } },
  },
  {
    key: "diner",
    label: "Diner",
    file: "Pacifico-Regular.ttf",
    group: "outline",
    style: { textcolor: "#fff4d6", outline: { size: 10, color: "#e4572e" } },
  },
  {
    key: "gilded",
    label: "Gilded",
    file: "PlayfairDisplay-Bold.ttf",
    group: "outline",
    style: { textcolor: WHITE, outline: { size: 4, color: "#d4af37" } },
  },

  // Box
  {
    key: "caption",
    label: "Caption",
    file: "OpenSans-SemiBold.ttf",
    group: "box",
    style: {
      textcolor: WHITE,
      background: { color: BLACK, opacity: 60, padding: 14, radius: 6 },
    },
  },
  {
    key: "pill",
    label: "Pill",
    file: "Poppins-SemiBold.ttf",
    group: "box",
    style: {
      textcolor: WHITE,
      background: { color: "#7c5cff", padding: 18, radius: 40 },
    },
  },
  {
    key: "tag",
    label: "Tag",
    file: "ArchivoBlack-Regular.ttf",
    group: "box",
    style: {
      textcolor: INK,
      background: { color: ACCENT, radius: 8 },
      textTransform: "uppercase",
    },
  },
  {
    key: "mintPill",
    label: "Mint Pill",
    file: "Nunito-Bold.ttf",
    group: "box",
    style: {
      textcolor: "#0b3d2e",
      background: { color: "#7ef2c4", padding: 18, radius: 40 },
    },
  },
  {
    key: "glass",
    label: "Glass",
    file: "Inter-Bold.ttf",
    group: "box",
    style: {
      textcolor: WHITE,
      background: { color: WHITE, opacity: 18, padding: 16, radius: 12 },
    },
  },
  {
    key: "tape",
    label: "Tape",
    file: "PermanentMarker-Regular.ttf",
    group: "box",
    style: { textcolor: INK, background: { color: "#f5e6a8", padding: 10 } },
  },
  {
    key: "terminal",
    label: "Terminal",
    file: "RobotoMono-Bold.ttf",
    group: "box",
    style: {
      textcolor: "#4dff88",
      background: { color: "#0d1117", opacity: 92, radius: 6 },
    },
  },
  {
    key: "news",
    label: "News",
    file: "Oswald-Bold.ttf",
    group: "box",
    style: {
      textcolor: WHITE,
      background: { color: "#d7263d", padding: 10 },
      textTransform: "uppercase",
      letterSpacing: 2,
    },
  },
  {
    key: "arcade",
    label: "Arcade",
    file: "PressStart2P-Regular.ttf",
    group: "box",
    style: { textcolor: "#ffe600", background: { color: "#1b1464", padding: 14 } },
  },
  {
    key: "card",
    label: "Card",
    file: "Merriweather-Bold.ttf",
    group: "box",
    style: {
      textcolor: "#1d1d1f",
      background: { color: WHITE, padding: 18, radius: 14 },
      shadow: { offsetX: 0, offsetY: 8, blur: 24, color: BLACK, opacity: 50 },
    },
  },

  // Shadow
  {
    key: "retro",
    label: "Retro",
    file: "AlfaSlabOne-Regular.ttf",
    group: "shadow",
    style: { textcolor: "#fff1d0", shadow: hard(6, 6, "#e4572e") },
  },
  {
    key: "pixel",
    label: "Pixel",
    file: "PressStart2P-Regular.ttf",
    group: "shadow",
    style: { textcolor: WHITE, shadow: hard(4, 4, "#ff2e63") },
  },
  {
    key: "violetLift",
    label: "Violet Lift",
    file: "Montserrat-ExtraBold.ttf",
    group: "shadow",
    style: {
      textcolor: WHITE,
      shadow: { offsetX: 0, offsetY: 8, blur: 24, color: "#3a0ca3", opacity: 90 },
    },
  },
  {
    key: "blockShadow",
    label: "Block Shadow",
    file: "Anton-Regular.ttf",
    group: "shadow",
    style: { textcolor: WHITE, shadow: hard(8, 8, BLACK) },
  },
  {
    key: "western",
    label: "Western",
    file: "AlfaSlabOne-Regular.ttf",
    group: "shadow",
    style: {
      textcolor: "#f2c14e",
      outline: { size: 3, color: "#3d2314" },
      shadow: hard(5, 5, "#3d2314"),
      textTransform: "uppercase",
    },
  },
  {
    key: "deep",
    label: "Deep",
    file: "Lora-Bold.ttf",
    group: "shadow",
    style: {
      textcolor: WHITE,
      shadow: { offsetX: 0, offsetY: 12, blur: 36, color: BLACK, opacity: 85 },
    },
  },

  // Glow
  {
    key: "neonTube",
    label: "Neon Tube",
    file: "Monoton-Regular.ttf",
    group: "glow",
    style: { textcolor: "#ffe6fb", glow: { size: 22, color: "#ff2ea6", opacity: 95 } },
  },
  {
    key: "amber",
    label: "Amber",
    file: "Righteous-Regular.ttf",
    group: "glow",
    style: { textcolor: "#fff3c4", glow: { size: 18, color: "#ffb000", opacity: 85 } },
  },
  {
    key: "halo",
    label: "Halo",
    file: "GreatVibes-Regular.ttf",
    group: "glow",
    style: { textcolor: WHITE, glow: { size: 26, color: WHITE, opacity: 55 } },
  },
  {
    key: "acid",
    label: "Acid",
    file: "Inter-Bold.ttf",
    group: "glow",
    style: {
      textcolor: "#eaffd0",
      glow: { size: 20, color: "#39ff14", opacity: 90 },
      textTransform: "uppercase",
    },
  },
  {
    key: "fire",
    label: "Fire",
    file: "Bangers-Regular.ttf",
    group: "glow",
    style: {
      textcolor: "#fff1a8",
      glow: { size: 20, color: "#ff5e00", opacity: 90 },
      shadow: { offsetX: 0, offsetY: 4, blur: 8, color: "#8a1c00", opacity: 80 },
    },
  },

  // Gradient
  {
    key: "sunset",
    label: "Sunset",
    file: "BebasNeue-Regular.ttf",
    group: "gradient",
    style: { textcolor: WHITE, gradient: { from: "#ffb347", to: "#ff5e62", angle: 0 } },
  },
  {
    key: "aqua",
    label: "Aqua",
    file: "Righteous-Regular.ttf",
    group: "gradient",
    style: { textcolor: WHITE, gradient: { from: "#00f5d4", to: "#00bbf9", angle: 90 } },
  },
  {
    key: "chrome",
    label: "Chrome",
    file: "BlackOpsOne-Regular.ttf",
    group: "gradient",
    style: {
      textcolor: WHITE,
      gradient: { from: WHITE, to: "#8e9aa6", angle: 90 },
      outline: { size: 2, color: "#2b2f33" },
    },
  },
  {
    key: "gold",
    label: "Gold",
    file: "PlayfairDisplay-Bold.ttf",
    group: "gradient",
    style: {
      textcolor: WHITE,
      gradient: { from: "#fff3b0", to: "#c8961e", angle: 90 },
      shadow: { offsetX: 0, offsetY: 4, blur: 10, color: BLACK, opacity: 60 },
    },
  },
  {
    key: "vapor",
    label: "Vapor",
    file: "Monoton-Regular.ttf",
    group: "gradient",
    style: {
      textcolor: WHITE,
      gradient: { from: "#ff71ce", to: "#01cdfe", angle: 0 },
      glow: { size: 14, color: "#b967ff", opacity: 60 },
    },
  },
];

/** How many families the panel can show. Exported so the tests can say so. */
export const PRESET_FONT_COUNT = FONTS.length;

/** How many families carry the eleven recipes. */
export const RECIPE_FONT_COUNT = RECIPE_TILES.length;

/** How many designs there are, one tile each. */
export const DESIGN_COUNT = DESIGNS.length;

/** Files the panel expects on disk, for the tests. */
export function presetFontFiles(): string[] {
  return FONTS.map((entry) => entry.file);
}

/** The recipe a recipe tile was built from, or `null` for a design. */
export function recipeStyleOf(name: string): PresetStyle | null {
  return Object.prototype.hasOwnProperty.call(RECIPES, name)
    ? RECIPES[name as RecipeName]
    : null;
}

/** Every recipe's name, for the overlap tests. */
export function recipeNames(): string[] {
  return Object.keys(RECIPES);
}

/** Every recipe's label, for the overlap tests. */
export function recipeLabels(): string[] {
  return Object.values(RECIPE_LABEL);
}

/**
 * Join the lists against the fonts the main process actually listed.
 *
 * Entries whose file is missing are dropped rather than substituted: a tile
 * drawn in a family the document has no face for looks like a bug in the
 * preset, and clicking it would produce a text element that exports in the
 * fallback. Better to show nineteen families than twenty with one lying.
 *
 * Recipe tiles come first, font by font, in the order they always had; the
 * designs follow. The panel regroups both by `group`, keeping this order
 * within a section.
 */
export function buildTextPresets(fonts: readonly FontEntry[]): TextPreset[] {
  const byFile = new Map<string, FontEntry>();
  for (const font of fonts) {
    const segments = font.path.split(/[\\/]/);
    const filename = segments[segments.length - 1] ?? "";
    if (filename) {
      byFile.set(filename, font);
    }
  }

  const presets: TextPreset[] = [];
  for (const entry of allEntries()) {
    const font = byFile.get(entry.file);
    if (font != null) {
      presets.push(presetOf(entry, font));
    }
  }
  return presets;
}

/** One tile before it is joined to a font: what the two lists both describe. */
type Entry = {
  file: string;
  key: string;
  styleLabel: string;
  group: PresetGroup;
  style: PresetStyle;
};

function allEntries(): Entry[] {
  const out: Entry[] = [];
  for (const entry of RECIPE_TILES) {
    for (const recipe of entry.recipes) {
      out.push({
        file: entry.file,
        key: recipe,
        styleLabel: RECIPE_LABEL[recipe],
        group: RECIPE_GROUP[recipe],
        style: RECIPES[recipe],
      });
    }
  }
  for (const design of DESIGNS) {
    out.push({
      file: design.file,
      key: design.key,
      styleLabel: design.label,
      group: design.group,
      style: design.style,
    });
  }
  return out;
}

const SPEC_BY_FILE = new Map(FONTS.map((spec) => [spec.file, spec]));

function stemOf(file: string): string {
  const dot = file.lastIndexOf(".");
  return dot < 0 ? file : file.slice(0, dot);
}

/**
 * The preset an entry makes in `font`. The id keeps the entry's own file stem,
 * so a look rebuilt on a fallback face (`lookPreset`) answers to the same id.
 */
function presetOf(entry: Entry, font: FontEntry): TextPreset {
  const spec = SPEC_BY_FILE.get(entry.file);
  const display = spec?.display ?? stemOf(entry.file);
  return {
    id: `${stemOf(entry.file)}/${entry.key}`,
    label: `${display}, ${entry.styleLabel}`,
    fontLabel: display,
    styleLabel: entry.styleLabel,
    group: entry.group,
    file: entry.file,
    family: font.name,
    path: font.path,
    type: font.type,
    style: {
      ...entry.style,
      ...(spec?.sizeScale != null ? { sizeScale: spec.sizeScale } : {}),
    },
  };
}

/**
 * The preset an animated tile wears, by id.
 *
 * From `presets` when its font was listed; otherwise the same look rebuilt on
 * `fallback`, so the web build, which lists no bundled fonts, still offers
 * every animation, in the app's own face and with the look's colours. `null`
 * only for an id no list describes.
 */
export function lookPreset(
  id: string,
  presets: readonly TextPreset[],
  fallback: FontEntry,
): TextPreset | null {
  const listed = presets.find((preset) => preset.id === id);
  if (listed != null) {
    return listed;
  }
  const entry = allEntries().find(
    (candidate) => `${stemOf(candidate.file)}/${candidate.key}` === id,
  );
  return entry == null ? null : presetOf(entry, fallback);
}

/**
 * Does this preset match a filter query?
 *
 * Every word of the query has to appear somewhere in the label, the family or
 * the section, so "outline", "montserrat", "neon pacifico" and "box" all
 * narrow the panel the way they read.
 */
export function presetMatches(preset: TextPreset, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return true;
  }
  const haystack = [
    preset.label,
    preset.family,
    PRESET_GROUP_LABEL[preset.group],
  ]
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}
