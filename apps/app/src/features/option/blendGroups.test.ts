import { describe, it, expect } from "vitest";
import { BLEND_MODES } from "../../@types/timeline";
import { coerceBlend } from "../renderer/blend";
import { BLEND_GROUPS, BLEND_GROUP_MODES } from "./blendGroups";

/**
 * The dropdown against the vocabulary.
 *
 * These are the two ways the pair can go wrong, and neither shows up as an
 * error at runtime: a mode in `BLEND_MODES` that no group lists is one the user
 * can never pick, and a group entry that is not a `BlendMode` is a row that
 * looks pickable and is dropped by `coerceBlend` when picked.
 */
describe("BLEND_GROUPS", () => {
  it("offers every mode in the vocabulary", () => {
    expect([...BLEND_GROUP_MODES].sort()).toEqual([...BLEND_MODES].sort());
  });

  it("offers each of them exactly once", () => {
    expect(new Set(BLEND_GROUP_MODES).size).toBe(BLEND_GROUP_MODES.length);
  });

  it("offers nothing the coercer would reject", () => {
    for (const mode of BLEND_GROUP_MODES) {
      expect(coerceBlend(mode)).toBe(mode);
    }
  });

  it("leads with Normal, ungrouped, so the default is the first thing seen", () => {
    expect(BLEND_GROUPS[0].label).toBe("");
    expect(BLEND_GROUPS[0].modes).toEqual([
      { value: "source-over", label: "Normal" },
    ]);
  });

  it("gives every other group a heading and at least two modes", () => {
    for (const group of BLEND_GROUPS.slice(1)) {
      expect(group.label).not.toBe("");
      expect(group.modes.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("labels every mode, with no duplicate labels", () => {
    const labels = BLEND_GROUPS.flatMap((g) => g.modes.map((m) => m.label));
    expect(labels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("names the six modes CapCut offers, under the labels users know", () => {
    const byValue = new Map(
      BLEND_GROUPS.flatMap((g) => g.modes).map((m) => [m.value, m.label]),
    );
    expect(byValue.get("source-over")).toBe("Normal");
    expect(byValue.get("lighten")).toBe("Lighten");
    expect(byValue.get("screen")).toBe("Screen");
    expect(byValue.get("darken")).toBe("Darken");
    expect(byValue.get("overlay")).toBe("Overlay");
    expect(byValue.get("multiply")).toBe("Multiply");
  });
});
