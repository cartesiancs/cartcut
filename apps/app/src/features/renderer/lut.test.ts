import { describe, expect, it } from "vitest";

import {
  DEFAULT_LUT_INTENSITY,
  clampIntensity,
  coerceLutRef,
  isLutActive,
  lutOf,
} from "./lut";
import { imageElement } from "./testing";

/**
 * The same two-tempered split `blend.test.ts` covers: `lutOf` runs in the paint
 * loop and must never throw, `coerceLutRef` runs once at a write boundary and
 * may refuse.
 */

describe("lutOf", () => {
  it("reads a well-formed grade", () => {
    expect(lutOf(imageElement({ lut: { presetId: "a", intensity: 60 } }))).toEqual({
      presetId: "a",
      intensity: 60,
    });
  });

  it("answers null for a clip with no grade", () => {
    expect(lutOf(imageElement({}))).toBeNull();
  });

  // Every one of these is reachable: a hand-edited timeline.json, a project
  // written by a newer build, an element that came in over IPC.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "kodak"],
    ["a number", 7],
    ["an array", []],
    ["an empty object", {}],
    ["a missing presetId", { intensity: 50 }],
    ["an empty presetId", { presetId: "", intensity: 50 }],
    ["a non-string presetId", { presetId: 3, intensity: 50 }],
  ])("answers null rather than throwing for %s", (_name, lut) => {
    expect(lutOf(imageElement({ lut } as never))).toBeNull();
  });

  it.each([
    ["a missing intensity", undefined, DEFAULT_LUT_INTENSITY],
    ["a string intensity", "80", DEFAULT_LUT_INTENSITY],
    ["a NaN intensity", Number.NaN, DEFAULT_LUT_INTENSITY],
    ["an Infinity intensity", Number.POSITIVE_INFINITY, DEFAULT_LUT_INTENSITY],
    ["a negative intensity", -20, 0],
    ["an intensity past 100", 400, 100],
  ])("repairs %s on the way out", (_name, intensity, want) => {
    expect(
      lutOf(imageElement({ lut: { presetId: "a", intensity } } as never))?.intensity,
    ).toBe(want);
  });

  it("never throws for anything at all", () => {
    for (const value of [Symbol("x"), () => undefined, new Date(), 0n]) {
      expect(() => lutOf(imageElement({ lut: value } as never))).not.toThrow();
    }
    expect(lutOf(undefined)).toBeNull();
    expect(lutOf(null)).toBeNull();
  });
});

describe("isLutActive", () => {
  it("is false with no grade", () => {
    expect(isLutActive(null)).toBe(false);
  });

  // An intensity of zero is a stored A/B — the LUT stays on the clip — but the
  // frame can still take the untouched fast path.
  it("is false at zero strength, which is a stored A/B rather than a clear", () => {
    expect(isLutActive({ presetId: "a", intensity: 0 })).toBe(false);
  });

  it("is true at any strength above zero", () => {
    expect(isLutActive({ presetId: "a", intensity: 1 })).toBe(true);
    expect(isLutActive({ presetId: "a", intensity: 100 })).toBe(true);
  });
});

describe("coerceLutRef", () => {
  it("accepts a well-formed reference", () => {
    expect(coerceLutRef({ presetId: "a", intensity: 60 })).toEqual({
      presetId: "a",
      intensity: 60,
    });
  });

  it("defaults an omitted intensity to full strength", () => {
    expect(coerceLutRef({ presetId: "a" })?.intensity).toBe(100);
  });

  it("clamps a number that is out of range", () => {
    expect(coerceLutRef({ presetId: "a", intensity: 250 })?.intensity).toBe(100);
    expect(coerceLutRef({ presetId: "a", intensity: -1 })?.intensity).toBe(0);
  });

  // Unlike `lutOf`, a write refuses rather than substituting: a caller here can
  // be told it got something wrong, and quietly reading 100 for a mistyped
  // number would hide the mistake until someone noticed the grade was strong.
  it.each([
    ["a string intensity", { presetId: "a", intensity: "60" }],
    ["a NaN intensity", { presetId: "a", intensity: Number.NaN }],
    ["no presetId", { intensity: 60 }],
    ["a blank presetId", { presetId: "   ", intensity: 60 }],
    ["null", null],
    ["a string", "kodak"],
  ])("refuses %s", (_name, value) => {
    expect(coerceLutRef(value)).toBeNull();
  });
});

describe("clampIntensity", () => {
  it("passes a value in range through untouched", () => {
    expect(clampIntensity(37.5)).toBe(37.5);
  });

  it("answers full strength for anything that is not a finite number", () => {
    expect(clampIntensity("x")).toBe(100);
    expect(clampIntensity(undefined)).toBe(100);
    expect(clampIntensity(Number.NaN)).toBe(100);
  });
});
