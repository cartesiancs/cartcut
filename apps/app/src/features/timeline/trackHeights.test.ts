import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRACK_HEIGHT,
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT,
  coerceTrackHeight,
  heightsFor,
  trackHeightOf,
  withTrackHeight,
  type TrackHeights,
} from "./trackHeights";

describe("coerceTrackHeight", () => {
  it("keeps a whole height in range", () => {
    expect(coerceTrackHeight(64)).toBe(64);
    expect(coerceTrackHeight(MIN_TRACK_HEIGHT)).toBe(MIN_TRACK_HEIGHT);
    expect(coerceTrackHeight(MAX_TRACK_HEIGHT)).toBe(MAX_TRACK_HEIGHT);
  });

  it("rounds to a whole pixel", () => {
    expect(coerceTrackHeight(57.4)).toBe(57);
    expect(coerceTrackHeight(32.5)).toBe(33);
  });

  it("clamps into range", () => {
    expect(coerceTrackHeight(31.4)).toBe(MIN_TRACK_HEIGHT);
    expect(coerceTrackHeight(-500)).toBe(MIN_TRACK_HEIGHT);
    expect(coerceTrackHeight(201)).toBe(MAX_TRACK_HEIGHT);
    expect(coerceTrackHeight(1e9)).toBe(MAX_TRACK_HEIGHT);
  });

  it("answers the default for anything that is not a finite number", () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, "80", null, undefined, {}]) {
      expect(coerceTrackHeight(bad)).toBe(DEFAULT_TRACK_HEIGHT);
    }
  });
});

describe("trackHeightOf", () => {
  it("is the default for a row nobody resized", () => {
    expect(trackHeightOf({}, "a")).toBe(DEFAULT_TRACK_HEIGHT);
  });

  it("reads a stored height", () => {
    expect(trackHeightOf({ a: 90 }, "a")).toBe(90);
  });

  it("reads a corrupt entry as the default and never throws", () => {
    const corrupt = {
      nan: Number.NaN,
      big: 10_000,
      small: 2,
      frac: 50.5,
      str: "80",
    } as unknown as TrackHeights;
    for (const id of ["nan", "big", "small", "frac", "str"]) {
      expect(trackHeightOf(corrupt, id)).toBe(DEFAULT_TRACK_HEIGHT);
    }
  });

  it("never reads an inherited property", () => {
    expect(trackHeightOf({}, "constructor")).toBe(DEFAULT_TRACK_HEIGHT);
    expect(trackHeightOf({}, "__proto__")).toBe(DEFAULT_TRACK_HEIGHT);
    expect(trackHeightOf({}, "toString")).toBe(DEFAULT_TRACK_HEIGHT);
  });
});

describe("withTrackHeight", () => {
  it("sets a row", () => {
    expect(withTrackHeight({}, "a", 80)).toEqual({ a: 80 });
  });

  it("returns the same map when nothing would change", () => {
    const heights = { a: 80 };
    expect(withTrackHeight(heights, "a", 80)).toBe(heights);
    expect(withTrackHeight(heights, "a", 80.2)).toBe(heights);
    // Setting an unresized row to the default is nothing too.
    expect(withTrackHeight(heights, "b", DEFAULT_TRACK_HEIGHT)).toBe(heights);
  });

  it("deletes the key at the default instead of storing it", () => {
    const next = withTrackHeight({ a: 80, b: 60 }, "a", DEFAULT_TRACK_HEIGHT);
    expect(next).toEqual({ b: 60 });
    expect(Object.prototype.hasOwnProperty.call(next, "a")).toBe(false);
  });

  it("stores what was coerced, not what was asked", () => {
    expect(withTrackHeight({}, "a", 9999)).toEqual({ a: MAX_TRACK_HEIGHT });
    // A garbage request is a reset.
    expect(withTrackHeight({ a: 80 }, "a", Number.NaN)).toEqual({});
  });

  it("never mutates its input", () => {
    const heights = Object.freeze({ a: 80 });
    expect(() => withTrackHeight(heights, "a", 90)).not.toThrow();
    expect(() => withTrackHeight(heights, "b", 90)).not.toThrow();
    expect(heights).toEqual({ a: 80 });
  });

  it("keeps an id like __proto__ as data", () => {
    const next = withTrackHeight({}, "__proto__", 70);
    expect(Object.prototype.hasOwnProperty.call(next, "__proto__")).toBe(true);
    expect(trackHeightOf(next, "__proto__")).toBe(70);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
  });
});

describe("heightsFor", () => {
  it("keeps only the listed rows, sorted", () => {
    const heights = { c: 50, orphan: 90, a: 70 };
    const saved = heightsFor(heights, ["a", "b", "c"]);
    expect(saved).toEqual({ a: 70, c: 50 });
    expect(Object.keys(saved)).toEqual(["a", "c"]);
  });

  it("drops corrupt and default entries", () => {
    const heights = { a: Number.NaN, b: DEFAULT_TRACK_HEIGHT } as TrackHeights;
    expect(heightsFor(heights, ["a", "b"])).toEqual({});
  });

  it("does not depend on insertion order", () => {
    const one = heightsFor({ b: 60, a: 70 }, ["a", "b"]);
    const two = heightsFor({ a: 70, b: 60 }, ["b", "a"]);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });
});
