import { describe, expect, it } from "vitest";
import {
  DEFAULT_FONT_WEIGHT,
  FONT_WEIGHTS,
  coerceFontWeight,
  faceFor,
  groupFontFamilies,
  labelForWeight,
  elementFontWeight,
  fontWeightToken,
  normalizeFontWeight,
  parseFaceName,
} from "./fontWeight";
import type { FontEntry } from "./fontFaces";

function entry(name: string): FontEntry {
  return { path: `/Library/Fonts/${name}.ttf`, name, type: "ttf" };
}

describe("parseFaceName", () => {
  it("peels a weight suffix off the family", () => {
    expect(parseFaceName("AktivGrotesk-Bold")).toEqual({
      family: "AktivGrotesk",
      weight: 700,
      italic: false,
      variable: false,
    });
  });

  it("reads a weight and a slant run together", () => {
    expect(parseFaceName("AktivGrotesk-SemiBoldItalic")).toEqual({
      family: "AktivGrotesk",
      weight: 600,
      italic: true,
      variable: false,
    });
  });

  it.each([
    ["Roboto-Thin", 100],
    ["Roboto-Hairline", 100],
    ["Roboto-ExtraLight", 200],
    ["Roboto-UltraLight", 200],
    ["Roboto-Light", 300],
    ["Roboto-Regular", 400],
    ["Roboto-Book", 400],
    ["Roboto-Roman", 400],
    ["Roboto-Medium", 500],
    ["Roboto-SemiBold", 600],
    ["Roboto-DemiBold", 600],
    ["Roboto-Demi", 600],
    ["Roboto-Bold", 700],
    ["Roboto-ExtraBold", 800],
    ["Roboto-XBold", 800],
    ["Roboto-Black", 900],
    ["Roboto-Heavy", 900],
  ])("reads %s as %i", (stem, weight) => {
    expect(parseFaceName(stem).weight).toBe(weight);
  });

  it.each(["Roboto-Bold", "Roboto Bold", "Roboto_Bold", "roboto-bold"])(
    "does not care which separator or case %s uses",
    (stem) => {
      expect(parseFaceName(stem).weight).toBe(700);
    },
  );

  it("defaults an unsuffixed face to regular upright", () => {
    expect(parseFaceName("Georgia")).toEqual({
      family: "Georgia",
      weight: DEFAULT_FONT_WEIGHT,
      italic: false,
      variable: false,
    });
  });

  /**
   * The rule the whole parser turns on. Scanning the stem for a weight word
   * anywhere would invent a family called `Archivo` that is not installed.
   */
  it("stops at the first token it does not recognise", () => {
    expect(parseFaceName("ArchivoBlack-Regular").family).toBe("ArchivoBlack");
    expect(parseFaceName("BebasNeue-Regular").family).toBe("BebasNeue");
  });

  it("keeps a width in the family name, because a width is not a weight", () => {
    expect(parseFaceName("Avenir Next Condensed").family).toBe(
      "Avenir Next Condensed",
    );
    expect(parseFaceName("Arial Narrow Bold")).toEqual({
      family: "Arial Narrow",
      weight: 700,
      italic: false,
      variable: false,
    });
  });

  it("never strips the last token, so a font called Bold keeps its name", () => {
    expect(parseFaceName("Bold")).toEqual({
      family: "Bold",
      weight: DEFAULT_FONT_WEIGHT,
      italic: false,
      variable: false,
    });
  });

  it("recognises a variable font by its axis suffix", () => {
    expect(parseFaceName("NotoSerifKR-VariableFont_wght")).toEqual({
      family: "NotoSerifKR",
      weight: DEFAULT_FONT_WEIGHT,
      italic: false,
      variable: true,
    });
  });

  it("recognises one run together with the family name", () => {
    expect(parseFaceName("PretendardVariable")).toEqual({
      family: "Pretendard",
      weight: DEFAULT_FONT_WEIGHT,
      italic: false,
      variable: true,
    });
  });

  it("does not mistake an ordinary family for a variable one", () => {
    expect(parseFaceName("Variable").variable).toBe(false);
    expect(parseFaceName("Variable").family).toBe("Variable");
  });
});

describe("groupFontFamilies", () => {
  const files = [
    "AktivGrotesk-Thin",
    "AktivGrotesk-Regular",
    "AktivGrotesk-Bold",
    "AktivGrotesk-BoldItalic",
    "Georgia",
    "ArchivoBlack-Regular",
  ].map(entry);

  it("folds every face of a family into one entry", () => {
    const families = groupFontFamilies(files);
    const aktiv = families.find((f) => f.family === "AktivGrotesk");

    expect(aktiv?.faces).toHaveLength(4);
    expect(aktiv?.weights).toEqual([100, 400, 700]);
  });

  it("leaves a single-face family with exactly one weight", () => {
    const families = groupFontFamilies(files);

    expect(families.find((f) => f.family === "Georgia")?.weights).toEqual([400]);
    expect(
      families.find((f) => f.family === "ArchivoBlack")?.weights,
    ).toEqual([400]);
  });

  /**
   * A rung that exists only as an italic cannot be delivered: the panel asks
   * `faceFor` for an upright face, which would answer with a different weight.
   * Offering it would be offering a choice that does nothing.
   */
  it("offers only the weights it has an upright face for", () => {
    const families = groupFontFamilies(
      ["Foo-Regular", "Foo-BoldItalic", "Foo-Light"].map(entry),
    );

    expect(families[0].weights).toEqual([300, 400]);
    // And the rung it does not offer is exactly the one that would mis-resolve.
    expect(faceFor(families[0], 700, false)?.entry.name).toBe("Foo-Regular");
  });

  it("keeps its own weights when a family is italic all the way through", () => {
    const families = groupFontFamilies(
      ["Bar-Italic", "Bar-BoldItalic"].map(entry),
    );

    expect(families[0].weights).toEqual([400, 700]);
  });

  it("gives a variable family the whole ladder from one file", () => {
    const families = groupFontFamilies([entry("PretendardVariable")]);

    expect(families[0].variable).toBe(true);
    expect(families[0].weights).toEqual(FONT_WEIGHTS.map((r) => r.weight));
  });

  it("treats one family spelled two ways as one family", () => {
    const families = groupFontFamilies([entry("Helvetica"), entry("helvetica")]);

    expect(families).toHaveLength(1);
    // The first spelling seen is the one shown.
    expect(families[0].family).toBe("Helvetica");
  });

  it("sorts by family name and ignores nameless entries", () => {
    const families = groupFontFamilies([
      entry("Zapfino"),
      { path: "/x", name: "", type: "ttf" },
      entry("Arial"),
    ]);

    expect(families.map((f) => f.family)).toEqual(["Arial", "Zapfino"]);
  });

  it("survives an empty list", () => {
    expect(groupFontFamilies([])).toEqual([]);
  });
});

describe("faceFor", () => {
  const aktiv = groupFontFamilies(
    [
      "AktivGrotesk-Thin",
      "AktivGrotesk-Regular",
      "AktivGrotesk-Italic",
      "AktivGrotesk-Bold",
      "AktivGrotesk-BoldItalic",
    ].map(entry),
  )[0];

  it("returns the exact face when the family ships it", () => {
    expect(faceFor(aktiv, 700)?.entry.name).toBe("AktivGrotesk-Bold");
    expect(faceFor(aktiv, 100)?.entry.name).toBe("AktivGrotesk-Thin");
  });

  it("prefers a real slanted face over an upright one", () => {
    expect(faceFor(aktiv, 700, true)?.entry.name).toBe(
      "AktivGrotesk-BoldItalic",
    );
  });

  /**
   * The renderer can thicken a face and cannot un-slant one, so the slant
   * outranks any distance along the ladder.
   */
  it("takes a distant italic over a near upright", () => {
    const noBoldItalic = groupFontFamilies(
      ["Foo-Italic", "Foo-Bold", "Foo-Regular"].map(entry),
    )[0];

    expect(faceFor(noBoldItalic, 700, true)?.entry.name).toBe("Foo-Italic");
  });

  it("falls back to upright when the family has no italics", () => {
    const uprightOnly = groupFontFamilies(["Bar-Bold", "Bar-Regular"].map(entry))[0];

    expect(faceFor(uprightOnly, 700, true)?.entry.name).toBe("Bar-Bold");
  });

  it("takes the nearest rung when the weight is not shipped", () => {
    // 500 is absent; 400 and 700 are both two rungs away by value, and the
    // heavier one wins the tie.
    const gap = groupFontFamilies(["Baz-Regular", "Baz-Bold"].map(entry))[0];

    expect(faceFor(gap, 550)?.entry.name).toBe("Baz-Bold");
    expect(faceFor(gap, 450)?.entry.name).toBe("Baz-Regular");
  });

  it("answers the same file for every weight of a variable family", () => {
    const variable = groupFontFamilies([entry("PretendardVariable")])[0];

    for (const rung of FONT_WEIGHTS) {
      expect(faceFor(variable, rung.weight)?.entry.name).toBe(
        "PretendardVariable",
      );
    }
  });

  it("prefers the variable file over a static one in the same family", () => {
    const mixed = groupFontFamilies(
      [entry("PretendardVariable"), entry("Pretendard-Bold")].map((e) => e),
    )[0];

    expect(faceFor(mixed, 700)?.entry.name).toBe("PretendardVariable");
  });

  it("answers null rather than throwing for a family it has never heard of", () => {
    expect(faceFor(null, 400)).toBeNull();
    expect(faceFor(undefined, 400)).toBeNull();
  });
});

describe("normalizeFontWeight", () => {
  /**
   * The load-bearing case. `element/textElement.ts` wrote `"medium"` into
   * every text clip the app ever made and no renderer read it, so honouring it
   * as 500 now would re-weight every caption in every existing project.
   */
  it.each(["medium", "normal", "bold", "", "  ", null, undefined, {}, NaN])(
    "reads %s as regular, so a project written before this is unchanged",
    (value) => {
      expect(normalizeFontWeight(value)).toBe(DEFAULT_FONT_WEIGHT);
    },
  );

  it("reads a number, however it was stored", () => {
    expect(normalizeFontWeight(700)).toBe(700);
    expect(normalizeFontWeight("700")).toBe(700);
    expect(normalizeFontWeight(" 700 ")).toBe(700);
  });

  it("reads a value that names no weight as regular", () => {
    expect(normalizeFontWeight(0)).toBe(DEFAULT_FONT_WEIGHT);
    expect(normalizeFontWeight(-50)).toBe(DEFAULT_FONT_WEIGHT);
    expect(normalizeFontWeight(Infinity)).toBe(DEFAULT_FONT_WEIGHT);
  });

  it("clamps the top of the range rather than throwing", () => {
    expect(normalizeFontWeight(4000)).toBe(1000);
  });
});

describe("coerceFontWeight", () => {
  it("snaps to the ladder, since that is all the picker can show back", () => {
    expect(coerceFontWeight(437)).toBe(400);
    expect(coerceFontWeight(660)).toBe(700);
    expect(coerceFontWeight(1000)).toBe(900);
  });

  it("leaves a rung alone", () => {
    for (const rung of FONT_WEIGHTS) {
      expect(coerceFontWeight(rung.weight)).toBe(rung.weight);
    }
  });
});

describe("labelForWeight", () => {
  it("names every rung", () => {
    expect(labelForWeight(400)).toBe("Regular");
    expect(labelForWeight(900)).toBe("Black");
  });

  it("falls back to the number for anything off the ladder", () => {
    expect(labelForWeight(950)).toBe("950");
  });
});

describe("fontWeightToken", () => {
  /**
   * The compatibility contract. These two strings are exactly what
   * `renderer/text.ts` used to build from `isBold` alone, so every project
   * written before the weight row renders byte-identically.
   */
  it("says nothing for an unbolded static face", () => {
    expect(fontWeightToken("AktivGrotesk-Bold", "medium", false)).toBe("");
    expect(fontWeightToken("Georgia", "400", false)).toBe("");
  });

  it("keeps the bold keyword for a bolded static face", () => {
    expect(fontWeightToken("Georgia", "400", true)).toBe("bold");
  });

  /**
   * The weight was already spent on choosing the file. Repeating it to the
   * canvas is at best a no-op and, for a number left over from another family,
   * a synthetic bold smeared over a face the user picked.
   */
  it("never repeats a picked weight to a static face", () => {
    expect(fontWeightToken("AktivGrotesk-Thin", "100", false)).toBe("");
    expect(fontWeightToken("AktivGrotesk-Black", "900", false)).toBe("");
  });

  it("gives a variable face the number, because that is what selects it", () => {
    expect(fontWeightToken("PretendardVariable", "300", false)).toBe("300");
    expect(fontWeightToken("NotoSerifKR-VariableFont_wght", 900, false)).toBe(
      "900",
    );
  });

  it("lets bold raise a variable face rather than replace its weight", () => {
    expect(fontWeightToken("PretendardVariable", "300", true)).toBe("700");
    // A Black title does not get lighter because someone also pressed B.
    expect(fontWeightToken("PretendardVariable", "900", true)).toBe("900");
  });

  it("reads a missing weight on a variable face as regular", () => {
    expect(fontWeightToken("PretendardVariable", "medium", false)).toBe("400");
  });

  it("does not throw on a nameless element", () => {
    expect(fontWeightToken(undefined, undefined, false)).toBe("");
    expect(fontWeightToken(null, null, true)).toBe("bold");
  });
});

describe("elementFontWeight", () => {
  it("takes the stored number when there is one", () => {
    expect(elementFontWeight("AktivGrotesk-Bold", "300")).toBe(300);
  });

  /**
   * A clip set in a bold file by an older build carries `fontweight: "medium"`,
   * which names no weight. Reporting "Regular" over a visibly bold caption
   * would be reporting the field rather than the picture.
   */
  it("falls back to what the file name says", () => {
    expect(elementFontWeight("AktivGrotesk-Bold", "medium")).toBe(700);
    expect(elementFontWeight("AktivGrotesk-Thin", undefined)).toBe(100);
    expect(elementFontWeight("Georgia", "")).toBe(400);
  });

  it("answers regular for an element with no font at all", () => {
    expect(elementFontWeight(undefined, undefined)).toBe(400);
  });
});
