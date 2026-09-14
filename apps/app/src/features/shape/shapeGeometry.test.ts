import { describe, it, expect } from "vitest";

import type { ShapeGeometry } from "../../@types/timeline";
import { shapeElement, imageElement } from "../renderer/testing";
import {
  coerceShapeGeometry,
  coerceShapeGeometryKind,
  mergeShapeGeometry,
  normalizeShapeGeometry,
  sameShapeGeometry,
  shapeGeometryOf,
} from "./shapeGeometry";
import { starInnerRatioFor } from "./shapeOutline";

const withGeometry = (geometry: unknown) =>
  shapeElement({ geometry } as never);

describe("shapeGeometryOf, the read guard", () => {
  /**
   * It runs once per shape per frame. Everything below is a way to put a black
   * frame on screen with nothing in the console to say why, so all of them have
   * to answer something drawable and none of them may throw.
   */
  it.each([
    ["no field", undefined],
    ["a null", null],
    ["a string", "rectangle"],
    ["a number", 3],
    ["an array", []],
    ["a recipe with no kind", { count: 5 }],
    ["a recipe with an unknown kind", { kind: "octagon" }],
    ["a recipe with a numeric kind", { kind: 7 }],
  ])("answers null for %s and does not throw", (_label, geometry) => {
    expect(() => shapeGeometryOf(withGeometry(geometry))).not.toThrow();
    expect(shapeGeometryOf(withGeometry(geometry))).toBeNull();
  });

  it("answers null for a missing element and for a clip of another type", () => {
    expect(shapeGeometryOf(undefined)).toBeNull();
    expect(shapeGeometryOf(null)).toBeNull();
    expect(shapeGeometryOf(imageElement())).toBeNull();
  });

  /**
   * The asymmetry with the write side: a read **defaults** an unreadable
   * number. A frame has to draw something, and a star whose count is `NaN` is
   * far better drawn with five points than not drawn at all.
   */
  it.each([
    ["a NaN count", { kind: "star", count: NaN }, { kind: "star" }],
    ["a string count", { kind: "star", count: "9" }, { kind: "star" }],
    ["a count past the ceiling", { kind: "polygon", count: 4000 }, { kind: "polygon", count: 60 }],
    ["a negative radius", { kind: "rectangle", radius: -8 }, { kind: "rectangle" }],
    ["a NaN radius", { kind: "rectangle", radius: NaN }, { kind: "rectangle" }],
    ["a waist past 1", { kind: "star", innerRatio: 4 }, { kind: "star", innerRatio: 1 }],
    ["a hole past 1", { kind: "ellipse", hole: 9 }, { kind: "ellipse", hole: 1 }],
  ])("defaults %s rather than refusing it", (_label, raw, want) => {
    expect(shapeGeometryOf(withGeometry(raw))).toEqual(want);
  });

  it("reads back exactly what it was given, for a recipe in range", () => {
    const geometry = { kind: "star", count: 7, innerRatio: 0.2, radius: 4 };
    expect(shapeGeometryOf(withGeometry(geometry))).toEqual(geometry);
  });
});

describe("normalizeShapeGeometry, the canonical form", () => {
  /**
   * The rule `normalizeAdjustments` follows, applied to a record instead of to
   * a slider: two equal settings must stringify identically, or an absent field
   * and its own default stop comparing equal and a saved project fills up with
   * inert keys.
   */
  it("drops every key the kind does not read", () => {
    expect(
      normalizeShapeGeometry("rectangle", {
        count: 9,
        innerRatio: 0.2,
        hole: 0.5,
        arc: { start: 20, sweep: 90 },
      }),
    ).toEqual({ kind: "rectangle" });

    expect(normalizeShapeGeometry("polygon", { innerRatio: 0.2, hole: 0.5 })).toEqual({
      kind: "polygon",
    });
  });

  it("drops a value that is already the kind's default", () => {
    expect(normalizeShapeGeometry("polygon", { count: 3 })).toEqual({ kind: "polygon" });
    expect(normalizeShapeGeometry("star", { count: 5 })).toEqual({ kind: "star" });
    expect(normalizeShapeGeometry("rectangle", { radius: 0 })).toEqual({
      kind: "rectangle",
    });
    expect(normalizeShapeGeometry("ellipse", { hole: 0, arc: { start: 0, sweep: 360 } })).toEqual(
      { kind: "ellipse" },
    );
  });

  /**
   * The default waist depends on the count, so it has to be compared against
   * the ratio *this* count would produce. Compared against the five-point
   * constant instead, an untouched seven-pointed star would carry a key.
   */
  it("drops a waist that is the default for its own count", () => {
    expect(
      normalizeShapeGeometry("star", { count: 9, innerRatio: starInnerRatioFor(9) }),
    ).toEqual({ kind: "star", count: 9 });
  });

  it("collapses four equal corner radii to one number", () => {
    expect(normalizeShapeGeometry("rectangle", { radius: [6, 6, 6, 6] })).toEqual({
      kind: "rectangle",
      radius: 6,
    });
    expect(normalizeShapeGeometry("rectangle", { radius: [0, 0, 0, 0] })).toEqual({
      kind: "rectangle",
    });
  });

  it("keeps four radii that differ", () => {
    expect(normalizeShapeGeometry("rectangle", { radius: [6, 0, 6, 0] })).toEqual({
      kind: "rectangle",
      radius: [6, 0, 6, 0],
    });
  });

  it("wraps an arc start into 0..360 rather than storing a negative", () => {
    expect(normalizeShapeGeometry("ellipse", { arc: { start: -90, sweep: 90 } })).toEqual({
      kind: "ellipse",
      arc: { start: 270, sweep: 90 },
    });
  });
});

describe("coerceShapeGeometry, the write validator", () => {
  /**
   * Unlike the read guard, a write **refuses** rather than defaulting: this is
   * the one place a caller can be told it got something wrong, and quietly
   * substituting five for a mistyped count hides the mistake until someone sees
   * the picture.
   */
  it.each([
    ["a null", null],
    ["a string", "rectangle"],
    ["an array", []],
    ["an unknown kind", { kind: "octagon" }],
    ["no kind at all", { count: 5 }],
    ["a non-finite count", { kind: "star", count: NaN }],
    ["a string count", { kind: "star", count: "7" }],
    ["a non-finite waist", { kind: "star", innerRatio: Infinity }],
    ["a string radius", { kind: "rectangle", radius: "8" }],
    ["three corner radii", { kind: "rectangle", radius: [1, 2, 3] }],
    ["five corner radii", { kind: "rectangle", radius: [1, 2, 3, 4, 5] }],
    ["a corner radius that is not a number", { kind: "rectangle", radius: [1, "2", 3, 4] }],
    ["an arc that is not an object", { kind: "ellipse", arc: 90 }],
    ["an arc with a NaN sweep", { kind: "ellipse", arc: { start: 0, sweep: NaN } }],
  ])("refuses %s", (_label, value) => {
    expect(coerceShapeGeometry(value).ok).toBe(false);
  });

  it("names what it refused, so the caller can say so", () => {
    const result = coerceShapeGeometry({ kind: "rectangle", radius: [1, 2, 3] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/four/);
  });

  /**
   * What it clamps rather than refuses is a range that is a preference. A count
   * of 500 means "as many as it goes", and refusing it would be pedantry about
   * a slider's ceiling.
   */
  it("clamps where the range is a preference", () => {
    const big = coerceShapeGeometry({ kind: "polygon", count: 500 });
    expect(big.ok === true && big.geometry.count).toBe(60);

    const deep = coerceShapeGeometry({ kind: "star", innerRatio: 3 });
    expect(deep.ok === true && deep.geometry.innerRatio).toBe(1);

    const negative = coerceShapeGeometry({ kind: "rectangle", radius: -4 });
    expect(negative.ok === true && negative.geometry.radius).toBeUndefined();
  });

  it("fills in the fields a caller left out", () => {
    const result = coerceShapeGeometry({ kind: "star" });
    expect(result.ok === true && result.geometry).toEqual({ kind: "star" });
  });

  it("accepts every kind it knows", () => {
    for (const kind of ["rectangle", "ellipse", "polygon", "star"]) {
      expect(coerceShapeGeometry({ kind }).ok, kind).toBe(true);
      expect(coerceShapeGeometryKind(kind)).toBe(kind);
    }
    expect(coerceShapeGeometryKind("triangle")).toBeNull();
  });
});

describe("mergeShapeGeometry", () => {
  it("keeps a zero, because zero is how a rounded corner is squared off", () => {
    const base = normalizeShapeGeometry("rectangle", { radius: 12 });
    expect(mergeShapeGeometry(base, { radius: 0 })).toEqual({ kind: "rectangle" });
  });

  /**
   * The panel's spinners emit a `NaN` mid-edit. Dropping it and letting the op
   * decline is right where clamping it into something plausible would commit a
   * value the user never typed.
   */
  it("drops an unreadable number rather than clamping it", () => {
    const base = normalizeShapeGeometry("star", { count: 7 });
    expect(mergeShapeGeometry(base, { count: NaN })).toEqual(base);
    expect(mergeShapeGeometry(base, { innerRatio: Infinity as number })).toEqual(base);
  });

  it("changes the kind and drops what the new kind cannot use", () => {
    const base = normalizeShapeGeometry("star", { count: 9, innerRatio: 0.2 });
    expect(mergeShapeGeometry(base, { kind: "rectangle" })).toEqual({ kind: "rectangle" });
  });

  it("patches one half of an arc and keeps the other", () => {
    const base = normalizeShapeGeometry("ellipse", { arc: { start: 30, sweep: 200 } });
    expect(mergeShapeGeometry(base, { arc: { start: 30, sweep: 90 } })).toEqual({
      kind: "ellipse",
      arc: { start: 30, sweep: 90 },
    });
  });

  it("answers null when there is no kind to be had", () => {
    expect(mergeShapeGeometry(null, { radius: 5 })).toBeNull();
  });

  it("gives a shape with no recipe one, when the patch names a kind", () => {
    expect(mergeShapeGeometry(null, { kind: "star" })).toEqual({ kind: "star" });
  });
});

describe("sameShapeGeometry", () => {
  // The kind is `normalizeShapeGeometry`'s first argument, not one of the raw
  // fields, so an override has to be pulled out of the patch rather than spread
  // into it. Spread in, it is read by nothing and the test passes for the wrong
  // reason.
  const good = (over: Partial<ShapeGeometry> = {}): ShapeGeometry =>
    normalizeShapeGeometry(over.kind ?? "star", {
      count: 7,
      innerRatio: 0.3,
      radius: 4,
      ...over,
    });

  it("holds the decline contract: two equal recipes compare equal", () => {
    expect(sameShapeGeometry(good(), good())).toBe(true);
    expect(sameShapeGeometry(null, null)).toBe(true);
    expect(sameShapeGeometry(good(), null)).toBe(false);
  });

  /**
   * An absent field and its explicit default must compare equal, or the panel
   * setting a shape to what it already is would spend an undo step on nothing.
   */
  it("sees an absent field and its default as the same", () => {
    expect(
      sameShapeGeometry(
        normalizeShapeGeometry("polygon", {}),
        normalizeShapeGeometry("polygon", { count: 3 }),
      ),
    ).toBe(true);
    expect(
      sameShapeGeometry(
        normalizeShapeGeometry("rectangle", {}),
        normalizeShapeGeometry("rectangle", { radius: [0, 0, 0, 0] }),
      ),
    ).toBe(true);
  });

  it.each([
    ["kind", { kind: "polygon" as const }],
    ["radius", { radius: 9 }],
    ["count", { count: 8 }],
    ["innerRatio", { innerRatio: 0.31 }],
  ])("sees a change of %s", (_label, patch) => {
    expect(sameShapeGeometry(good(), good(patch))).toBe(false);
  });

  it("sees a change of arc and of hole", () => {
    const base = normalizeShapeGeometry("ellipse", {});
    expect(
      sameShapeGeometry(base, normalizeShapeGeometry("ellipse", { hole: 0.4 })),
    ).toBe(false);
    expect(
      sameShapeGeometry(
        base,
        normalizeShapeGeometry("ellipse", { arc: { start: 0, sweep: 180 } }),
      ),
    ).toBe(false);
  });

  /**
   * `JSON.stringify` preserves insertion order, so two recipes built by
   * different routes can carry the same fields in a different one. Without a
   * fixed ordering the comparison would report a change that is not there,
   * which is exactly what the identity contract forbids.
   */
  it("does not care what order the keys were written in", () => {
    const a = { kind: "star", count: 7, radius: 4 } as ShapeGeometry;
    const b = { radius: 4, kind: "star", count: 7 } as unknown as ShapeGeometry;
    expect(sameShapeGeometry(a, b)).toBe(true);
  });
});
