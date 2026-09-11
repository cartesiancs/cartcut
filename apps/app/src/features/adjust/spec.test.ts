import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { COLOR_ADJUSTMENT_KEYS } from "../../@types/timeline";
import {
  ADJUSTMENTS,
  ADJUST_GROUPS,
  FINISH_KEYS,
  TONE_CURVE_WEIGHTS,
  TONE_CURVE_X,
  TONE_KEYS,
  groupLabelKeyOf,
  keysOfGroup,
  labelKeyOf,
} from "./spec";

function locale(name: string): Record<string, Record<string, string>> {
  const path = fileURLToPath(new URL(`../../locale/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

function lookup(dict: Record<string, Record<string, string>>, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>(
    (node, part) => (node as Record<string, unknown> | undefined)?.[part],
    dict,
  );
}

describe("the table", () => {
  it("describes exactly the keys the document can hold", () => {
    expect(Object.keys(ADJUSTMENTS).sort()).toEqual([...COLOR_ADJUSTMENT_KEYS].sort());
  });

  it("groups them as CapCut's Adjust panel does, in its order", () => {
    expect(ADJUST_GROUPS).toEqual(["color", "lightness", "effects"]);
    expect(keysOfGroup("color")).toEqual(["temperature", "tint", "saturation"]);
    expect(keysOfGroup("lightness")).toEqual([
      "exposure",
      "contrast",
      "highlights",
      "shadows",
      "whites",
      "blacks",
      "brilliance",
    ]);
    expect(keysOfGroup("effects")).toEqual([
      "sharpen",
      "clarity",
      "particles",
      "fade",
      "vignette",
    ]);
  });

  it("puts zero — neutral — inside every range", () => {
    for (const key of COLOR_ADJUSTMENT_KEYS) {
      const { min, max } = ADJUSTMENTS[key];
      expect(min).toBeLessThanOrEqual(0);
      expect(max).toBeGreaterThan(0);
    }
  });

  it("has no negative for an effect that cannot be undone, and one for vignette", () => {
    for (const key of ["sharpen", "clarity", "particles", "fade"] as const) {
      expect(ADJUSTMENTS[key].min).toBe(0);
    }
    expect(ADJUSTMENTS.vignette.min).toBeLessThan(0);
  });

  it("splits cleanly into what is baked and what is finished", () => {
    expect([...TONE_KEYS, ...FINISH_KEYS].sort()).toEqual([...COLOR_ADJUSTMENT_KEYS].sort());
    expect(TONE_KEYS.filter((key) => FINISH_KEYS.includes(key))).toEqual([]);
  });
});

describe("the tone curve's layout", () => {
  it("has strictly increasing control points spanning 0-1", () => {
    expect(TONE_CURVE_X[0]).toBe(0);
    expect(TONE_CURVE_X[TONE_CURVE_X.length - 1]).toBe(1);
    for (let i = 1; i < TONE_CURVE_X.length; i++) {
      expect(TONE_CURVE_X[i]).toBeGreaterThan(TONE_CURVE_X[i - 1]);
    }
  });

  it("gives every handle one weight per control point", () => {
    for (const weights of Object.values(TONE_CURVE_WEIGHTS)) {
      expect(weights).toHaveLength(TONE_CURVE_X.length);
    }
  });
});

describe("labels", () => {
  for (const name of ["en", "ko"]) {
    it(`${name}.json names every control and every group`, () => {
      const dict = locale(name);
      for (const key of COLOR_ADJUSTMENT_KEYS) {
        expect(lookup(dict, labelKeyOf(key)), `${name}: ${key}`).toEqual(expect.any(String));
      }
      for (const group of ADJUST_GROUPS) {
        expect(lookup(dict, groupLabelKeyOf(group)), `${name}: ${group}`).toEqual(
          expect.any(String),
        );
      }
      for (const extra of ["adjust.tab", "adjust.reset", "adjust.reset_all"]) {
        expect(lookup(dict, extra), `${name}: ${extra}`).toEqual(expect.any(String));
      }
    });
  }

  it("the English fallback in the table matches en.json", () => {
    const dict = locale("en");
    for (const key of COLOR_ADJUSTMENT_KEYS) {
      expect(lookup(dict, labelKeyOf(key))).toBe(ADJUSTMENTS[key].label);
    }
  });
});
