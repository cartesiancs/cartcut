import { describe, it, expect } from "vitest";
import { toRadian, toDegrees } from "./geom";

describe("toRadian", () => {
  it("converts the cardinal angles", () => {
    expect(toRadian(0)).toBe(0);
    expect(toRadian(90)).toBeCloseTo(Math.PI / 2, 12);
    expect(toRadian(180)).toBeCloseTo(Math.PI, 12);
    expect(toRadian(360)).toBeCloseTo(Math.PI * 2, 12);
  });

  it("keeps the sign of a negative rotation", () => {
    expect(toRadian(-90)).toBeCloseTo(-Math.PI / 2, 12);
  });
});

describe("toDegrees", () => {
  it("is the inverse of toRadian", () => {
    for (const degrees of [0, 30, 45, 90, 180, 270, -45]) {
      expect(toDegrees(toRadian(degrees))).toBeCloseTo(degrees, 12);
    }
  });
});
