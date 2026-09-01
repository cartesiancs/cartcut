import { describe, expect, it } from "vitest";

import type { MaskType } from "../../@types/timeline";
import {
  DEFAULT_MASK_FEATHER,
  DEFAULT_MASK_ROUNDNESS,
  coerceMask,
  coerceMaskShape,
  defaultMask,
  isMaskActive,
  maskOf,
  sameMask,
} from "./maskShape";

/** A mask that is valid in every field, to mutate one thing at a time from. */
function good(patch: Partial<MaskType> = {}): MaskType {
  return { ...defaultMask("rectangle"), ...patch };
}

describe("maskOf — the read guard", () => {
  it("answers null for an element with no mask", () => {
    expect(maskOf(null)).toBeNull();
    expect(maskOf(undefined)).toBeNull();
    expect(maskOf({} as any)).toBeNull();
    expect(maskOf({ mask: null } as any)).toBeNull();
  });

  // It runs once per element per frame. Everything below used to be a way to
  // put a black frame on screen with nothing in the console to say why.
  it.each([
    ["a string", "rectangle"],
    ["a number", 3],
    ["an array", []],
    ["a mask with no shape", { location: { x: 50, y: 50 } }],
    ["a mask with an unknown shape", { shape: "octagon" }],
    ["a mask with a numeric shape", { shape: 7 }],
  ])("answers null for %s and does not throw", (_label, mask) => {
    expect(() => maskOf({ mask } as any)).not.toThrow();
    expect(maskOf({ mask } as any)).toBeNull();
  });

  it("fills in every missing field with its default", () => {
    const mask = maskOf({ mask: { shape: "star" } } as any);
    expect(mask).toEqual(defaultMask("star"));
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["a string", "40"],
    ["null", null],
    ["undefined", undefined],
  ])("replaces a %s location with the default rather than propagating it", (_l, value) => {
    const mask = maskOf({ mask: { shape: "rectangle", location: { x: value, y: 10 } } } as any);
    expect(mask?.location).toEqual({ x: 50, y: 10 });
  });

  // A location outside the box is a wipe, not a mistake: sliding a mask off the
  // edge over time is how a reveal is animated.
  it("keeps a location outside the element box", () => {
    const mask = maskOf({ mask: { shape: "rectangle", location: { x: -80, y: 300 } } } as any);
    expect(mask?.location).toEqual({ x: -80, y: 300 });
  });

  // A negative size would mirror the shape through its own centre, which is a
  // different picture rather than a smaller one.
  it("floors a negative size at zero", () => {
    const mask = maskOf({ mask: { shape: "rectangle", size: { width: -20, height: 40 } } } as any);
    expect(mask?.size).toEqual({ width: 0, height: 40 });
  });

  it("floors a negative feather at zero and clamps roundness to 0-100", () => {
    const mask = maskOf({
      mask: { shape: "rectangle", feather: -5, roundness: 400 },
    } as any);
    expect(mask?.feather).toBe(0);
    expect(mask?.roundness).toBe(100);
  });

  it("keeps invert only when it is exactly true", () => {
    expect(maskOf({ mask: { shape: "rectangle", invert: true } } as any)?.invert).toBe(true);
    expect(maskOf({ mask: { shape: "rectangle", invert: 1 } } as any)?.invert).toBeUndefined();
    expect(maskOf({ mask: { shape: "rectangle", invert: false } } as any)?.invert).toBeUndefined();
  });

  describe("the pen path", () => {
    const node = (x: number, y: number) => ({ p: [x, y] });

    it("keeps a well-formed path", () => {
      const path = [node(-0.5, -0.5), node(0.5, -0.5), node(0, 0.5)];
      expect(maskOf({ mask: { shape: "pen", path } } as any)?.path).toEqual(path);
    });

    it("keeps handles as offsets, and drops one that is malformed", () => {
      const path = [
        { p: [0, 0], cs: [-0.1, 0], ce: [0.1, 0] },
        { p: [1, 0], cs: ["x", 0], ce: [0.1, NaN] },
        { p: [0, 1] },
      ];
      const kept = maskOf({ mask: { shape: "pen", path } } as any)?.path;
      expect(kept?.[0]).toEqual({ p: [0, 0], cs: [-0.1, 0], ce: [0.1, 0] });
      // A half-read handle is worse than no handle: it would bend the curve
      // somewhere nobody asked for. Both go, and the node becomes a corner.
      expect(kept?.[1]).toEqual({ p: [1, 0] });
      expect(kept?.[2]).toEqual({ p: [0, 1] });
    });

    it.each([
      ["not an array", "nope"],
      ["holding a non-node", [1, 2, 3]],
      ["holding a node with a short anchor", [{ p: [0] }]],
      ["holding a node with a non-finite anchor", [{ p: [0, NaN] }]],
    ])("drops a path that is %s", (_label, path) => {
      expect(maskOf({ mask: { shape: "pen", path } } as any)?.path).toBeUndefined();
    });

    it("drops the path entirely on any shape that is not pen", () => {
      const path = [node(0, 0), node(1, 0), node(0, 1)];
      expect(maskOf({ mask: { shape: "star", path } } as any)?.path).toBeUndefined();
    });
  });
});

describe("isMaskActive — whether the mask cuts anything", () => {
  it("is true for each built-in shape", () => {
    for (const shape of ["rectangle", "star", "heart"] as const) {
      expect(isMaskActive(defaultMask(shape))).toBe(true);
    }
  });

  it("is false for no mask at all", () => {
    expect(isMaskActive(null)).toBe(false);
  });

  // The same contract a LUT that is not installed has: it renders as a
  // pass-through rather than as a hole. It is also what stops the clip
  // disappearing after the first click of a pen stroke.
  it.each([
    ["no path", undefined],
    ["an empty path", []],
    ["one node", [{ p: [0, 0] as [number, number] }]],
    ["two nodes", [{ p: [0, 0] as [number, number] }, { p: [1, 0] as [number, number] }]],
  ])("is false for a pen mask with %s", (_label, path) => {
    expect(isMaskActive(good({ shape: "pen", path }))).toBe(false);
  });

  it("is true for a pen mask with three nodes", () => {
    const path = [{ p: [0, 0] }, { p: [1, 0] }, { p: [0, 1] }] as any;
    expect(isMaskActive(good({ shape: "pen", path }))).toBe(true);
  });

  // A mask scaled to nothing hides the clip. That is a real, reachable frame of
  // an animation and not an inert mask, so it must not take the fast path.
  it("is true for a mask of zero size", () => {
    expect(isMaskActive(good({ size: { width: 0, height: 0 } }))).toBe(true);
  });
});

describe("coerceMask — the write validator", () => {
  it("accepts a well-formed mask unchanged", () => {
    const mask = good({ rotation: 30, feather: 12, roundness: 50 });
    expect(coerceMask(mask)).toEqual(mask);
  });

  // Unlike `maskOf`, a write refuses rather than defaulting: this is the one
  // place a caller can be told it got something wrong, and quietly substituting
  // 50 for a mistyped number hides the mistake until someone sees the picture.
  it.each([
    ["a null", null],
    ["a string", "rectangle"],
    ["an unknown shape", { ...good(), shape: "octagon" }],
    ["a non-finite location", { ...good(), location: { x: NaN, y: 0 } }],
    ["a location that is not an object", { ...good(), location: 5 }],
    ["a non-finite size", { ...good(), size: { width: 10, height: Infinity } }],
    ["a non-finite rotation", { ...good(), rotation: NaN }],
    ["a non-numeric feather", { ...good(), feather: "8" }],
    ["a pen mask with a malformed path", { ...good(), shape: "pen", path: [{ p: [0] }] }],
  ])("refuses %s", (_label, value) => {
    expect(coerceMask(value)).toBeNull();
  });

  it("clamps rather than refuses where the range is a preference", () => {
    expect(coerceMask({ ...good(), roundness: 140 })?.roundness).toBe(100);
    expect(coerceMask({ ...good(), feather: -3 })?.feather).toBe(0);
    expect(coerceMask({ ...good(), size: { width: -1, height: 20 } })?.size.width).toBe(0);
  });

  it("fills in the fields a caller left out", () => {
    const mask = coerceMask({ shape: "heart" });
    expect(mask).toEqual(defaultMask("heart"));
  });
});

describe("coerceMaskShape", () => {
  it("accepts every member of the union and nothing else", () => {
    for (const shape of ["rectangle", "star", "heart", "pen"] as const) {
      expect(coerceMaskShape(shape)).toBe(shape);
    }
    // Exact match only, like `coerceBlend`: a near miss is a bug upstream.
    for (const junk of ["Rectangle", " star", "circle", 3, null, undefined]) {
      expect(coerceMaskShape(junk)).toBeNull();
    }
  });
});

describe("defaultMask", () => {
  it("centres a new mask and leaves it hard-edged and square-cornered", () => {
    const mask = defaultMask("rectangle");
    expect(mask.location).toEqual({ x: 50, y: 50 });
    expect(mask.rotation).toBe(0);
    expect(mask.feather).toBe(DEFAULT_MASK_FEATHER);
    expect(mask.roundness).toBe(DEFAULT_MASK_ROUNDNESS);
    expect(mask.invert).toBeUndefined();
    expect(mask.path).toBeUndefined();
  });

  // Not 100: a mask that exactly fills the clip looks like nothing happened,
  // and the first thing anyone does after applying one is drag it smaller.
  it("starts smaller than the element box so the mask is visible", () => {
    const { width, height } = defaultMask("star").size;
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(100);
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThan(100);
  });

  it("shares no mutable state between calls", () => {
    const a = defaultMask("rectangle");
    const b = defaultMask("rectangle");
    a.location.x = 1;
    expect(b.location.x).toBe(50);
  });
});

describe("sameMask", () => {
  it("is true for two independently built equal masks", () => {
    expect(sameMask(defaultMask("star"), defaultMask("star"))).toBe(true);
  });

  it("is true for two nulls and false for one", () => {
    expect(sameMask(null, null)).toBe(true);
    expect(sameMask(null, defaultMask("star"))).toBe(false);
    expect(sameMask(defaultMask("star"), null)).toBe(false);
  });

  it.each([
    ["shape", { shape: "heart" as const }],
    ["location", { location: { x: 10, y: 50 } }],
    ["size", { size: { width: 10, height: 10 } }],
    ["rotation", { rotation: 1 }],
    ["feather", { feather: 1 }],
    ["roundness", { roundness: 1 }],
    ["invert", { invert: true }],
  ])("sees a change of %s", (_label, patch) => {
    expect(sameMask(good(), good(patch))).toBe(false);
  });

  it("compares pen paths node by node", () => {
    const path = [{ p: [0, 0] }, { p: [1, 0] }, { p: [0, 1] }] as any;
    const moved = [{ p: [0, 0] }, { p: [1, 0.5] }, { p: [0, 1] }] as any;
    expect(sameMask(good({ shape: "pen", path }), good({ shape: "pen", path: [...path] }))).toBe(true);
    expect(sameMask(good({ shape: "pen", path }), good({ shape: "pen", path: moved }))).toBe(false);
    expect(sameMask(good({ shape: "pen", path }), good({ shape: "pen", path: path.slice(1) }))).toBe(false);
  });

  it("sees a handle appearing on a node", () => {
    const corner = [{ p: [0, 0] }, { p: [1, 0] }, { p: [0, 1] }] as any;
    const smooth = [{ p: [0, 0], cs: [-0.1, 0], ce: [0.1, 0] }, { p: [1, 0] }, { p: [0, 1] }] as any;
    expect(sameMask(good({ shape: "pen", path: corner }), good({ shape: "pen", path: smooth }))).toBe(false);
  });
});
