import { describe, it, expect } from "vitest";
import {
  backdropFxOf,
  backdropIntensityOf,
  backdropParamsOf,
  coerceBackdropFx,
  coerceFillOpacity,
  fillOpacityOf,
  sameBackdropFx,
} from "./backdropFx";
import type { BackdropFx, InlineProgram } from "../../@types/timeline";

const PIXELATE: BackdropFx = {
  presetId: "com.cartcut.pixelate",
  params: { size: 16, average: true },
  intensity: 80,
};

const PROGRAM = {
  hash: "0123456789abcdef",
  manifest: { schema: 1, kind: "effect", name: "x", category: "blur", render: {} },
  sources: { "main.frag": "vec4 effect(vec2 uv) { return getSourceColor(uv); }" },
} as InlineProgram;

describe("backdropFxOf", () => {
  it("answers a shape's backdrop by identity", () => {
    // A renderer caching on the object must keep its cache across frames.
    const shape = { filetype: "shape", backdropFx: PIXELATE };
    expect(backdropFxOf(shape)).toBe(PIXELATE);
  });

  it("is null for a shape with none, and for anything that is not a shape", () => {
    expect(backdropFxOf({ filetype: "shape" })).toBeNull();
    expect(backdropFxOf({ filetype: "video", backdropFx: PIXELATE })).toBeNull();
    expect(backdropFxOf(null)).toBeNull();
    expect(backdropFxOf(undefined)).toBeNull();
  });

  it("is null for a backdrop with no usable preset id, and never throws", () => {
    for (const backdropFx of [{}, { presetId: "" }, { presetId: 3 }, "pixelate", 7]) {
      expect(backdropFxOf({ filetype: "shape", backdropFx })).toBeNull();
    }
  });
});

describe("the read-side numbers", () => {
  it("clamps intensity and reads an unusable one as full strength", () => {
    expect(backdropIntensityOf(PIXELATE)).toBe(80);
    expect(backdropIntensityOf({ ...PIXELATE, intensity: 140 })).toBe(100);
    expect(backdropIntensityOf({ ...PIXELATE, intensity: -5 })).toBe(0);
    expect(backdropIntensityOf({ ...PIXELATE, intensity: NaN })).toBe(100);
    expect(backdropIntensityOf({ ...PIXELATE, intensity: "50" as any })).toBe(100);
  });

  it("reads params by identity, and anything but an object as none", () => {
    expect(backdropParamsOf(PIXELATE)).toBe(PIXELATE.params);
    expect(backdropParamsOf({ ...PIXELATE, params: null as any })).toEqual({});
    expect(backdropParamsOf({ ...PIXELATE, params: [1, 2] as any })).toEqual({});
  });

  it("reads an absent or unusable fill opacity as opaque", () => {
    expect(fillOpacityOf({ option: { fillColor: "#fff" } })).toBe(100);
    expect(fillOpacityOf({ option: { fillColor: "#fff", fillOpacity: 30 } })).toBe(30);
    expect(fillOpacityOf({ option: { fillOpacity: 250 } })).toBe(100);
    expect(fillOpacityOf({ option: { fillOpacity: "x" } })).toBe(100);
    expect(fillOpacityOf({})).toBe(100);
    expect(fillOpacityOf(null)).toBe(100);
  });
});

describe("coerceBackdropFx", () => {
  it("stores what it was given, with intensity defaulted and clamped", () => {
    expect(coerceBackdropFx({ presetId: "p" })).toEqual({
      presetId: "p",
      params: {},
      intensity: 100,
    });
    expect(coerceBackdropFx({ presetId: "p", intensity: 150 })?.intensity).toBe(100);
    expect(coerceBackdropFx({ presetId: "p", intensity: -1 })?.intensity).toBe(0);
  });

  it("keeps only the value types a parameter can hold", () => {
    const stored = coerceBackdropFx({
      presetId: "p",
      params: {
        size: 16,
        mode: "zoom",
        average: true,
        centre: [0.5, 0.25],
        broken: NaN,
        nested: { a: 1 } as any,
        badPoint: [1, "2"] as any,
      },
    });
    expect(stored?.params).toEqual({
      size: 16,
      mode: "zoom",
      average: true,
      centre: [0.5, 0.25],
    });
  });

  it("declines a missing preset id", () => {
    expect(coerceBackdropFx({ presetId: "" })).toBeNull();
    expect(coerceBackdropFx(null)).toBeNull();
  });

  it("declines an inline id with no program beside it", () => {
    // It could never draw, and with the fill made transparent for it the shape
    // would look like nothing at all.
    expect(coerceBackdropFx({ presetId: "inline.0123456789abcdef" })).toBeNull();
  });

  it("keeps a program exactly when the id is an inline one", () => {
    const inline = coerceBackdropFx({
      presetId: "inline.0123456789abcdef",
      program: PROGRAM,
    });
    expect(inline?.program).toBe(PROGRAM);

    const installed = coerceBackdropFx({ presetId: "p", program: PROGRAM });
    expect(installed).not.toHaveProperty("program");
  });
});

describe("coerceFillOpacity", () => {
  it("answers undefined at full strength, so the key is deleted", () => {
    expect(coerceFillOpacity(100)).toBeUndefined();
    expect(coerceFillOpacity(130)).toBeUndefined();
  });

  it("clamps the rest and refuses what is not a number", () => {
    expect(coerceFillOpacity(40)).toBe(40);
    expect(coerceFillOpacity(-3)).toBe(0);
    expect(coerceFillOpacity(NaN)).toBeNull();
    expect(coerceFillOpacity("50")).toBeNull();
  });
});

describe("sameBackdropFx", () => {
  it("compares by value, points included", () => {
    expect(sameBackdropFx(PIXELATE, { ...PIXELATE, params: { ...PIXELATE.params } })).toBe(true);
    const centred = { ...PIXELATE, params: { centre: [0.5, 0.5] } };
    expect(sameBackdropFx(centred, { ...PIXELATE, params: { centre: [0.5, 0.5] } })).toBe(true);
  });

  it("tells apart a different preset, strength, value or program", () => {
    expect(sameBackdropFx(PIXELATE, { ...PIXELATE, presetId: "other" })).toBe(false);
    expect(sameBackdropFx(PIXELATE, { ...PIXELATE, intensity: 79 })).toBe(false);
    expect(sameBackdropFx(PIXELATE, { ...PIXELATE, params: { size: 17, average: true } })).toBe(false);
    expect(sameBackdropFx(PIXELATE, { ...PIXELATE, program: PROGRAM })).toBe(false);
  });

  it("treats two absent backdrops as the same and one as different", () => {
    expect(sameBackdropFx(null, null)).toBe(true);
    expect(sameBackdropFx(PIXELATE, null)).toBe(false);
  });
});
