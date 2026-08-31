import { describe, expect, it } from "vitest";

import {
  asc,
  bleachBypass,
  channelCurve,
  chroma,
  clamp01,
  contrast,
  exposure,
  filmS,
  hslToRgb,
  hueBand,
  hueRotate,
  liftGammaGain,
  logDecode,
  logToRec709,
  luma,
  makeCurve,
  matte,
  monoMix,
  rgbCurve,
  rgbToHsl,
  type Rgb,
  runSteps,
  saturation,
  softWhites,
  splitTone,
  temperature,
  tint,
  toLinear,
  toSrgb,
  vibrance,
} from "./colorMath";

const GREY: Rgb = [0.5, 0.5, 0.5];
const RED: Rgb = [0.8, 0.15, 0.12];
const SKY: Rgb = [0.3, 0.5, 0.85];

/** A deterministic spread over the cube. No RNG, no seed to lose. */
function* samples(steps = 9): Generator<Rgb> {
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      for (let k = 0; k <= steps; k++) {
        yield [i / steps, j / steps, k / steps];
      }
    }
  }
}

describe("the sRGB transfer pair", () => {
  it("round-trips every 8-bit value", () => {
    for (let i = 0; i <= 255; i++) {
      expect(toSrgb(toLinear(i / 255))).toBeCloseTo(i / 255, 9);
    }
  });

  it("is continuous across the piecewise join", () => {
    expect(toLinear(0.04045)).toBeCloseTo(0.04045 / 12.92, 6);
    expect(toSrgb(0.0031308)).toBeCloseTo(0.0031308 * 12.92, 6);
  });

  it("mirrors below zero rather than producing a NaN", () => {
    // Intermediate steps can go negative; the round trip has to survive it.
    expect(toLinear(-0.5)).toBeCloseTo(-toLinear(0.5), 9);
    expect(Number.isNaN(toSrgb(-0.2))).toBe(false);
  });
});

describe("makeCurve", () => {
  it("passes through its control points", () => {
    const f = makeCurve([
      [0, 0.1],
      [0.5, 0.4],
      [1, 0.95],
    ]);
    expect(f(0)).toBeCloseTo(0.1, 9);
    expect(f(0.5)).toBeCloseTo(0.4, 9);
    expect(f(1)).toBeCloseTo(0.95, 9);
  });

  it("clamps to the end values outside the range", () => {
    const f = makeCurve([
      [0.2, 0.3],
      [0.8, 0.7],
    ]);
    expect(f(-1)).toBe(0.3);
    expect(f(2)).toBe(0.7);
  });

  // The reason it is Fritsch–Carlson and not Catmull-Rom. An overshoot in a
  // tone curve is a region where more input means less output, which renders
  // as a bright ring around highlights.
  it("never overshoots, even through a sharp control point", () => {
    const f = makeCurve([
      [0, 0],
      [0.1, 0.02],
      [0.5, 0.9],
      [0.9, 0.93],
      [1, 1],
    ]);
    let previous = -Infinity;
    for (let i = 0; i <= 1000; i++) {
      const y = f(i / 1000);
      expect(y).toBeGreaterThanOrEqual(previous - 1e-12);
      expect(y).toBeGreaterThanOrEqual(-1e-12);
      expect(y).toBeLessThanOrEqual(1 + 1e-12);
      previous = y;
    }
  });

  it("stays flat where two control points are level", () => {
    const f = makeCurve([
      [0, 0],
      [0.4, 0.5],
      [0.6, 0.5],
      [1, 1],
    ]);
    for (let x = 0.4; x <= 0.6; x += 0.01) {
      expect(f(x)).toBeCloseTo(0.5, 6);
    }
  });

  it("refuses a curve with fewer than two points", () => {
    expect(() => makeCurve([[0, 0]])).toThrow(/at least two/);
  });
});

describe("exposure", () => {
  // A stop is a doubling of light, not of the coded signal. Applying it in
  // sRGB would brighten the shadows far more than the highlights.
  it("doubles the light for one stop, not the signal", () => {
    const out = exposure(1)([0.5, 0.5, 0.5]);
    expect(toLinear(out[0])).toBeCloseTo(toLinear(0.5) * 2, 6);
    expect(out[0]).not.toBeCloseTo(1, 2);
  });

  it("is its own inverse in the other direction", () => {
    for (const v of [0.1, 0.4, 0.9]) {
      const there = exposure(0.7)([v, v, v]);
      const back = exposure(-0.7)(there);
      expect(back[0]).toBeCloseTo(v, 6);
    }
  });

  it("leaves black alone", () => {
    expect(exposure(2)([0, 0, 0])[0]).toBeCloseTo(0, 9);
  });
});

describe("saturation and vibrance", () => {
  it("saturation of 0 is exactly luminance", () => {
    const out = saturation(0)(RED);
    const l = luma(RED);
    expect(out).toEqual([l, l, l]);
  });

  it("saturation of 1 changes nothing", () => {
    for (const c of samples(4)) {
      const out = saturation(1)(c);
      expect(out[0]).toBeCloseTo(c[0], 9);
      expect(out[2]).toBeCloseTo(c[2], 9);
    }
  });

  it("leaves neutrals neutral at any amount", () => {
    for (const s of [0, 0.5, 1.5, 3]) {
      const out = saturation(s)(GREY);
      expect(out[0]).toBeCloseTo(0.5, 9);
      expect(out[1]).toBeCloseTo(0.5, 9);
      expect(out[2]).toBeCloseTo(0.5, 9);
    }
  });

  // The point of vibrance: a face gets the boost, a saturated sign does not.
  it("vibrance boosts a muted colour more than a saturated one", () => {
    const muted: Rgb = [0.52, 0.48, 0.46];
    const vivid: Rgb = [0.95, 0.05, 0.05];
    const gain = (c: Rgb): number => {
      const before = chroma(c);
      return before === 0 ? 0 : chroma(vibrance(0.5)(c)) / before;
    };
    expect(gain(muted)).toBeGreaterThan(gain(vivid));
  });

  it("chroma is zero on neutral and grows away from it", () => {
    expect(chroma(GREY)).toBe(0);
    expect(chroma([1, 0, 0])).toBeGreaterThan(chroma([0.6, 0.5, 0.4]));
  });

  // `max - min` has creases along the planes where two channels are equal, and
  // a crease inside a LUT cell is error no grid resolution removes cheaply.
  it("chroma has no crease where two channels cross", () => {
    const at = (t: number): number => chroma([0.5 + t, 0.5, 0.3]);
    const step = 1e-4;
    const leftSlope = (at(-step) - at(-2 * step)) / step;
    const rightSlope = (at(2 * step) - at(step)) / step;
    expect(Math.abs(leftSlope - rightSlope)).toBeLessThan(0.05);
  });
});

describe("white balance", () => {
  it("warms and cools symmetrically about neutral", () => {
    const warm = temperature(0.3)(GREY);
    const cool = temperature(-0.3)(GREY);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThan(cool[0]);
  });

  it("does nothing at zero", () => {
    for (const c of samples(4)) {
      const out = temperature(0)(c);
      expect(out[0]).toBeCloseTo(c[0], 6);
    }
  });

  it("tint moves green against magenta", () => {
    expect(tint(0.3)(GREY)[1]).toBeLessThan(0.5);
    expect(tint(-0.3)(GREY)[1]).toBeGreaterThan(0.5);
  });
});

describe("tone shaping", () => {
  it("filmS fixes black, white and the midpoint", () => {
    for (const strength of [0, 0.3, 1]) {
      const f = filmS(strength);
      expect(f([0, 0, 0])[0]).toBeCloseTo(0, 9);
      expect(f([1, 1, 1])[0]).toBeCloseTo(1, 9);
      expect(f([0.5, 0.5, 0.5])[0]).toBeCloseTo(0.5, 9);
    }
  });

  it("filmS is monotone and steepens the middle", () => {
    const f = filmS(0.8);
    let previous = -1;
    for (let i = 0; i <= 500; i++) {
      const y = f([i / 500, 0, 0])[0];
      expect(y).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = y;
    }
    expect(f([0.25, 0, 0])[0]).toBeLessThan(0.25);
    expect(f([0.75, 0, 0])[0]).toBeGreaterThan(0.75);
  });

  it("filmS at zero strength is the identity", () => {
    for (let i = 0; i <= 20; i++) {
      expect(filmS(0)([i / 20, 0, 0])[0]).toBeCloseTo(i / 20, 9);
    }
  });

  it("contrast pivots where it says it does", () => {
    const pivot = 0.435;
    expect(contrast(2)([pivot, pivot, pivot])[0]).toBeCloseTo(pivot, 9);
  });

  it("matte raises the black point and leaves white alone", () => {
    const m = matte(0.2, [0.5, 0.5, 0.5]);
    expect(m([0, 0, 0])[0]).toBeCloseTo(0.1, 9);
    expect(m([1, 1, 1])[0]).toBeCloseTo(1, 9);
  });

  it("softWhites lowers the white point and leaves black alone", () => {
    const s = softWhites(0.1);
    expect(s([0, 0, 0])[0]).toBeCloseTo(0, 9);
    expect(s([1, 1, 1])[0]).toBeCloseTo(0.9, 9);
  });

  it("liftGammaGain at its neutral settings changes nothing", () => {
    const step = liftGammaGain([0, 0, 0], [1, 1, 1], [1, 1, 1]);
    for (const c of samples(4)) {
      expect(step(c)[0]).toBeCloseTo(c[0], 9);
    }
  });

  it("asc at its neutral settings changes nothing", () => {
    const step = asc([1, 1, 1], [0, 0, 0], [1, 1, 1]);
    for (const c of samples(4)) {
      expect(step(c)[1]).toBeCloseTo(c[1], 9);
    }
  });
});

describe("colour moves", () => {
  it("splitTone tints shadows and highlights in opposite directions", () => {
    const step = splitTone([0.3, 0.5, 0.8], [0.8, 0.5, 0.3], 0.4);
    const shadow = step([0.1, 0.1, 0.1]);
    const highlight = step([0.9, 0.9, 0.9]);
    expect(shadow[2]).toBeGreaterThan(shadow[0]);
    expect(highlight[0]).toBeGreaterThan(highlight[2]);
  });

  it("splitTone with neutral ends changes nothing", () => {
    const step = splitTone([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], 0.5);
    for (const c of samples(4)) {
      expect(step(c)[0]).toBeCloseTo(c[0], 9);
    }
  });

  it("hueRotate leaves the neutral axis alone", () => {
    for (const v of [0, 0.25, 0.5, 1]) {
      const out = hueRotate(90)([v, v, v]);
      expect(out[0]).toBeCloseTo(v, 6);
      expect(out[1]).toBeCloseTo(v, 6);
      expect(out[2]).toBeCloseTo(v, 6);
    }
  });

  it("hueRotate by 360 is the identity", () => {
    const out = hueRotate(360)(RED);
    expect(out[0]).toBeCloseTo(RED[0], 6);
    expect(out[2]).toBeCloseTo(RED[2], 6);
  });

  it("monoMix produces a neutral, and its weights sum to one", () => {
    const out = monoMix([1, 2, 1])(RED);
    expect(out[0]).toBeCloseTo(out[1], 9);
    expect(out[1]).toBeCloseTo(out[2], 9);
    expect(monoMix([1, 1, 1])([1, 1, 1])[0]).toBeCloseTo(1, 9);
  });

  it("monoMix with a tone keeps the brightness it started with", () => {
    const plain = monoMix([0.3, 0.6, 0.1])(SKY);
    const toned = monoMix([0.3, 0.6, 0.1], [0.8, 0.6, 0.4])(SKY);
    expect(luma(toned)).toBeCloseTo(luma(plain), 6);
    expect(toned[0]).toBeGreaterThan(toned[2]);
  });

  it("bleachBypass at zero changes nothing and at one is fully overlaid", () => {
    for (const c of samples(4)) {
      expect(bleachBypass(0)(c)[0]).toBeCloseTo(c[0], 9);
    }
    // Contrast up and colour down, together — the coupling is the point.
    const before = chroma(RED);
    const after = chroma(bleachBypass(1)(RED));
    expect(after).toBeLessThan(before);
  });
});

describe("hueBand", () => {
  it("leaves neutrals untouched, whatever it is asked to do", () => {
    const step = hueBand({ center: 30, width: 90, satScale: 2, lumScale: 1.5 });
    for (const v of [0, 0.2, 0.5, 0.8, 1]) {
      const out = step([v, v, v]);
      expect(out[0]).toBeCloseTo(v, 6);
      expect(out[2]).toBeCloseTo(v, 6);
    }
  });

  it("changes a colour inside the band and not one outside it", () => {
    const step = hueBand({ center: 0, width: 40, satScale: 2 });
    const inside = step([0.8, 0.2, 0.2]);
    const outside = step([0.2, 0.2, 0.8]);
    expect(chroma(inside)).toBeGreaterThan(chroma([0.8, 0.2, 0.2]) * 1.2);
    expect(outside[2]).toBeCloseTo(0.8, 5);
  });

  it("falls off smoothly rather than stepping at the band edge", () => {
    // A hard edge here banks up as a visible contour across a gradient, and a
    // steep one is also what a 17-node cube cannot follow.
    const step = hueBand({ center: 60, width: 80, satScale: 1.8 });
    let previous: number | null = null;
    let worstJump = 0;
    for (let deg = 0; deg <= 120; deg += 1) {
      const c = hslToRgb([deg / 360, 0.6, 0.5]);
      const after = chroma(step(c)) / chroma(c);
      if (previous != null) {
        worstJump = Math.max(worstJump, Math.abs(after - previous));
      }
      previous = after;
    }
    expect(worstJump).toBeLessThan(0.05);
  });

  it("does nothing when every knob is at its default", () => {
    const step = hueBand({ center: 30, width: 90 });
    for (const c of samples(4)) {
      expect(step(c)[0]).toBeCloseTo(c[0], 6);
    }
  });
});

describe("HSL", () => {
  it("round-trips", () => {
    for (const c of samples(6)) {
      const back = hslToRgb(rgbToHsl(c));
      expect(back[0]).toBeCloseTo(c[0], 6);
      expect(back[1]).toBeCloseTo(c[1], 6);
      expect(back[2]).toBeCloseTo(c[2], 6);
    }
  });

  it("puts the primaries where they belong", () => {
    expect(rgbToHsl([1, 0, 0])[0] * 360).toBeCloseTo(0, 3);
    expect(rgbToHsl([0, 1, 0])[0] * 360).toBeCloseTo(120, 3);
    expect(rgbToHsl([0, 0, 1])[0] * 360).toBeCloseTo(240, 3);
  });

  it("reports zero saturation for a neutral", () => {
    expect(rgbToHsl(GREY)[1]).toBe(0);
  });
});

describe("camera log decodes", () => {
  // Each of these is the manufacturer's published formula. The properties
  // checked are the ones that hold for any log curve, so a transcription error
  // in a constant shows up as a failure rather than as a subtly wrong grade.
  const curves = Object.entries(logDecode);

  it.each(curves)("%s is monotone across its whole range", (_name, decode) => {
    let previous = -Infinity;
    for (let i = 0; i <= 1000; i++) {
      const y = decode(i / 1000);
      expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = y;
    }
  });

  it.each(curves)("%s is continuous across its piecewise join", (_name, decode) => {
    // Relative to the curve's own range, not to 0..1: a log decode is
    // exponential, and its output at full scale is tens of times 18% grey, so
    // the natural step near the top is already a per cent of the range. What a
    // transposed constant produces is a jump of *order the range*, which this
    // catches and an absolute bound would not.
    const range = decode(1) - decode(0);
    let worst = 0;
    for (let i = 1; i <= 1000; i++) {
      worst = Math.max(worst, Math.abs(decode(i / 1000) - decode((i - 1) / 1000)));
    }
    expect(worst).toBeLessThan(range * 0.02);
  });

  it.each(curves)("%s maps code zero to black or just under it", (_name, decode) => {
    // Log formats keep headroom below black, so code zero is a small negative
    // number rather than exactly zero — C-Log3 reaches -0.082. What would be
    // wrong is code zero landing anywhere *above* black.
    expect(decode(0)).toBeLessThan(0.005);
    expect(decode(0)).toBeGreaterThan(-0.15);
  });

  it.each(curves)("%s reaches well above 18%% grey at full scale", (_name, decode) => {
    expect(decode(1)).toBeGreaterThan(0.18);
  });

  it("logToRec709 produces a viewable range from a flat log signal", () => {
    const step = logToRec709(logDecode.slog3, 0.4);
    const dark = step([0.1, 0.1, 0.1]);
    const mid = step([0.4, 0.4, 0.4]);
    const bright = step([0.9, 0.9, 0.9]);
    expect(dark[0]).toBeLessThan(mid[0]);
    expect(mid[0]).toBeLessThan(bright[0]);
    // The whole point: log footage arrives flat and comes out with contrast.
    expect(bright[0] - dark[0]).toBeGreaterThan(0.9 - 0.1);
  });
});

describe("runSteps", () => {
  it("applies steps in order", () => {
    const out = runSteps([exposure(1), saturation(0)], RED);
    const expected = saturation(0)(exposure(1)(RED));
    expect(out[0]).toBeCloseTo(clamp01(expected[0]), 9);
  });

  it("clamps once, at the end", () => {
    // Clamping between steps would make a grade that briefly overshoots and
    // comes back a different grade from the one that was written.
    const out = runSteps([exposure(4), exposure(-4)], [0.5, 0.5, 0.5]);
    expect(out[0]).toBeCloseTo(0.5, 4);
  });

  it("returns everything inside 0..1", () => {
    for (const c of samples(5)) {
      const out = runSteps([exposure(3), saturation(3)], c);
      for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("with no steps is the identity", () => {
    expect(runSteps([], SKY)).toEqual(SKY);
  });
});

describe("channelCurve and rgbCurve", () => {
  it("rgbCurve applies the same curve everywhere", () => {
    const step = rgbCurve([
      [0, 0],
      [0.5, 0.7],
      [1, 1],
    ]);
    const out = step([0.5, 0.5, 0.5]);
    expect(out).toEqual([out[0], out[0], out[0]]);
    expect(out[0]).toBeCloseTo(0.7, 6);
  });

  it("channelCurve leaves an unspecified channel alone", () => {
    const step = channelCurve({
      r: [
        [0, 0.2],
        [1, 1],
      ],
    });
    const out = step([0, 0.4, 0.6]);
    expect(out[0]).toBeCloseTo(0.2, 6);
    expect(out[1]).toBe(0.4);
    expect(out[2]).toBe(0.6);
  });
});
