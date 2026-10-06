import { describe, expect, it } from "vitest";
import { sheetWarning } from "./sheetWarning";

describe("sheetWarning", () => {
  it("says nothing about a complete sheet", () => {
    expect(sheetWarning({ loaded: 2, expected: 2 }, true)).toEqual({});
  });

  it("says graphics may be missing when the window did not paint, and blames the window", () => {
    const { warning } = sheetWarning({ loaded: 2, expected: 2 }, false);
    expect(warning).toMatch(/did not paint/);
    expect(warning).toMatch(/not the graphics/);
  });

  it("reports both at once", () => {
    const { warning } = sheetWarning({ loaded: 1, expected: 3 }, false);
    expect(warning).toMatch(/Only 1 of 3 videos/);
    expect(warning).toMatch(/did not paint/);
  });
});
