import { describe, it, expect } from "vitest";
import {
  buildTextPresets,
  presetFontFiles,
  presetMatches,
  PRESET_FONT_COUNT,
} from "./textPresets";
import type { FontEntry } from "./fontFaces";

/** What `font:getPresetFontLists` returns for a complete `assets/fonts/google`. */
function allFonts(): FontEntry[] {
  return presetFontFiles().map((file) => ({
    path: `/Resources/assets/fonts/google/${file}`,
    name: file.slice(0, file.lastIndexOf(".")),
    type: file.slice(file.lastIndexOf(".") + 1),
  }));
}

describe("the preset manifest", () => {
  it("describes twenty families", () => {
    expect(PRESET_FONT_COUNT).toBe(20);
    expect(presetFontFiles()).toHaveLength(20);
  });

  it("names each font file once", () => {
    const files = presetFontFiles();
    expect(new Set(files).size).toBe(files.length);
  });
});

describe("buildTextPresets", () => {
  it("produces three presets per bundled font", () => {
    const presets = buildTextPresets(allFonts());

    expect(presets).toHaveLength(PRESET_FONT_COUNT * 3);

    const perFamily = new Map<string, number>();
    for (const preset of presets) {
      perFamily.set(preset.family, (perFamily.get(preset.family) ?? 0) + 1);
    }
    expect([...perFamily.values()].every((n) => n === 3)).toBe(true);
  });

  it("gives every preset a distinct id", () => {
    const ids = buildTextPresets(allFonts()).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
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
    // A partial checkout, or a download that failed. Three tiles disappear;
    // none of the survivors point at a face the document cannot resolve.
    const fonts = allFonts().filter(
      (f) => !f.path.endsWith("Pacifico-Regular.ttf"),
    );
    const presets = buildTextPresets(fonts);

    expect(presets).toHaveLength((PRESET_FONT_COUNT - 1) * 3);
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
    // The specimens are Latin-only; a Hangul label under an `Aa` that cannot
    // render Hangul misrepresents the face. Pins the rule against a future
    // well-meaning pass through `LocaleController`. The separator "·" is
    // typography, not language, so this looks for Hangul rather than for
    // anything outside ASCII.
    const hangul = /[ᄀ-ᇿ㄰-㆏가-힯]/;

    for (const preset of buildTextPresets(allFonts())) {
      expect(hangul.test(preset.label)).toBe(false);
      expect(hangul.test(preset.fontLabel)).toBe(false);
      expect(hangul.test(preset.styleLabel)).toBe(false);
    }
  });

  it("offers each of the effect recipes somewhere in the panel", () => {
    // The effects are only discoverable if some tile shows them off.
    const presets = buildTextPresets(allFonts());

    for (const recipe of ["shadowed", "neon", "gradient"]) {
      expect(presets.some((p) => p.id.endsWith(`/${recipe}`))).toBe(true);
    }
  });

  it("gives every effect recipe the fields its renderer needs", () => {
    // A `gradient` recipe with no `from`/`to`, or a `shadow` with no colour,
    // would resolve back to a plain fill and the tile would quietly lie.
    for (const preset of buildTextPresets(allFonts())) {
      if (preset.id.endsWith("/shadowed")) {
        expect(preset.style.shadow).toMatchObject({
          blur: expect.any(Number),
          color: expect.any(String),
        });
      }
      if (preset.id.endsWith("/neon")) {
        expect(preset.style.glow?.size).toBeGreaterThan(0);
      }
      if (preset.id.endsWith("/gradient")) {
        expect(preset.style.gradient?.from).not.toBe(
          preset.style.gradient?.to,
        );
      }
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
      "sizeScale",
    ]);

    for (const preset of buildTextPresets(allFonts())) {
      for (const key of Object.keys(preset.style)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });
});

describe("presetMatches", () => {
  const preset = buildTextPresets(allFonts()).find(
    (p) => p.family === "Montserrat-ExtraBold",
  )!;

  it("matches an empty query", () => {
    expect(presetMatches(preset, "   ")).toBe(true);
  });

  it("matches the display name case-insensitively", () => {
    expect(presetMatches(preset, "MONT")).toBe(true);
  });

  it("matches the style label", () => {
    const outlined = buildTextPresets(allFonts()).find((p) =>
      p.id.endsWith("/outline"),
    )!;
    expect(presetMatches(outlined, "outline")).toBe(true);
  });

  it("rejects a query that appears nowhere", () => {
    expect(presetMatches(preset, "helvetica")).toBe(false);
  });
});
