import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_SCALE,
  UI_SCALES,
  coerceUiScale,
  normalizeUiScale,
  trafficLightPositionFor,
  uiScaleLabel,
} from "./uiScale";

describe("the UI scale choices", () => {
  it("run smallest first and include 100%", () => {
    expect([...UI_SCALES].sort((a, b) => a - b)).toEqual([...UI_SCALES]);
    expect(UI_SCALES).toContain(DEFAULT_UI_SCALE);
    expect(DEFAULT_UI_SCALE).toBe(1);
  });

  it("are labelled as whole percentages", () => {
    expect(UI_SCALES.map(uiScaleLabel)).toEqual([
      "75%",
      "100%",
      "125%",
      "150%",
      "175%",
      "200%",
    ]);
  });
});

describe("coerceUiScale", () => {
  it("accepts every choice as itself", () => {
    for (const scale of UI_SCALES) {
      expect(coerceUiScale(scale)).toBe(scale);
    }
  });

  it("refuses anything that is not exactly a choice", () => {
    for (const value of [1.2, 0.5, 3, 0, -1, NaN, Infinity, "1.25", "125%", null, undefined, {}, [1]]) {
      expect(coerceUiScale(value), String(value)).toBeNull();
    }
  });
});

describe("normalizeUiScale", () => {
  it("keeps a stored choice", () => {
    expect(normalizeUiScale(1.5)).toBe(1.5);
  });

  it("reads an absent or edited value as 100%", () => {
    for (const value of [undefined, null, "big", 1.3, NaN]) {
      expect(normalizeUiScale(value), String(value)).toBe(1);
    }
  });
});

describe("trafficLightPositionFor", () => {
  it("is where the buttons always were at 100%", () => {
    expect(trafficLightPositionFor(1)).toEqual({ x: 10, y: 10 });
  });

  it("keeps the buttons centred in the scaled bar", () => {
    for (const scale of UI_SCALES) {
      const { y } = trafficLightPositionFor(scale);
      // At 100% the bar is 34 tall with the buttons 10 from its top, so their
      // centre is 7 below `y`. Rounding leaves it within half a point of the bar's centre.
      expect(Math.abs(y + 7 - (34 * scale) / 2), String(scale)).toBeLessThanOrEqual(0.5);
    }
  });
});
