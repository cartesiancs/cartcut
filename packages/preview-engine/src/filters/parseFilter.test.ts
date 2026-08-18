import { describe, it, expect } from "vitest";
import { parseRGBString, parseBlurString } from "./parseFilter";

describe("parseRGBString", () => {
  it("parses r/g/b/f channels", () => {
    expect(parseRGBString("r=0:g=255:b=0:f=0.5")).toEqual({
      r: 0,
      g: 255,
      b: 0,
      f: 0.5,
    });
  });
  it("defaults f (threshold) to 1 when absent", () => {
    expect(parseRGBString("r=10:g=20:b=30")).toEqual({
      r: 10,
      g: 20,
      b: 30,
      f: 1,
    });
  });
  it("parses fractional channel values as floats", () => {
    expect(parseRGBString("r=127.5:g=0:b=0").r).toBeCloseTo(127.5);
  });
});

describe("parseBlurString", () => {
  it("parses the blur factor as an integer", () => {
    expect(parseBlurString("f=8")).toEqual({ f: 8 });
  });
  it("defaults f to 0 when absent", () => {
    expect(parseBlurString("x=1")).toEqual({ f: 0 });
  });
});
