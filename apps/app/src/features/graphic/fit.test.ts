import { describe, expect, it } from "vitest";
import { FIT_CEILING, FIT_FLOOR, fitMaxOf, fitModeOf, fitScale } from "./fit";

describe("fitScale", () => {
  it("finds the largest scale that fits, from below", () => {
    // A 1000 px line in a 640 px box fits at 0.64 and no higher.
    const scale = fitScale((s) => 1000 * s <= 640);
    expect(scale).toBeLessThanOrEqual(0.64);
    expect(scale).toBeGreaterThan(0.639);
  });

  it("leaves text that already fits alone", () => {
    let probes = 0;
    expect(fitScale(() => (probes++, true))).toBe(1);
    expect(probes).toBe(1);
  });

  it("grows short text up to the ceiling the author allowed", () => {
    expect(fitScale((s) => 100 * s <= 640, 4)).toBe(4);
    const scale = fitScale((s) => 100 * s <= 640, 8);
    expect(scale).toBeLessThanOrEqual(6.4);
    expect(scale).toBeGreaterThan(6.39);
  });

  it("draws as small as allowed when nothing fits", () => {
    expect(fitScale(() => false)).toBe(FIT_FLOOR);
  });

  it("disagrees with itself when the measurement does, so the harness measures something", () => {
    expect(fitScale((s) => 1000 * s <= 300)).not.toBe(fitScale((s) => 1000 * s <= 600));
  });
});

describe("the attributes", () => {
  it("reads the mode", () => {
    expect(fitModeOf("")).toBe("width");
    expect(fitModeOf("width")).toBe("width");
    expect(fitModeOf("box")).toBe("box");
    expect(fitModeOf("height")).toBeNull();
    expect(fitModeOf(null)).toBeNull();
  });

  it("reads and clamps the ceiling", () => {
    expect(fitMaxOf(null)).toBe(1);
    expect(fitMaxOf("3")).toBe(3);
    expect(fitMaxOf("100")).toBe(FIT_CEILING);
    expect(fitMaxOf("-1")).toBe(1);
    expect(fitMaxOf("nope")).toBe(1);
  });
});
