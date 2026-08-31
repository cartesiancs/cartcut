import { describe, it, expect } from "vitest";
import { BLEND_MODES } from "../../@types/timeline";
import { blendOf, coerceBlend, DEFAULT_BLEND, isBlendIsolating } from "./blend";
import { imageElement, scene, videoElement } from "./testing";

/**
 * The vocabulary itself, and the two guards around it.
 *
 * The most valuable test here is the round trip through a real canvas context.
 * `globalCompositeOperation` does not throw on a value it does not know — it
 * silently keeps the previous one — so a typo in `BLEND_MODES` would ship as a
 * dropdown entry that appears to do nothing, with no error anywhere to find.
 */
describe("BLEND_MODES", () => {
  it("has no duplicates", () => {
    expect(new Set(BLEND_MODES).size).toBe(BLEND_MODES.length);
  });

  it("starts with the default, which is what an absent field means", () => {
    expect(BLEND_MODES[0]).toBe(DEFAULT_BLEND);
    expect(DEFAULT_BLEND).toBe("source-over");
  });

  it("covers the six modes CapCut offers", () => {
    for (const mode of [
      "source-over",
      "lighten",
      "screen",
      "darken",
      "overlay",
      "multiply",
    ]) {
      expect(BLEND_MODES).toContain(mode);
    }
  });

  it("is every mode a real canvas actually accepts", () => {
    const { ctx } = scene(4, 4, "#000000");
    for (const mode of BLEND_MODES) {
      // Set something else first, so "kept the previous value" cannot pass by
      // coincidence with the mode under test.
      ctx.globalCompositeOperation = "source-over";
      ctx.globalCompositeOperation = mode;
      expect(ctx.globalCompositeOperation).toBe(mode);
    }
  });

  it("excludes the operations that erase what is beneath", () => {
    for (const forbidden of [
      "copy",
      "xor",
      "destination-out",
      "destination-in",
      "destination-atop",
      "source-in",
      "source-out",
      "source-atop",
    ]) {
      expect(BLEND_MODES).not.toContain(forbidden);
    }
  });
});

describe("blendOf", () => {
  it("reads a mode the clip carries", () => {
    expect(blendOf(videoElement({ blend: "multiply" }))).toBe("multiply");
    expect(blendOf(imageElement({ blend: "screen" }))).toBe("screen");
  });

  it("answers the default for a clip that carries none", () => {
    expect(blendOf(videoElement())).toBe(DEFAULT_BLEND);
    expect(blendOf(imageElement())).toBe(DEFAULT_BLEND);
  });

  // It runs once per element per frame, on documents this build did not write.
  // Throwing here would blank the preview rather than one clip.
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an absent field", {}],
    ["an explicit undefined", { blend: undefined }],
    ["an explicit null", { blend: null }],
    ["an empty string", { blend: "" }],
    ["an unknown mode", { blend: "vivid-light" }],
    ["a canvas op that is not a blend", { blend: "destination-out" }],
    ["the wrong case", { blend: "Multiply" }],
    ["surrounding whitespace", { blend: " multiply " }],
    ["a number", { blend: 3 }],
    ["an object", { blend: { name: "multiply" } }],
    ["an array", { blend: ["multiply"] }],
  ])("falls back to the default for %s, without throwing", (_label, input) => {
    expect(() => blendOf(input as never)).not.toThrow();
    expect(blendOf(input as never)).toBe(DEFAULT_BLEND);
  });

  it("never answers with anything outside the vocabulary", () => {
    // What makes the fallback matter: the result is assigned straight onto
    // `globalCompositeOperation`.
    for (const input of [undefined, null, {}, { blend: "nonsense" }]) {
      expect(BLEND_MODES).toContain(blendOf(input as never));
    }
  });
});

describe("isBlendIsolating", () => {
  it("is false only for the default", () => {
    expect(isBlendIsolating(DEFAULT_BLEND)).toBe(false);
    for (const mode of BLEND_MODES.filter((m) => m !== DEFAULT_BLEND)) {
      expect(isBlendIsolating(mode)).toBe(true);
    }
  });
});

describe("coerceBlend", () => {
  it("accepts every mode in the vocabulary", () => {
    for (const mode of BLEND_MODES) {
      expect(coerceBlend(mode)).toBe(mode);
    }
  });

  // Exact match only. A mode reaches this from a `<select>` built out of
  // `BLEND_MODES` or from a tool schema that enumerates them, so a near miss is
  // a bug upstream and should be reported rather than guessed at.
  it.each([
    ["an unknown mode", "vivid-light"],
    ["an erasing canvas op", "destination-out"],
    ["copy", "copy"],
    ["xor", "xor"],
    ["the wrong case", "MULTIPLY"],
    ["mixed case", "Multiply"],
    ["trailing whitespace", "multiply "],
    ["leading whitespace", " multiply"],
    ["the CSS spelling of the default", "normal"],
    ["an empty string", ""],
    ["undefined", undefined],
    ["null", null],
    ["a number", 1],
    ["an object", {}],
    ["an array", []],
  ])("rejects %s", (_label, input) => {
    expect(coerceBlend(input)).toBeNull();
  });

  it("round-trips with blendOf", () => {
    for (const mode of BLEND_MODES) {
      const coerced = coerceBlend(mode);
      expect(coerced).not.toBeNull();
      expect(blendOf(videoElement({ blend: coerced! }))).toBe(mode);
    }
  });
});
