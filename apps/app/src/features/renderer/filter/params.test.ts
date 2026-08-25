import { describe, it, expect } from "vitest";
import {
  describeFilter,
  formatBlur,
  formatChromakey,
  hexToRgb,
  rgbToHex,
  toFilter,
} from "./params";
import { parseRGBString } from "./chromaKey";
import { parseBlurString } from "./blur";

describe("hexToRgb", () => {
  it("reads six digits, with or without the hash", () => {
    expect(hexToRgb("#00ff00")).toEqual({ r: 0, g: 255, b: 0 });
    expect(hexToRgb("00ff00")).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("doubles a three-digit shorthand, the way CSS does", () => {
    expect(hexToRgb("#0f0")).toEqual({ r: 0, g: 255, b: 0 });
    expect(hexToRgb("#abc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
  });

  it("is case insensitive", () => {
    expect(hexToRgb("#00FF00")).toEqual(hexToRgb("#00ff00"));
  });

  it("says so rather than silently keying on black", () => {
    expect(() => hexToRgb("green")).toThrow(/not a hex colour/);
    expect(() => hexToRgb("#12345")).toThrow(/not a hex colour/);
    expect(() => hexToRgb("")).toThrow(/not a hex colour/);
  });
});

describe("rgbToHex", () => {
  it("round-trips with hexToRgb", () => {
    for (const hex of ["#000000", "#ffffff", "#00ff00", "#123456"]) {
      const { r, g, b } = hexToRgb(hex);
      expect(rgbToHex(r, g, b)).toBe(hex);
    }
  });

  it("clamps and rounds rather than emitting a broken colour", () => {
    expect(rgbToHex(-5, 300, 12.6)).toBe("#00ff0d");
  });
});

/**
 * The point of this file: the formatters are the inverse of the parsers the
 * shaders already use. If they ever disagree, a filter set through the tool
 * renders as something else.
 */
describe("round trip against the shaders' own parsers", () => {
  it("chromakey survives formatting and parsing back", () => {
    const value = formatChromakey({ color: "#00ff00", threshold: 0.4 });
    const parsed = parseRGBString(value);

    expect(parsed.r).toBe(0);
    expect(parsed.g).toBe(255);
    expect(parsed.b).toBe(0);
    expect(parsed.f).toBeCloseTo(0.4);
  });

  it("chromakey defaults to the threshold the panel seeds", () => {
    expect(parseRGBString(formatChromakey({ color: "#000000" })).f).toBe(0.5);
  });

  it("blur survives formatting and parsing back", () => {
    expect(parseBlurString(formatBlur(8)).f).toBe(8);
  });
});

describe("toFilter", () => {
  it("builds each of the three the editor supports", () => {
    expect(toFilter({ name: "chromakey", color: "#ff0000", threshold: 0.2 })).toEqual({
      name: "chromakey",
      value: "r=255:g=0:b=0:f=0.2",
    });
    expect(toFilter({ name: "blur", strength: 5 })).toEqual({
      name: "blur",
      value: "f=5",
    });
    expect(toFilter({ name: "radialblur", strength: 3 })).toEqual({
      name: "radialblur",
      value: "f=3",
    });
  });

  it("rejects a name the shaders have no pipeline for", () => {
    expect(() => toFilter({ name: "sepia" } as any)).toThrow(/Unknown filter/);
  });
});

describe("describeFilter", () => {
  it("turns a stored chromakey back into structured fields", () => {
    expect(describeFilter({ name: "chromakey", value: "r=0:g=255:b=0:f=0.4" })).toEqual(
      { name: "chromakey", color: "#00ff00", threshold: 0.4 },
    );
  });

  it("turns a stored blur back into a strength", () => {
    expect(describeFilter({ name: "blur", value: "f=7" })).toEqual({
      name: "blur",
      strength: 7,
    });
  });

  it("survives a value it cannot parse", () => {
    expect(describeFilter({ name: "chromakey", value: "" } as any)).toMatchObject({
      name: "chromakey",
    });
  });

  it("is the inverse of toFilter", () => {
    const input = { name: "chromakey" as const, color: "#3366cc", threshold: 0.75 };
    expect(describeFilter(toFilter(input))).toEqual({
      name: "chromakey",
      color: "#3366cc",
      threshold: 0.75,
    });
  });
});
