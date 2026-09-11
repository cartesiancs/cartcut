import { afterEach, describe, expect, it } from "vitest";

import type { ColorAdjustments } from "../../@types/timeline";
import { clamp01 } from "../lut/colorMath";
import { isIdentity } from "../lut/lutData";
import { sampleLut } from "../lut/sample";
import { mulberry32 } from "../renderer/testing";
import {
  TONE_LUT_SIZE,
  bakeToneLut,
  clearToneLutCache,
  toneKey,
  toneLutFor,
} from "./bake";
import { TONE_KEYS } from "./spec";
import { toneStep } from "./tone";

/**
 * The baked table is a sampling of `toneStep`. What makes it safe to ship is
 * that sampling it back — through the same tetrahedral `sampleLut` the CPU
 * applier uses and the shader is pinned to — lands within one 8-bit step of
 * evaluating the function directly. If a slider change ever breaks that, this
 * suite is where it shows, and the fix is a larger table, not a looser test.
 */

afterEach(() => clearToneLutCache());

function worstError(values: ColorAdjustments, samples: number[][]): number {
  const lut = bakeToneLut(values);
  const step = toneStep(values);
  let worst = 0;
  for (const [r, g, b] of samples) {
    // Clamped after the lookup, as both appliers clamp: the table holds the
    // unclamped function, so this is exactly what reaches a pixel.
    const baked = sampleLut(lut, r, g, b, "tetrahedral");
    const direct = step([r, g, b]);
    worst = Math.max(
      worst,
      Math.abs(clamp01(baked.r) - direct[0]),
      Math.abs(clamp01(baked.g) - direct[1]),
      Math.abs(clamp01(baked.b) - direct[2]),
    );
  }
  return worst * 255;
}

/** Every 8-bit level on the grey axis, a 16³ grid, and random colours. */
function samples(): number[][] {
  const out: number[][] = [];
  for (let v = 0; v < 256; v++) out.push([v / 255, v / 255, v / 255]);
  for (let r = 0; r < 16; r++)
    for (let g = 0; g < 16; g++)
      for (let b = 0; b < 16; b++) out.push([r / 15, g / 15, b / 15]);
  const random = mulberry32(11);
  for (let i = 0; i < 1500; i++) out.push([random(), random(), random()]);
  return out;
}

const SAMPLES = samples();

describe("bake accuracy", () => {
  it(`is a ${TONE_LUT_SIZE}³ cube`, () => {
    const lut = bakeToneLut({ exposure: 10 });
    expect(lut.kind).toBe("3d");
    expect(lut.size).toBe(TONE_LUT_SIZE);
  });

  for (const key of TONE_KEYS) {
    for (const v of [-100, -40, 40, 100]) {
      it(`${key}=${v} is within one 8-bit step of the direct evaluation`, () => {
        expect(worstError({ [key]: v }, SAMPLES)).toBeLessThanOrEqual(1);
      });
    }
  }

  it("holds for combinations too", () => {
    const combos: ColorAdjustments[] = [
      { temperature: 60, exposure: 40, contrast: 50, saturation: 30 },
      { tint: -50, highlights: -80, shadows: 70, brilliance: 40 },
      { whites: 100, blacks: -100, contrast: 100 },
      { exposure: -100, shadows: 100, saturation: -100 },
      { temperature: -100, tint: 100, brilliance: -100, contrast: -100 },
      // The measured worst case under piecewise sRGB: 5.2 steps at 33³ and
      // still 1.8 at 65³, all of it near black. `spec.ts#DISPLAY_GAMMA` is
      // the fix, and this is where it is held.
      { temperature: 100, exposure: 100, saturation: 100 },
      { temperature: -100, tint: -100, exposure: 100, whites: 100 },
    ];
    for (const values of combos) {
      expect(worstError(values, SAMPLES), JSON.stringify(values)).toBeLessThanOrEqual(1);
    }
  });

  it("bakes neutral settings to an exact identity", () => {
    expect(isIdentity(bakeToneLut({}))).toBe(true);
    expect(isIdentity(bakeToneLut({ sharpen: 100, vignette: -50 }))).toBe(true);
  });
});

describe("toneKey", () => {
  it("is null for neutral settings", () => {
    expect(toneKey({})).toBeNull();
    expect(toneKey({ exposure: 0, contrast: 0 })).toBeNull();
  });

  it("ignores the effects group, so finishing never re-bakes the tone", () => {
    expect(toneKey({ sharpen: 50, fade: 20, vignette: -10 })).toBeNull();
    expect(toneKey({ exposure: 10, sharpen: 50 })).toBe(toneKey({ exposure: 10 }));
  });

  it("does not depend on key order or on zero keys", () => {
    expect(toneKey({ exposure: 10, contrast: -5 })).toBe(
      toneKey({ contrast: -5, exposure: 10, shadows: 0 }),
    );
  });

  it("differs whenever the picture would", () => {
    expect(toneKey({ exposure: 10 })).not.toBe(toneKey({ exposure: 11 }));
    expect(toneKey({ exposure: 10 })).not.toBe(toneKey({ contrast: 10 }));
  });

  it("cannot collide with a preset id", () => {
    expect(toneKey({ exposure: 1 })).toMatch(/^adjust:/);
  });
});

describe("toneLutFor", () => {
  it("is null for neutral settings", () => {
    expect(toneLutFor({})).toBeNull();
    expect(toneLutFor({ particles: 40 })).toBeNull();
  });

  it("bakes once and hands the same table back", () => {
    const a = toneLutFor({ exposure: 20 });
    const b = toneLutFor({ exposure: 20 });
    expect(a).not.toBeNull();
    expect(b!.lut).toBe(a!.lut);
    expect(b!.key).toBe(a!.key);
  });

  it("bakes a different table for different settings", () => {
    const a = toneLutFor({ exposure: 20 });
    const b = toneLutFor({ exposure: 21 });
    expect(b!.lut).not.toBe(a!.lut);
  });

  it("evicts the oldest table rather than growing forever", () => {
    const first = toneLutFor({ exposure: 1 })!.lut;
    for (let i = 2; i <= 40; i++) toneLutFor({ exposure: i });
    expect(toneLutFor({ exposure: 1 })!.lut).not.toBe(first);
  });
});
