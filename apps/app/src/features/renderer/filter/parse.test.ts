import { describe, it, expect } from "vitest";
import { parseRGBString } from "./chromaKey";
import { parseBlurString } from "./blur";

/**
 * Filter parameters travel as strings through the timeline, so a parsing slip
 * shows up as a wrong key colour or an unresponsive slider rather than a crash.
 * Both parsers feed shader uniforms directly.
 */
describe("parseRGBString", () => {
  it("reads the key colour and the match threshold", () => {
    expect(parseRGBString("r=0:g=255:b=0:f=0.4")).toEqual({
      r: 0,
      g: 255,
      b: 0,
      f: 0.4,
    });
  });

  it("defaults the threshold to 1 when it is absent", () => {
    expect(parseRGBString("r=10:g=20:b=30")).toEqual({
      r: 10,
      g: 20,
      b: 30,
      f: 1,
    });
  });

  it("keeps the threshold fractional", () => {
    // Rounding `f` to an integer would collapse the whole slider range onto 0
    // or 1 and make chromakey all-or-nothing.
    expect(parseRGBString("r=0:g=0:b=0:f=0.05").f).toBeCloseTo(0.05, 10);
    expect(parseRGBString("r=0:g=0:b=0:f=0.5").f).toBeCloseTo(0.5, 10);
  });

  it("accepts fractional channel values", () => {
    expect(parseRGBString("r=127.5:g=0:b=0").r).toBeCloseTo(127.5, 10);
  });

  it("ignores keys it does not know, and order does not matter", () => {
    expect(parseRGBString("b=3:x=9:g=2:r=1")).toEqual({
      r: 1,
      g: 2,
      b: 3,
      f: 1,
    });
  });

  it("leaves unmentioned channels at zero", () => {
    expect(parseRGBString("g=255")).toEqual({ r: 0, g: 255, b: 0, f: 1 });
  });
});

describe("parseBlurString", () => {
  it("reads the blur factor", () => {
    expect(parseBlurString("f=8")).toEqual({ f: 8 });
  });

  it("defaults to 0 when the factor is absent", () => {
    expect(parseBlurString("x=1")).toEqual({ f: 0 });
    expect(parseBlurString("")).toEqual({ f: 0 });
  });

  it("truncates to an integer, since the factor counts texel steps", () => {
    expect(parseBlurString("f=4.9")).toEqual({ f: 4 });
  });
});
