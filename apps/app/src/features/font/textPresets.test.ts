import { describe, it, expect } from "vitest";
import {
  DESIGN_COUNT,
  PRESET_FONT_COUNT,
  PRESET_GROUPS,
  RECIPE_FONT_COUNT,
  buildTextPresets,
  lookPreset,
  presetFontFiles,
  presetMatches,
  recipeLabels,
  recipeNames,
  recipeStyleOf,
  type PresetStyle,
  type TextPreset,
} from "./textPresets";
import { DEFAULT_FONT, type FontEntry } from "./fontFaces";

/** What `font:getPresetFontLists` returns for a complete `assets/fonts/google`. */
function allFonts(): FontEntry[] {
  return presetFontFiles().map((file) => ({
    path: `/Resources/assets/fonts/google/${file}`,
    name: file.slice(0, file.lastIndexOf(".")),
    type: file.slice(file.lastIndexOf(".") + 1),
  }));
}

const isRecipe = (preset: TextPreset) =>
  recipeNames().includes(preset.id.slice(preset.id.indexOf("/") + 1));

/**
 * A style as a comparable string: keys sorted, `sizeScale` dropped (it belongs
 * to the face, not the look), and every default spelled out as absence.
 */
function lookOf(style: PresetStyle): string {
  const { sizeScale: _size, ...rest } = style;
  const sorted = (value: unknown): unknown => {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
    );
  };
  return JSON.stringify(sorted(rest));
}

describe("the font list", () => {
  it("describes twenty-eight families, twenty of them carrying the recipes", () => {
    expect(PRESET_FONT_COUNT).toBe(28);
    expect(presetFontFiles()).toHaveLength(28);
    expect(RECIPE_FONT_COUNT).toBe(20);
  });

  it("names each font file once", () => {
    const files = presetFontFiles();
    expect(new Set(files).size).toBe(files.length);
  });
});

describe("buildTextPresets", () => {
  it("produces the sixty recipe tiles and the forty designs", () => {
    const presets = buildTextPresets(allFonts());

    expect(DESIGN_COUNT).toBe(40);
    expect(presets.filter(isRecipe)).toHaveLength(60);
    expect(presets.filter((p) => !isRecipe(p))).toHaveLength(40);
    expect(presets).toHaveLength(100);
  });

  it("gives each of the twenty recipe families exactly three recipe tiles", () => {
    const perFamily = new Map<string, number>();
    for (const preset of buildTextPresets(allFonts()).filter(isRecipe)) {
      perFamily.set(preset.family, (perFamily.get(preset.family) ?? 0) + 1);
    }
    expect(perFamily.size).toBe(20);
    expect([...perFamily.values()].every((n) => n === 3)).toBe(true);
  });

  it("keeps every recipe tile's id and style as it was", () => {
    // The sixty were the whole panel before the designs; a user knows them by
    // sight. Pinned by example rather than restated in full.
    const byId = new Map(buildTextPresets(allFonts()).map((p) => [p.id, p]));

    expect(byId.get("Montserrat-ExtraBold/outline")?.style).toEqual({
      textcolor: "#ffffff",
      outline: { size: 8, color: "#000000" },
      sizeScale: 1.05,
    });
    expect(byId.get("RobotoMono-Bold/neon")?.style).toEqual({
      textcolor: "#4dfff0",
      glow: { size: 20, color: "#4dfff0", opacity: 90 },
      sizeScale: 0.9,
    });
    expect(byId.get("Lora-Bold/softItalic")?.style).toEqual({
      textcolor: "#f2efe9",
      isItalic: true,
    });
    for (const preset of byId.values()) {
      if (isRecipe(preset)) {
        const recipe = preset.id.slice(preset.id.indexOf("/") + 1);
        expect(lookOf(preset.style)).toBe(lookOf(recipeStyleOf(recipe)!));
      }
    }
  });

  it("gives every preset a distinct id", () => {
    const ids = buildTextPresets(allFonts()).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("files every preset under a known section", () => {
    for (const preset of buildTextPresets(allFonts())) {
      expect(PRESET_GROUPS).toContain(preset.group);
    }
  });

  it("carries the family, path and type through from the listing", () => {
    const preset = buildTextPresets(allFonts()).find(
      (p) => p.file === "Anton-Regular.ttf",
    );

    expect(preset).toMatchObject({
      family: "Anton-Regular",
      path: "/Resources/assets/fonts/google/Anton-Regular.ttf",
      type: "ttf",
    });
  });

  it("drops a family whose file is missing rather than substituting one", () => {
    // A partial checkout, or a download that failed. Pacifico's three recipe
    // tiles and its one design disappear; none of the survivors point at a
    // face the document cannot resolve.
    const fonts = allFonts().filter(
      (f) => !f.path.endsWith("Pacifico-Regular.ttf"),
    );
    const presets = buildTextPresets(fonts);

    expect(presets).toHaveLength(100 - 3 - 1);
    expect(presets.some((p) => p.file === "Pacifico-Regular.ttf")).toBe(false);
  });

  it("returns nothing when the fonts have not been fetched at all", () => {
    expect(buildTextPresets([])).toEqual([]);
  });

  it("matches on the filename, so an unrelated system font cannot stand in", () => {
    const presets = buildTextPresets([
      { path: "/Library/Fonts/Anton.ttf", name: "Anton", type: "ttf" },
    ]);

    expect(presets).toEqual([]);
  });

  it("labels every tile in English, never the app's locale", () => {
    // The specimens are Latin-only; a Hangul label under lettering that
    // cannot render Hangul misrepresents the face. Pins the rule against a
    // future well-meaning pass through `LocaleController`.
    const hangul = /[ᄀ-ᇿ㄰-㆏가-힯]/;

    for (const preset of buildTextPresets(allFonts())) {
      expect(hangul.test(preset.label)).toBe(false);
      expect(hangul.test(preset.fontLabel)).toBe(false);
      expect(hangul.test(preset.styleLabel)).toBe(false);
    }
  });

  it("writes no em-dash or middle dot into a label", () => {
    for (const preset of buildTextPresets(allFonts())) {
      expect(preset.label).not.toMatch(/[\u2014\u00b7]/);
      expect(preset.label).toBe(`${preset.fontLabel}, ${preset.styleLabel}`);
    }
  });

  it("offers each of the effect recipes somewhere in the panel", () => {
    // The effects are only discoverable if some tile shows them off.
    const presets = buildTextPresets(allFonts());

    for (const recipe of ["shadowed", "neon", "gradient"]) {
      expect(presets.some((p) => p.id.endsWith(`/${recipe}`))).toBe(true);
    }
  });

  it("gives every effect the fields its renderer needs", () => {
    // A gradient with no `from`/`to`, or a shadow with no colour, would
    // resolve back to a plain fill and the tile would quietly lie.
    for (const preset of buildTextPresets(allFonts())) {
      const { shadow, glow, gradient, background, outline } = preset.style;
      if (shadow) {
        expect(shadow).toMatchObject({
          offsetX: expect.any(Number),
          offsetY: expect.any(Number),
          blur: expect.any(Number),
          color: expect.stringMatching(/^#[0-9a-f]{6}$/),
          opacity: expect.any(Number),
        });
      }
      if (glow) {
        expect(glow.size).toBeGreaterThan(0);
      }
      if (gradient) {
        expect(gradient.from).not.toBe(gradient.to);
      }
      if (outline) {
        expect(outline.size).toBeGreaterThan(0);
      }
      // `withAlpha` reads `#rgb` and `#rrggbb` only, and every one of these
      // can be paired with an opacity.
      for (const color of [
        preset.style.textcolor,
        shadow?.color,
        glow?.color,
        background?.color,
        outline?.color,
      ]) {
        if (color != null) {
          expect(color).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  it("never states a default, so the element stores nothing it need not", () => {
    for (const preset of buildTextPresets(allFonts())) {
      const { background, outline, textOpacity } = preset.style;
      expect(background?.opacity).not.toBe(100);
      expect(background?.padding).not.toBe(12);
      expect(background?.radius).not.toBe(0);
      expect(outline?.opacity).not.toBe(100);
      expect(textOpacity).not.toBe(100);
    }
  });

  it("only uses style properties the canvas renderer draws", () => {
    const allowed = new Set([
      "textcolor",
      "outline",
      "background",
      "shadow",
      "glow",
      "gradient",
      "letterSpacing",
      "isBold",
      "isItalic",
      "align",
      "textTransform",
      "textOpacity",
      "sizeScale",
    ]);

    for (const preset of buildTextPresets(allFonts())) {
      for (const key of Object.keys(preset.style)) {
        expect(allowed.has(key)).toBe(true);
      }
      for (const key of Object.keys(preset.style.background ?? {})) {
        // No `blur`: a tile has no picture behind it to frost.
        expect(["color", "opacity", "padding", "radius"]).toContain(key);
      }
    }
  });
});

describe("the forty designs", () => {
  const presets = buildTextPresets(allFonts());
  const designs = presets.filter((p) => !isRecipe(p));

  it("are compared by a key that sees a restated look", () => {
    // The two tests below are only as good as `lookOf`: a recipe written out
    // again in another key order, at another size, has to collide, and one
    // colour changed has to not.
    const outline = recipeStyleOf("outline")!;
    const restated: PresetStyle = {
      outline: { color: "#000000", size: 8 },
      textcolor: "#ffffff",
      sizeScale: 1.3,
    };
    expect(lookOf(restated)).toBe(lookOf(outline));
    expect(lookOf({ ...restated, textcolor: "#fffffe" })).not.toBe(lookOf(outline));
  });

  it("repeat none of the eleven recipes", () => {
    const recipes = new Set(recipeNames().map((name) => lookOf(recipeStyleOf(name)!)));
    for (const design of designs) {
      expect(recipes.has(lookOf(design.style)), design.id).toBe(false);
    }
  });

  it("repeat no other design's look", () => {
    const seen = new Map<string, string>();
    for (const preset of presets.filter((p) => !isRecipe(p))) {
      const look = lookOf(preset.style);
      expect(seen.get(look), `${preset.id} looks like ${seen.get(look)}`).toBeUndefined();
      seen.set(look, preset.id);
    }
  });

  it("are named apart from the recipes and from each other", () => {
    const names = designs.map((d) => d.styleLabel);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(recipeLabels()).not.toContain(name);
    }
  });

  it("put every new face to use", () => {
    const newFaces = presetFontFiles().slice(RECIPE_FONT_COUNT);
    expect(newFaces).toHaveLength(8);
    for (const file of newFaces) {
      expect(designs.some((d) => d.file === file), file).toBe(true);
    }
  });
});

describe("lookPreset", () => {
  const presets = buildTextPresets(allFonts());

  it("answers a listed preset as listed", () => {
    expect(lookPreset("Bangers-Regular/comic", presets, DEFAULT_FONT)).toBe(
      presets.find((p) => p.id === "Bangers-Regular/comic"),
    );
  });

  it("rebuilds a look on the fallback face when its own was not listed", () => {
    const look = lookPreset("Bangers-Regular/comic", [], DEFAULT_FONT);

    expect(look).toMatchObject({
      id: "Bangers-Regular/comic",
      family: DEFAULT_FONT.name,
      path: DEFAULT_FONT.path,
      styleLabel: "Comic",
    });
    expect(look?.style.textcolor).toBe("#ffe14d");
  });

  it("answers null for an id nothing describes", () => {
    expect(lookPreset("Nope/none", presets, DEFAULT_FONT)).toBeNull();
  });
});

describe("presetMatches", () => {
  const presets = buildTextPresets(allFonts());
  const preset = presets.find((p) => p.family === "Montserrat-ExtraBold")!;

  it("matches an empty query", () => {
    expect(presetMatches(preset, "   ")).toBe(true);
  });

  it("matches the display name case-insensitively", () => {
    expect(presetMatches(preset, "MONT")).toBe(true);
  });

  it("matches the style label", () => {
    const outlined = presets.find((p) => p.id.endsWith("/outline"))!;
    expect(presetMatches(outlined, "outline")).toBe(true);
  });

  it("matches the section", () => {
    const boxed = presets.find((p) => p.id === "Poppins-SemiBold/pill")!;
    expect(presetMatches(boxed, "box")).toBe(true);
  });

  it("needs every word, wherever each one is", () => {
    const neon = presets.find((p) => p.id === "Pacifico-Regular/neon")!;
    expect(presetMatches(neon, "neon pacifico")).toBe(true);
    expect(presetMatches(neon, "pacifico outline")).toBe(false);
  });

  it("rejects a query that appears nowhere", () => {
    expect(presetMatches(preset, "helvetica")).toBe(false);
  });
});
