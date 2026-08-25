/**
 * The text presets the "Text" asset panel offers: twenty bundled Google Fonts,
 * three styles each.
 *
 * Two rules shape everything here.
 *
 * **Only properties `renderer/text.ts` actually draws.** A preset is a bag of
 * fields that already have a rendering implementation — `textcolor`,
 * `letterSpacing`, `isBold`/`isItalic`/`align`, `outline`, `background`,
 * `shadow`, `glow`, a gradient fill, and a size multiplier. Nothing here
 * invents a property the canvas ignores, such as a line height, because the
 * panel tile is a CSS re-statement of these same values and an unrendered one
 * would make the tile lie about the result.
 *
 * **The filename stem is the family name.** `parseFontPath` derives it, the
 * element stores it in `fontname`, and `renderText` puts it straight into
 * `ctx.font` where the canvas resolves it as a CSS family. So a manifest entry
 * names a *file*, and `buildTextPresets` joins that against what the main
 * process actually found on disk — a font that failed to download drops out of
 * the panel instead of producing tiles that silently draw in the fallback.
 *
 * Weight comes from the bundled file, not from a property: `renderText` never
 * reads `fontweight`, and the only weight axis `ctx.font` exposes is the binary
 * `bold`. Wanting a heavy Montserrat therefore means bundling
 * `Montserrat-ExtraBold.ttf`, which is what the manifest does.
 */

import type { FontEntry } from "./fontFaces";

export type PresetStyle = {
  textcolor: string;
  /** Stroked with `strokeText` at this width, in element-space px. */
  outline?: { size: number; color: string };
  /** Solid band behind each line, `background.color` on the element. */
  background?: { color: string };
  /** Drop shadow, in element-space px — see `@types/timeline#TextShadow`. */
  shadow?: { offsetX: number; offsetY: number; blur: number; color: string; opacity: number };
  /** Even halo around the glyphs. */
  glow?: { size: number; color: string; opacity: number };
  /** Gradient glyph fill. Omitted means the flat `textcolor`. */
  gradient?: { from: string; to: string; angle: number };
  letterSpacing?: number;
  isBold?: boolean;
  isItalic?: boolean;
  align?: "left" | "center" | "right";
  /**
   * Multiplier on the resolution-derived base font size. Display faces carry a
   * title at a larger size than a body serif wants; script faces read small.
   */
  sizeScale?: number;
};

export type TextPreset = {
  /** Stable across runs — `"Montserrat-ExtraBold/outline"`. */
  id: string;
  /** Both halves, for the tooltip and the search. */
  label: string;
  /** The Google Fonts family — the tile's first label line. */
  fontLabel: string;
  /** The style archetype — the tile's second label line. */
  styleLabel: string;
  /** Filename inside `assets/fonts/google`, joined against the real listing. */
  file: string;
  /** CSS family name — the file's stem, and the element's `fontname`. */
  family: string;
  /** Absolute path on disk, filled in by `buildTextPresets`. */
  path: string;
  /** Extension, for `@font-face`'s `format()`. */
  type: string;
  style: PresetStyle;
};

const WHITE = "#ffffff";
const INK = "#111111";
const ACCENT = "#ffd93d";
const HOT = "#ff4d6d";
const NEON = "#4dfff0";

/**
 * The style archetypes, named so the manifest below reads as an assignment
 * rather than a wall of colour literals.
 */
const RECIPES = {
  clean: { textcolor: WHITE },
  outline: { textcolor: WHITE, outline: { size: 8, color: "#000000" } },
  boxed: { textcolor: WHITE, background: { color: "#000000" } },
  invert: { textcolor: INK, background: { color: WHITE } },
  pop: { textcolor: ACCENT, outline: { size: 6, color: "#000000" } },
  hot: { textcolor: WHITE, background: { color: HOT } },
  tracked: { textcolor: WHITE, letterSpacing: 8, align: "center" },
  softItalic: { textcolor: "#f2efe9", isItalic: true },
  shadowed: {
    textcolor: WHITE,
    shadow: { offsetX: 4, offsetY: 6, blur: 14, color: "#000000", opacity: 65 },
  },
  neon: {
    textcolor: NEON,
    glow: { size: 20, color: NEON, opacity: 90 },
  },
  gradient: {
    textcolor: WHITE,
    gradient: { from: "#ffd93d", to: "#ff4d6d", angle: 90 },
    outline: { size: 3, color: "#000000" },
  },
} as const satisfies Record<string, PresetStyle>;

type RecipeName = keyof typeof RECIPES;

type ManifestEntry = {
  file: string;
  /** Human name for the tile — the Google Fonts family, not the file stem. */
  display: string;
  sizeScale?: number;
  /** Exactly three, in the order they appear in the panel. */
  recipes: readonly [RecipeName, RecipeName, RecipeName];
};

/**
 * Recipe labels, in English and only in English.
 *
 * Deliberately not routed through `LocaleController`: these sit directly under
 * a Latin-only type specimen, next to a Latin family name. A localised style
 * label would put Hangul beside an `Aa` that cannot render Hangul, which reads
 * as the tile lying about the face.
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

/**
 * Twenty families, each with the three styles that suit it. Sans faces get the
 * neutral treatments, display faces the loud ones, script faces the ones that
 * do not fight the letterforms.
 */
const MANIFEST: readonly ManifestEntry[] = [
  // Sans — the workhorses.
  {
    file: "Roboto-Bold.ttf",
    display: "Roboto",
    recipes: ["clean", "shadowed", "boxed"],
  },
  {
    file: "OpenSans-SemiBold.ttf",
    display: "Open Sans",
    recipes: ["clean", "boxed", "invert"],
  },
  {
    file: "Inter-Bold.ttf",
    display: "Inter",
    recipes: ["clean", "shadowed", "tracked"],
  },
  {
    file: "Poppins-SemiBold.ttf",
    display: "Poppins",
    recipes: ["clean", "gradient", "pop"],
  },
  {
    file: "Montserrat-ExtraBold.ttf",
    display: "Montserrat",
    sizeScale: 1.05,
    recipes: ["outline", "gradient", "hot"],
  },
  {
    file: "Raleway-SemiBold.ttf",
    display: "Raleway",
    recipes: ["clean", "tracked", "invert"],
  },
  {
    file: "Nunito-Bold.ttf",
    display: "Nunito",
    recipes: ["clean", "shadowed", "pop"],
  },

  // Condensed and display — titles and thumbnails.
  {
    file: "Oswald-Bold.ttf",
    display: "Oswald",
    sizeScale: 1.15,
    recipes: ["outline", "tracked", "hot"],
  },
  {
    file: "BebasNeue-Regular.ttf",
    display: "Bebas Neue",
    sizeScale: 1.25,
    recipes: ["neon", "tracked", "pop"],
  },
  {
    file: "Anton-Regular.ttf",
    display: "Anton",
    sizeScale: 1.2,
    recipes: ["outline", "gradient", "hot"],
  },
  {
    file: "ArchivoBlack-Regular.ttf",
    display: "Archivo Black",
    sizeScale: 1.1,
    recipes: ["outline", "invert", "pop"],
  },

  // Serif — titles with some weight to them.
  {
    file: "PlayfairDisplay-Bold.ttf",
    display: "Playfair Display",
    recipes: ["clean", "shadowed", "invert"],
  },
  {
    file: "Merriweather-Bold.ttf",
    display: "Merriweather",
    recipes: ["clean", "boxed", "invert"],
  },
  {
    file: "Lora-Bold.ttf",
    display: "Lora",
    recipes: ["clean", "softItalic", "shadowed"],
  },
  {
    file: "AbrilFatface-Regular.ttf",
    display: "Abril Fatface",
    sizeScale: 1.1,
    recipes: ["clean", "outline", "hot"],
  },

  // Script and hand — captions with a voice.
  {
    file: "Pacifico-Regular.ttf",
    display: "Pacifico",
    sizeScale: 0.95,
    recipes: ["neon", "outline", "pop"],
  },
  {
    file: "Lobster-Regular.ttf",
    display: "Lobster",
    recipes: ["clean", "gradient", "hot"],
  },
  {
    file: "Caveat-Bold.ttf",
    display: "Caveat",
    sizeScale: 1.15,
    recipes: ["clean", "outline", "pop"],
  },
  {
    file: "PermanentMarker-Regular.ttf",
    display: "Permanent Marker",
    recipes: ["clean", "outline", "hot"],
  },

  // Mono — timestamps, code, terminal looks.
  {
    file: "RobotoMono-Bold.ttf",
    display: "Roboto Mono",
    sizeScale: 0.9,
    recipes: ["neon", "boxed", "tracked"],
  },
];

/** How many families the manifest describes. Exported so the panel can say so. */
export const PRESET_FONT_COUNT = MANIFEST.length;

/** Files the manifest expects on disk, for the fetch script and the tests. */
export function presetFontFiles(): string[] {
  return MANIFEST.map((entry) => entry.file);
}

/**
 * Join the manifest against the fonts the main process actually listed.
 *
 * Entries whose file is missing are dropped rather than substituted: a tile
 * drawn in a family the document has no face for looks like a bug in the
 * preset, and clicking it would produce a text element that exports in the
 * fallback. Better to show nineteen families than twenty with one lying.
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
  for (const entry of MANIFEST) {
    const font = byFile.get(entry.file);
    if (font == null) {
      continue;
    }

    for (const recipe of entry.recipes) {
      presets.push({
        id: `${font.name}/${recipe}`,
        label: `${entry.display} · ${RECIPE_LABEL[recipe]}`,
        fontLabel: entry.display,
        styleLabel: RECIPE_LABEL[recipe],
        file: entry.file,
        family: font.name,
        path: font.path,
        type: font.type,
        style: {
          ...RECIPES[recipe],
          ...(entry.sizeScale != null ? { sizeScale: entry.sizeScale } : {}),
        },
      });
    }
  }

  return presets;
}

/**
 * Does this preset match a filter query?
 *
 * Matches the display label and the family, so both "montserrat" and "outline"
 * narrow the panel.
 */
export function presetMatches(preset: TextPreset, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  return (
    preset.label.toLowerCase().includes(needle) ||
    preset.family.toLowerCase().includes(needle)
  );
}
