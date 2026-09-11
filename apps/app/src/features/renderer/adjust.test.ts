import { describe, expect, it } from "vitest";

import { COLOR_ADJUSTMENT_KEYS } from "../../@types/timeline";
import {
  adjustOf,
  clampAdjustment,
  coerceAdjustPatch,
  isAdjustNeutral,
  isAdjustmentKey,
  normalizeAdjustments,
  pickAdjustments,
  sameAdjustments,
} from "./adjust";
import { imageElement } from "./testing";

const withAdjust = (adjust: unknown) =>
  imageElement({ adjust } as Parameters<typeof imageElement>[0]);

describe("adjustOf — the read side never throws", () => {
  it("is null with no element, no field, or an empty field", () => {
    expect(adjustOf(undefined)).toBeNull();
    expect(adjustOf(null)).toBeNull();
    expect(adjustOf(imageElement({}))).toBeNull();
    expect(adjustOf(withAdjust({}))).toBeNull();
  });

  it("is null when every value is zero", () => {
    expect(adjustOf(withAdjust({ exposure: 0, contrast: 0 }))).toBeNull();
  });

  it("is null for a field that is not an object", () => {
    for (const junk of ["bright", 42, true, [1, 2, 3]]) {
      expect(adjustOf(withAdjust(junk))).toBeNull();
    }
  });

  it("drops values that are not finite numbers", () => {
    expect(
      adjustOf(
        withAdjust({
          exposure: "40",
          contrast: Number.NaN,
          saturation: Infinity,
          tint: null,
          shadows: 12,
        }),
      ),
    ).toEqual({ shadows: 12 });
  });

  it("drops keys that name no control — a field a newer build wrote", () => {
    expect(adjustOf(withAdjust({ hdr: 50, exposure: 10 }))).toEqual({ exposure: 10 });
  });

  it("clamps each value to its own range", () => {
    expect(
      adjustOf(withAdjust({ exposure: 250, contrast: -250, sharpen: 900, fade: -30 })),
    ).toEqual({ exposure: 100, contrast: -100, sharpen: 100 });
  });

  it("answers in the canonical key order, whatever order was stored", () => {
    const out = adjustOf(withAdjust({ vignette: 5, temperature: 7, exposure: 3 }));
    expect(Object.keys(out!)).toEqual(["temperature", "exposure", "vignette"]);
  });
});

describe("clampAdjustment", () => {
  it("knows bipolar from unipolar", () => {
    expect(clampAdjustment("exposure", -150)).toBe(-100);
    expect(clampAdjustment("sharpen", -150)).toBe(0);
    expect(clampAdjustment("vignette", -150)).toBe(-100);
    expect(clampAdjustment("fade", 150)).toBe(100);
  });

  it("answers zero for anything that is not a finite number", () => {
    expect(clampAdjustment("exposure", Number.NaN)).toBe(0);
    expect(clampAdjustment("exposure", "5")).toBe(0);
    expect(clampAdjustment("exposure", undefined)).toBe(0);
  });
});

describe("isAdjustNeutral", () => {
  it("is true for nothing, for zeros, and for values that clamp to zero", () => {
    expect(isAdjustNeutral(null)).toBe(true);
    expect(isAdjustNeutral({})).toBe(true);
    expect(isAdjustNeutral({ exposure: 0 })).toBe(true);
    expect(isAdjustNeutral({ sharpen: -5 })).toBe(true);
  });

  it("is false once anything moves", () => {
    for (const key of COLOR_ADJUSTMENT_KEYS) {
      expect(isAdjustNeutral({ [key]: 1 })).toBe(false);
    }
  });
});

describe("sameAdjustments", () => {
  it("ignores key order, zeros and absent keys", () => {
    expect(sameAdjustments({ exposure: 1, tint: 2 }, { tint: 2, exposure: 1, fade: 0 })).toBe(true);
    expect(sameAdjustments(null, {})).toBe(true);
    expect(sameAdjustments(undefined, { contrast: 0 })).toBe(true);
  });

  it("compares after clamping, because that is what renders", () => {
    expect(sameAdjustments({ exposure: 400 }, { exposure: 100 })).toBe(true);
  });

  it("tells different settings apart", () => {
    expect(sameAdjustments({ exposure: 1 }, { exposure: 2 })).toBe(false);
    expect(sameAdjustments({ exposure: 1 }, {})).toBe(false);
  });
});

describe("normalizeAdjustments", () => {
  it("answers a fresh object every time", () => {
    const input = { exposure: 5 };
    const out = normalizeAdjustments(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });
});

describe("coerceAdjustPatch — the write side reports", () => {
  it("refuses something that is not an object", () => {
    for (const junk of [null, undefined, 3, "x", [1]]) {
      expect(coerceAdjustPatch(junk).ok).toBe(false);
    }
  });

  it("names an unknown key in the error", () => {
    const result = coerceAdjustPatch({ exposure: 10, glow: 5 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('"glow"');
  });

  it("refuses a value that is not a finite number", () => {
    for (const bad of ["10", Number.NaN, Infinity, null, {}]) {
      const result = coerceAdjustPatch({ exposure: bad });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain('"exposure"');
    }
  });

  it("keeps zeros, because a zero is how one slider is reset", () => {
    expect(coerceAdjustPatch({ exposure: 0, contrast: 10 })).toEqual({
      ok: true,
      patch: { exposure: 0, contrast: 10 },
    });
  });

  it("clamps rather than refusing a value past the end of the slider", () => {
    expect(coerceAdjustPatch({ exposure: 180, sharpen: -4 })).toEqual({
      ok: true,
      patch: { exposure: 100, sharpen: 0 },
    });
  });

  it("accepts an empty patch as a no-op", () => {
    expect(coerceAdjustPatch({})).toEqual({ ok: true, patch: {} });
  });
});

describe("helpers", () => {
  it("isAdjustmentKey knows exactly the fifteen", () => {
    for (const key of COLOR_ADJUSTMENT_KEYS) expect(isAdjustmentKey(key)).toBe(true);
    expect(isAdjustmentKey("hue")).toBe(false);
    expect(isAdjustmentKey("toString")).toBe(false);
  });

  it("pickAdjustments keeps only the named, non-zero keys", () => {
    expect(
      pickAdjustments({ exposure: 5, sharpen: 10, fade: 0 }, ["sharpen", "fade", "clarity"]),
    ).toEqual({ sharpen: 10 });
  });
});
