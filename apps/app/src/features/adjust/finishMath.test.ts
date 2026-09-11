import { describe, expect, it } from "vitest";

import { chroma, type Rgb } from "../lut/colorMath";
import { mulberry32 } from "../renderer/testing";
import {
  BLUR_TAPS,
  TENT_3X3,
  blurStepFor,
  clarityPixel,
  clarityRadiusDevice,
  fadePixel,
  finishPixel,
  grainOffsetFor,
  grainPixel,
  grainWeight,
  hash12,
  luma,
  midtoneWeight,
  sharpenPixel,
  vignettePixel,
  vignetteWeight,
  type FinishAmounts,
  type FinishInputs,
} from "./finishMath";
import {
  CLARITY_RADIUS_FRACTION,
  FADE_BLACK,
  FADE_WHITE,
  VIGNETTE_STRENGTH,
} from "./spec";

const NONE: FinishAmounts = { clarity: 0, sharpen: 0, particles: 0, fade: 0, vignette: 0 };

function inputs(over: Partial<FinishInputs> = {}): FinishInputs {
  return {
    blurredLuma: 0.5,
    blurredRgb: [0.5, 0.5, 0.5],
    u: 0.5,
    v: 0.5,
    noise: 0.5,
    ...over,
  };
}

describe("kernels", () => {
  it("the blur is nine normalised, symmetric taps peaking in the middle", () => {
    expect(BLUR_TAPS).toHaveLength(9);
    const total = BLUR_TAPS.reduce((sum, tap) => sum + tap.weight, 0);
    expect(total).toBeCloseTo(1, 12);
    for (let i = 0; i < 4; i++) {
      expect(BLUR_TAPS[i].weight).toBeCloseTo(BLUR_TAPS[8 - i].weight, 15);
      expect(BLUR_TAPS[i].offset).toBe(-BLUR_TAPS[8 - i].offset);
      expect(BLUR_TAPS[i].weight).toBeLessThan(BLUR_TAPS[i + 1].weight);
    }
  });

  it("the tent is normalised and has no directional bias", () => {
    const total = TENT_3X3.reduce((sum, tap) => sum + tap.weight, 0);
    expect(total).toBeCloseTo(1, 15);
    const mean = TENT_3X3.reduce(
      (acc, tap) => [acc[0] + tap.dx * tap.weight, acc[1] + tap.dy * tap.weight],
      [0, 0],
    );
    expect(mean[0]).toBeCloseTo(0, 15);
    expect(mean[1]).toBeCloseTo(0, 15);
  });

  it("clarity's radius is a share of the clip's shorter side, in device pixels", () => {
    expect(clarityRadiusDevice(1920, 1080, 1)).toBeCloseTo(1080 * CLARITY_RADIUS_FRACTION, 9);
    // Zoomed to half, half as many device pixels — the same share of the picture.
    expect(clarityRadiusDevice(1920, 1080, 0.5)).toBeCloseTo(540 * CLARITY_RADIUS_FRACTION, 9);
    expect(clarityRadiusDevice(100, 400, 1)).toBeCloseTo(100 * CLARITY_RADIUS_FRACTION, 9);
    expect(blurStepFor(8)).toBe(2);
  });
});

describe("weights", () => {
  it("midtoneWeight is 0 at the ends and 1 at mid grey", () => {
    expect(midtoneWeight(0)).toBe(0);
    expect(midtoneWeight(1)).toBe(0);
    expect(midtoneWeight(0.5)).toBe(1);
    expect(midtoneWeight(-3)).toBe(0);
    expect(midtoneWeight(0.25)).toBeCloseTo(midtoneWeight(0.75), 12);
  });

  it("grainWeight is 0 at the ends and 1 at mid grey", () => {
    expect(grainWeight(0)).toBe(0);
    expect(grainWeight(1)).toBe(0);
    expect(grainWeight(0.5)).toBe(1);
    expect(grainWeight(2)).toBe(0);
  });
});

describe("clarity", () => {
  it("does nothing where the neighbourhood matches the pixel", () => {
    const c: Rgb = [0.3, 0.5, 0.6];
    expect(clarityPixel(c, luma(c), 0.8)).toEqual(c);
  });

  it("pushes a pixel brighter than its surroundings further up, and a darker one down", () => {
    const c: Rgb = [0.5, 0.5, 0.5];
    expect(clarityPixel(c, 0.4, 0.8)[0]).toBeGreaterThan(0.5);
    expect(clarityPixel(c, 0.6, 0.8)[0]).toBeLessThan(0.5);
  });

  it("changes contrast, not hue — one delta on every channel", () => {
    const c: Rgb = [0.6, 0.4, 0.3];
    const out = clarityPixel(c, 0.3, 0.8);
    expect(out[0] - c[0]).toBeCloseTo(out[1] - c[1], 12);
    expect(out[1] - c[1]).toBeCloseTo(out[2] - c[2], 12);
  });

  it("leaves black and white alone", () => {
    expect(clarityPixel([0, 0, 0], 0.5, 0.8)).toEqual([0, 0, 0]);
    expect(clarityPixel([1, 1, 1], 0.5, 0.8)).toEqual([1, 1, 1]);
  });
});

describe("sharpen", () => {
  it("does nothing on a flat area", () => {
    const c: Rgb = [0.2, 0.4, 0.8];
    expect(sharpenPixel(c, c, 1.6)).toEqual(c);
  });

  it("overshoots away from the blurred copy", () => {
    expect(sharpenPixel([0.6, 0.6, 0.6], [0.5, 0.5, 0.5], 1)[0]).toBeCloseTo(0.7, 12);
    expect(sharpenPixel([0.4, 0.4, 0.4], [0.5, 0.5, 0.5], 1)[0]).toBeCloseTo(0.3, 12);
  });
});

describe("fade", () => {
  it("is the identity at zero", () => {
    const c: Rgb = [0.2, 0.7, 0.9];
    expect(fadePixel(c, 0)).toEqual(c);
  });

  it("lifts black and pulls white down", () => {
    expect(fadePixel([0, 0, 0], 1)[0]).toBeCloseTo(FADE_BLACK, 12);
    expect(fadePixel([1, 1, 1], 1)[0]).toBeCloseTo(1 - FADE_WHITE, 12);
  });

  it("takes some colour out", () => {
    const c: Rgb = [0.8, 0.3, 0.2];
    expect(chroma(fadePixel(c, 1))).toBeLessThan(chroma(c));
  });

  it("never inverts a ramp, at any amount", () => {
    for (const amount of [0.1, 0.5, 1]) {
      let previous = -Infinity;
      for (let i = 0; i <= 255; i++) {
        const y = fadePixel([i / 255, i / 255, i / 255], amount)[0];
        expect(y).toBeGreaterThan(previous);
        previous = y;
      }
    }
  });
});

describe("vignette", () => {
  it("is zero in the middle and full at the corners", () => {
    expect(vignetteWeight(0.5, 0.5)).toBe(0);
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      expect(vignetteWeight(u, v)).toBeGreaterThan(0.95);
    }
  });

  it("is symmetric about both axes", () => {
    const random = mulberry32(5);
    for (let i = 0; i < 50; i++) {
      const u = random();
      const v = random();
      expect(vignetteWeight(u, v)).toBeCloseTo(vignetteWeight(1 - u, v), 12);
      expect(vignetteWeight(u, v)).toBeCloseTo(vignetteWeight(u, 1 - v), 12);
    }
  });

  it("follows the clip's box — the middle of every edge is alike", () => {
    // Each axis is normalised by its own side, so the shape is the box's
    // ellipse whatever the aspect.
    expect(vignetteWeight(0.5, 0)).toBeCloseTo(vignetteWeight(0, 0.5), 12);
  });

  it("rises monotonically from the centre outward", () => {
    let previous = -Infinity;
    for (let i = 0; i <= 50; i++) {
      const w = vignetteWeight(0.5 + i / 100, 0.5 + i / 100);
      expect(w).toBeGreaterThanOrEqual(previous);
      previous = w;
    }
  });

  it("darkens when positive and lightens when negative", () => {
    const c: Rgb = [0.5, 0.5, 0.5];
    expect(vignettePixel(c, 1, 1)[0]).toBeCloseTo(0.5 * (1 - VIGNETTE_STRENGTH), 12);
    expect(vignettePixel(c, 1, -1)[0]).toBeCloseTo(0.5 + 0.5 * VIGNETTE_STRENGTH, 12);
    expect(vignettePixel(c, 0, 1)).toEqual(c);
  });
});

describe("grain", () => {
  it("hash12 is deterministic and inside 0-1", () => {
    const random = mulberry32(3);
    for (let i = 0; i < 1000; i++) {
      const x = Math.floor(random() * 4000);
      const y = Math.floor(random() * 4000);
      const h = hash12(x, y);
      expect(h).toBe(hash12(x, y));
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });

  it("hash12 is close to uniform — no bin of ten is far from a tenth", () => {
    const bins = new Array(10).fill(0);
    const n = 40_000;
    for (let i = 0; i < n; i++) {
      bins[Math.floor(hash12(i % 200, Math.floor(i / 200)) * 10)]++;
    }
    for (const count of bins) {
      expect(count / n).toBeGreaterThan(0.08);
      expect(count / n).toBeLessThan(0.12);
    }
  });

  it("re-rolls on every frame and holds still within one", () => {
    expect(grainOffsetFor(1000)).toEqual(grainOffsetFor(1000.3));
    expect(grainOffsetFor(1000)).not.toEqual(grainOffsetFor(1017));
    // 240fps is the top of the rate band, and its frames are ~4ms apart.
    expect(grainOffsetFor(1000)).not.toEqual(grainOffsetFor(1004));
    for (const v of grainOffsetFor(123456)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(512);
    }
  });

  it("adds nothing to black or white", () => {
    expect(grainPixel([0, 0, 0], 0.9, 0.18)).toEqual([0, 0, 0]);
    expect(grainPixel([1, 1, 1], 0.1, 0.18)).toEqual([1, 1, 1]);
  });

  it("averages out to nothing on mid grey", () => {
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      sum += grainPixel([0.5, 0.5, 0.5], hash12(i, 7), 0.18)[0] - 0.5;
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.002);
  });
});

describe("finishPixel", () => {
  it("is the identity with every stage at zero", () => {
    const random = mulberry32(8);
    for (let i = 0; i < 100; i++) {
      const c: Rgb = [random(), random(), random()];
      const out = finishPixel(c, inputs({ u: random(), v: random() }), NONE);
      expect(out[0]).toBe(c[0]);
      expect(out[1]).toBe(c[1]);
      expect(out[2]).toBe(c[2]);
    }
  });

  it("runs fade before the vignette", () => {
    const c: Rgb = [0.4, 0.5, 0.6];
    const out = finishPixel(c, inputs({ u: 0, v: 0 }), { ...NONE, fade: 1, vignette: 1 });
    const expected = vignettePixel(fadePixel(c, 1), vignetteWeight(0, 0), 1);
    for (let k = 0; k < 3; k++) {
      expect(out[k]).toBeCloseTo(expected[k], 12);
    }
  });

  it("measures sharpen on the source, not on what clarity made", () => {
    const src: Rgb = [0.5, 0.5, 0.5];
    const blurredRgb: Rgb = [0.45, 0.45, 0.45];
    const out = finishPixel(
      src,
      inputs({ blurredLuma: 0.4, blurredRgb }),
      { ...NONE, clarity: 0.8, sharpen: 1 },
    );
    const afterClarity = clarityPixel(src, 0.4, 0.8)[0];
    expect(out[0]).toBeCloseTo(afterClarity + (0.5 - 0.45) * 1, 12);
  });

  it("puts grain over the vignette rather than darkening it with the rest", () => {
    // At a corner the vignette has pulled the colour toward black, so the grain
    // weight is read from the vignetted colour — grain is on the surface.
    const c: Rgb = [0.5, 0.5, 0.5];
    const corner = inputs({ u: 0, v: 0, noise: 1 });
    const out = finishPixel(c, corner, { ...NONE, vignette: 1, particles: 0.18 });
    const vignetted = vignettePixel(c, vignetteWeight(0, 0), 1);
    const expected = grainPixel(vignetted, 1, 0.18);
    expect(out[0]).toBeCloseTo(expected[0], 12);
  });

  it("always answers a colour inside 0-1", () => {
    const random = mulberry32(21);
    for (let i = 0; i < 500; i++) {
      const out = finishPixel(
        [random(), random(), random()],
        inputs({
          blurredLuma: random(),
          blurredRgb: [random(), random(), random()],
          u: random() * 1.4 - 0.2,
          v: random() * 1.4 - 0.2,
          noise: random(),
        }),
        {
          clarity: random() * 0.8,
          sharpen: random() * 1.6,
          particles: random() * 0.18,
          fade: random(),
          vignette: random() * 2 - 1,
        },
      );
      for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});
