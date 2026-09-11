import { describe, expect, it } from "vitest";

import {
  COLOR_ADJUSTMENT_KEYS,
  type ColorAdjustmentKey,
  type ColorAdjustments,
} from "../../@types/timeline";
import { chroma, luma, toLinear, type Rgb } from "../lut/colorMath";
import { mulberry32 } from "../renderer/testing";
import {
  DISPLAY_GAMMA,
  EXPOSURE_STOPS,
  TONE_CURVE_MIN_RISE,
  TONE_KEYS,
} from "./spec";
import {
  isToneNeutral,
  lightGains,
  toneCurvePoints,
  toneStep,
  toneSteps,
} from "./tone";

/**
 * The tone half of the colour adjustments, stated as properties rather than
 * as restated formulas. A test that recomputed `tone.ts` would pass whatever
 * the formula said; these say what each slider is *for*.
 */

const EPS = 1e-9;

function grid(levels = 16): Rgb[] {
  const out: Rgb[] = [];
  for (let r = 0; r < levels; r++) {
    for (let g = 0; g < levels; g++) {
      for (let b = 0; b < levels; b++) {
        out.push([r / (levels - 1), g / (levels - 1), b / (levels - 1)]);
      }
    }
  }
  return out;
}

const GREY_RAMP: number[] = Array.from({ length: 256 }, (_, i) => i / 255);

function apply(values: ColorAdjustments, c: Rgb): Rgb {
  return toneStep(values)(c);
}

function grey(values: ColorAdjustments, v: number): number {
  return apply(values, [v, v, v])[1];
}

/** Change in a grey level. Positive means brighter. */
function delta(values: ColorAdjustments, v: number): number {
  return grey(values, v) - v;
}

describe("at neutral", () => {
  it("is exactly the identity on every colour", () => {
    const step = toneStep({});
    for (const c of grid()) {
      expect(step(c)).toEqual(c);
    }
  });

  it("contributes no steps at all", () => {
    expect(toneSteps({})).toEqual([]);
    expect(toneSteps({ temperature: 0, exposure: 0 })).toEqual([]);
  });

  it("treats the effects group as not tone", () => {
    expect(
      isToneNeutral({ sharpen: 50, clarity: 50, particles: 50, fade: 50, vignette: 50 }),
    ).toBe(true);
    expect(toneSteps({ sharpen: 100, fade: 100 })).toEqual([]);
  });

  it("is not neutral once any tone slider moves", () => {
    for (const key of TONE_KEYS) {
      expect(isToneNeutral({ [key]: 1 })).toBe(false);
      expect(isToneNeutral({ [key]: -1 })).toBe(false);
    }
  });

  it("ignores junk values rather than throwing", () => {
    const junk = { exposure: Number.NaN, contrast: Infinity } as ColorAdjustments;
    expect(isToneNeutral(junk)).toBe(true);
    expect(apply(junk, [0.3, 0.4, 0.5])).toEqual([0.3, 0.4, 0.5]);
  });
});

describe("temperature", () => {
  it("warms a neutral grey when positive", () => {
    const [r, , b] = apply({ temperature: 60 }, [0.5, 0.5, 0.5]);
    expect(r).toBeGreaterThan(b + 0.05);
  });

  it("cools it when negative", () => {
    const [r, , b] = apply({ temperature: -60 }, [0.5, 0.5, 0.5]);
    expect(b).toBeGreaterThan(r + 0.05);
  });

  it("moves further the further it is pushed", () => {
    const warmth = (t: number) => {
      const [r, , b] = apply({ temperature: t }, [0.5, 0.5, 0.5]);
      return r - b;
    };
    let previous = -Infinity;
    for (const t of [-100, -50, 0, 50, 100]) {
      const w = warmth(t);
      expect(w).toBeGreaterThan(previous);
      previous = w;
    }
  });
});

describe("tint", () => {
  it("pushes toward magenta when positive", () => {
    const [r, g, b] = apply({ tint: 60 }, [0.5, 0.5, 0.5]);
    expect(r).toBeGreaterThan(g);
    expect(b).toBeGreaterThan(g);
  });

  it("pushes toward green when negative", () => {
    const [r, g, b] = apply({ tint: -60 }, [0.5, 0.5, 0.5]);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });
});

describe("saturation", () => {
  it("at −100 is monochrome at the colour's own luminance", () => {
    for (const c of [
      [0.8, 0.2, 0.1],
      [0.1, 0.6, 0.9],
      [0.3, 0.3, 0.7],
    ] as Rgb[]) {
      const out = apply({ saturation: -100 }, c);
      expect(Math.abs(out[0] - out[1])).toBeLessThan(EPS);
      expect(Math.abs(out[1] - out[2])).toBeLessThan(EPS);
      expect(out[0]).toBeCloseTo(luma(c), 9);
    }
  });

  it("adds colour when positive and removes it when negative", () => {
    const c: Rgb = [0.6, 0.4, 0.3];
    expect(chroma(apply({ saturation: 50 }, c))).toBeGreaterThan(chroma(c));
    expect(chroma(apply({ saturation: -50 }, c))).toBeLessThan(chroma(c));
  });

  it("leaves a grey alone", () => {
    for (const s of [-100, -40, 40, 100]) {
      expect(apply({ saturation: s }, [0.4, 0.4, 0.4])).toEqual([0.4, 0.4, 0.4]);
    }
  });
});

describe("exposure", () => {
  /** Light, under the model's own transfer function. */
  const light = (v: number) => Math.pow(v, DISPLAY_GAMMA);

  it(`at +100 is exactly ${EXPOSURE_STOPS} stops more light`, () => {
    for (const x of [0.05, 0.2, 0.3]) {
      expect(light(grey({ exposure: 100 }, x))).toBeCloseTo(
        light(x) * 2 ** EXPOSURE_STOPS,
        9,
      );
    }
  });

  it(`at −100 is exactly ${EXPOSURE_STOPS} stops less`, () => {
    for (const x of [0.2, 0.6, 1]) {
      expect(light(grey({ exposure: -100 }, x))).toBeCloseTo(
        light(x) / 2 ** EXPOSURE_STOPS,
        9,
      );
    }
  });

  it("agrees with piecewise sRGB on 18% grey to within 1%", () => {
    // The pure power law is a stand-in for the sRGB curve (`spec.ts` says
    // why). This is the check that it stands in well where it matters.
    const srgbOf18 = 0.4613561295;
    const out = grey({ exposure: 100 }, srgbOf18);
    expect(toLinear(out) / (0.18 * 2 ** EXPOSURE_STOPS)).toBeGreaterThan(0.99);
    expect(toLinear(out) / (0.18 * 2 ** EXPOSURE_STOPS)).toBeLessThan(1.01);
  });

  it("leaves black black — it scales light, it does not add it", () => {
    expect(apply({ exposure: 100 }, [0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("is a gain, so it clips white only at the very end", () => {
    expect(grey({ exposure: 100 }, 0.9)).toBe(1);
  });
});

describe("lightGains", () => {
  it("is null with white balance and exposure at zero", () => {
    expect(lightGains({})).toBeNull();
    expect(lightGains({ contrast: 50 })).toBeNull();
  });

  it("is equal on all three channels for exposure alone", () => {
    const [r, g, b] = lightGains({ exposure: 50 })!;
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(r).toBeCloseTo(2 ** (EXPOSURE_STOPS / 2), 12);
  });

  it("stays positive on every channel at every combination", () => {
    for (const t of [-100, 100])
      for (const u of [-100, 100])
        for (const e of [-100, 100]) {
          for (const gain of lightGains({ temperature: t, tint: u, exposure: e })!) {
            expect(gain).toBeGreaterThan(0);
          }
        }
  });
});

describe("contrast", () => {
  it("holds mid grey still at both ends of the slider", () => {
    expect(grey({ contrast: 100 }, 0.5)).toBeCloseTo(0.5, 9);
    expect(grey({ contrast: -100 }, 0.5)).toBeCloseTo(0.5, 9);
  });

  it("positive darkens the darks and brightens the brights", () => {
    expect(delta({ contrast: 80 }, 0.25)).toBeLessThan(-0.02);
    expect(delta({ contrast: 80 }, 0.75)).toBeGreaterThan(0.02);
  });

  it("negative pulls both toward grey", () => {
    expect(delta({ contrast: -80 }, 0.25)).toBeGreaterThan(0.02);
    expect(delta({ contrast: -80 }, 0.75)).toBeLessThan(-0.02);
  });

  it("positive rolls the ends off instead of clipping them", () => {
    // A filmic S keeps 0 and 1 fixed and everything between them distinct.
    expect(grey({ contrast: 100 }, 0)).toBeCloseTo(0, 9);
    expect(grey({ contrast: 100 }, 1)).toBeCloseTo(1, 9);
    expect(grey({ contrast: 100 }, 0.97)).toBeLessThan(1);
  });
});

describe("the tone regions", () => {
  it("highlights moves the bright half far more than the dark half", () => {
    expect(delta({ highlights: 100 }, 0.8)).toBeGreaterThan(0.05);
    expect(Math.abs(delta({ highlights: 100 }, 0.15))).toBeLessThan(0.01);
    expect(delta({ highlights: -100 }, 0.8)).toBeLessThan(-0.05);
  });

  it("shadows moves the dark half far more than the bright half", () => {
    expect(delta({ shadows: 100 }, 0.2)).toBeGreaterThan(0.05);
    expect(Math.abs(delta({ shadows: 100 }, 0.85))).toBeLessThan(0.01);
    expect(delta({ shadows: -100 }, 0.2)).toBeLessThan(-0.05);
  });

  it("whites moves only the top of the range", () => {
    expect(delta({ whites: 100 }, 0.95)).toBeGreaterThan(0.03);
    expect(Math.abs(delta({ whites: 100 }, 0.5))).toBeLessThan(0.005);
    expect(Math.abs(delta({ whites: 100 }, 0.2))).toBeLessThan(0.001);
  });

  it("blacks moves only the bottom of the range", () => {
    expect(delta({ blacks: 100 }, 0.03)).toBeGreaterThan(0.03);
    expect(delta({ blacks: -100 }, 0.05)).toBeLessThan(-0.02);
    expect(Math.abs(delta({ blacks: 100 }, 0.5))).toBeLessThan(0.005);
    expect(Math.abs(delta({ blacks: 100 }, 0.8))).toBeLessThan(0.001);
  });

  it("whites at +100 can reach full white, and blacks at −100 full black", () => {
    expect(grey({ whites: 100 }, 0.97)).toBe(1);
    expect(grey({ blacks: -100 }, 0.02)).toBe(0);
  });

  it("brilliance lifts the shadows and pulls the highlights in", () => {
    expect(delta({ brilliance: 100 }, 0.25)).toBeGreaterThan(0.03);
    expect(delta({ brilliance: 100 }, 0.75)).toBeLessThan(-0.02);
    expect(delta({ brilliance: -100 }, 0.25)).toBeLessThan(-0.03);
    expect(delta({ brilliance: -100 }, 0.75)).toBeGreaterThan(0.02);
  });
});

describe("toneCurvePoints", () => {
  it("is null when none of its handles are moved", () => {
    expect(toneCurvePoints({})).toBeNull();
    expect(toneCurvePoints({ exposure: 50, saturation: -20 })).toBeNull();
  });

  it("always rises by at least the minimum between points", () => {
    const random = mulberry32(7);
    const handles = ["blacks", "shadows", "highlights", "whites", "brilliance"] as const;
    for (let i = 0; i < 500; i++) {
      const values: ColorAdjustments = {};
      for (const key of handles) {
        values[key] = Math.round(random() * 200 - 100);
      }
      const points = toneCurvePoints(values);
      if (points == null) continue;
      for (let j = 1; j < points.length; j++) {
        expect(points[j][1] - points[j - 1][1]).toBeGreaterThanOrEqual(
          TONE_CURVE_MIN_RISE - EPS,
        );
      }
    }
  });

  it("survives the combination that would otherwise invert: blacks up, shadows and brilliance down", () => {
    const points = toneCurvePoints({ blacks: 100, shadows: -100, brilliance: -100 });
    expect(points).not.toBeNull();
    for (let j = 1; j < points!.length; j++) {
      expect(points![j][1]).toBeGreaterThan(points![j - 1][1]);
    }
  });
});

describe("invariants over every slider", () => {
  function extremes(): Array<[ColorAdjustmentKey, number]> {
    return TONE_KEYS.flatMap((key) => [
      [key, -100],
      [key, 100],
    ]) as Array<[ColorAdjustmentKey, number]>;
  }

  it("never inverts a grey ramp — every slider at either end is monotone", () => {
    for (const [key, v] of extremes()) {
      let previous = -Infinity;
      for (const x of GREY_RAMP) {
        const y = luma(apply({ [key]: v }, [x, x, x]));
        expect(y, `${key}=${v} at ${x}`).toBeGreaterThanOrEqual(previous - EPS);
        previous = y;
      }
    }
  });

  it("never inverts a ramp under random combinations either", () => {
    const random = mulberry32(99);
    for (let i = 0; i < 120; i++) {
      const values: ColorAdjustments = {};
      for (const key of TONE_KEYS) {
        if (random() < 0.6) values[key] = Math.round(random() * 200 - 100);
      }
      let previous = -Infinity;
      for (const x of GREY_RAMP) {
        const y = luma(apply(values, [x, x, x]));
        expect(y, JSON.stringify(values)).toBeGreaterThanOrEqual(previous - EPS);
        previous = y;
      }
    }
  });

  it("keeps a neutral grey neutral, except the two white-balance controls", () => {
    for (const [key, v] of extremes()) {
      if (key === "temperature" || key === "tint") continue;
      for (const x of [0.1, 0.35, 0.6, 0.9]) {
        const [r, g, b] = apply({ [key]: v }, [x, x, x]);
        expect(Math.abs(r - g), `${key}=${v}`).toBeLessThan(EPS);
        expect(Math.abs(g - b), `${key}=${v}`).toBeLessThan(EPS);
      }
    }
  });

  it("always answers a finite colour inside 0-1", () => {
    const random = mulberry32(2024);
    for (let i = 0; i < 300; i++) {
      const values: ColorAdjustments = {};
      for (const key of COLOR_ADJUSTMENT_KEYS) {
        if (random() < 0.5) values[key] = random() * 200 - 100;
      }
      const step = toneStep(values);
      for (let j = 0; j < 20; j++) {
        const out = step([random(), random(), random()]);
        for (const v of out) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
