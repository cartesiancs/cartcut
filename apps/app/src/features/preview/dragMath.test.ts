import { describe, expect, it } from "vitest";

import {
  angleStep,
  movedLocation,
  normalizeDegrees,
  rotatedDocument,
  type Rect,
} from "./dragMath";
import { applyPoint, IDENTITY, localMatrixOf } from "../timeline/transform";

/**
 * The element's world-space axis-aligned box, built from the same matrix the
 * renderer draws with — so the rotated cases below are the real geometry rather
 * than numbers copied out of the implementation.
 */
function boundsOf(element: any): Rect {
  const m = localMatrixOf(element, 0);
  const w = element.width;
  const h = element.height;
  const corners = [
    applyPoint(m, { x: 0, y: 0 }),
    applyPoint(m, { x: w, y: 0 }),
    applyPoint(m, { x: w, y: h }),
    applyPoint(m, { x: 0, y: h }),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

const flat = {
  location: { x: 100, y: 100 },
  width: 200,
  height: 100,
  rotation: 0,
};

const turned = { ...flat, rotation: 45 };

describe("movedLocation", () => {
  it("adds the drag to the origin for an unrotated, unparented element", () => {
    const moved = movedLocation({
      originLocal: { x: 100, y: 100 },
      originBounds: boundsOf(flat),
      dx: 30,
      dy: 40,
      parentMatrix: IDENTITY,
    });

    expect(moved.location).toEqual({ x: 130, y: 140 });
    expect(moved.direction).toEqual([]);
  });

  it("leaves a rotated element exactly where it was for a zero drag", () => {
    // The regression. `elementOrigin` held the element's *drawn corner*, which
    // for this clip is (164.6, 43.9) against a `location` of (100, 100) — so the
    // first mouse move, before the pointer had travelled at all, wrote the
    // corner into `location` and the element teleported by (+64.6, -56.1).
    const drawnCorner = applyPoint(localMatrixOf(turned, 0), { x: 0, y: 0 });
    expect(drawnCorner.x).toBeCloseTo(164.6446, 3);
    expect(drawnCorner.y).toBeCloseTo(43.934, 3);

    const moved = movedLocation({
      originLocal: { x: 100, y: 100 },
      originBounds: boundsOf(turned),
      dx: 0,
      dy: 0,
      parentMatrix: IDENTITY,
    });

    expect(moved.location).toEqual({ x: 100, y: 100 });
  });

  it("moves a rotated element by the pointer delta, not by its rotation", () => {
    const moved = movedLocation({
      originLocal: { x: 100, y: 100 },
      originBounds: boundsOf(turned),
      dx: 30,
      dy: 40,
      parentMatrix: IDENTITY,
    });

    expect(moved.location.x).toBeCloseTo(130, 10);
    expect(moved.location.y).toBeCloseTo(140, 10);
  });

  it("divides the drag by a parent's scale", () => {
    // A group scaled 2x and offset: 100px of pointer travel is 50 in the field.
    const moved = movedLocation({
      originLocal: { x: 100, y: 100 },
      originBounds: boundsOf(flat),
      dx: 100,
      dy: 0,
      parentMatrix: { a: 2, b: 0, c: 0, d: 2, e: 50, f: 70 },
    });

    expect(moved.location.x).toBeCloseTo(150, 10);
    expect(moved.location.y).toBeCloseTo(100, 10);
  });

  it("turns the drag through a parent's rotation", () => {
    // Parent rotated 90°: dragging right on canvas is dragging *up* in the
    // field, so the y term moves and the x term does not.
    const moved = movedLocation({
      originLocal: { x: 0, y: 0 },
      originBounds: boundsOf(flat),
      dx: 100,
      dy: 0,
      parentMatrix: { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 },
    });

    expect(moved.location.x).toBeCloseTo(0, 10);
    expect(moved.location.y).toBeCloseTo(-100, 10);
  });

  it("folds a snap correction into the delta and reports its guides", () => {
    // The box is dragged to x = 108 and the snap pulls it back to the frame's
    // left edge — a correction of −8, which is what reaches `location`.
    const moved = movedLocation({
      originLocal: { x: 100, y: 100 },
      originBounds: boundsOf(flat),
      dx: 8,
      dy: 40,
      parentMatrix: IDENTITY,
      snap: (rect) => ({ x: 0, y: rect.y, direction: ["left"] }),
    });

    expect(moved.location).toEqual({ x: 0, y: 140 });
    expect(moved.direction).toEqual(["left"]);
  });

  it("snaps a rotated element on the box the user sees", () => {
    // The snap answers about the world AABB, so the correction is the distance
    // from *that* box's edge to the frame — and `location`, which is a corner
    // the box does not touch, moves by the same amount.
    const bounds = boundsOf(turned);
    const moved = movedLocation({
      originLocal: { x: 100, y: 100 },
      originBounds: bounds,
      dx: 0,
      dy: 0,
      parentMatrix: IDENTITY,
      snap: (rect) => ({ x: 0, y: rect.y, direction: ["left"] }),
    });

    expect(moved.location.x).toBeCloseTo(100 - bounds.x, 10);
    expect(moved.location.y).toBeCloseTo(100, 10);
  });

  it("takes a parent's translation from the origin, never from the delta", () => {
    // Running a *delta* through the full inverse would subtract the parent's
    // offset a second time and drag the element away from the pointer.
    const moved = movedLocation({
      originLocal: { x: 10, y: 20 },
      originBounds: boundsOf(flat),
      dx: 5,
      dy: 5,
      parentMatrix: { a: 1, b: 0, c: 0, d: 1, e: 900, f: -400 },
    });

    expect(moved.location).toEqual({ x: 15, y: 25 });
  });
});

describe("angleStep", () => {
  it("is the plain difference well inside a turn", () => {
    expect(angleStep(10, 40)).toBe(30);
    expect(angleStep(40, 10)).toBe(-30);
  });

  it("takes the short way across 0", () => {
    expect(angleStep(359, 1)).toBe(2);
    expect(angleStep(1, 359)).toBe(-2);
  });

  it("accumulates past a full turn instead of wrapping", () => {
    let total = 0;
    let previous = 0;
    for (const pointer of [90, 180, 270, 0, 90, 180]) {
      total += angleStep(previous, pointer);
      previous = pointer;
    }
    expect(total).toBe(540);
  });

  it("is zero for a non-finite angle rather than NaN", () => {
    expect(angleStep(NaN, 10)).toBe(0);
    expect(angleStep(10, Infinity)).toBe(0);
  });
});

describe("normalizeDegrees", () => {
  it("brings an angle into [0, 360)", () => {
    expect(normalizeDegrees(0)).toBe(0);
    expect(normalizeDegrees(45)).toBe(45);
    expect(normalizeDegrees(360)).toBe(0);
    expect(normalizeDegrees(540)).toBe(180);
    expect(normalizeDegrees(-90)).toBe(270);
    expect(normalizeDegrees(-450)).toBe(270);
  });

  it("is zero for a non-finite angle", () => {
    expect(normalizeDegrees(NaN)).toBe(0);
  });
});

/**
 * Absolute, like `resizeMath.resizedDocument` — `GestureCommit` re-applies
 * against the live document on every mousemove, so a write that adjusted the
 * angle instead of setting it would spin the element on a stationary pointer.
 */
describe("rotatedDocument", () => {
  const doc = (rotation: number) =>
    ({
      elements: { a: { filetype: "shape", rotation, width: 10, height: 10 } },
      tracks: [],
    }) as any;

  it("does not move the element when the pointer holds still", () => {
    let next: any = doc(0);
    for (let i = 0; i < 50; i++) {
      next = rotatedDocument(next, "a", 37);
    }
    expect(next.elements.a.rotation).toBe(37);
  });

  it("declines by identity when the angle is already set", () => {
    const before = doc(37);
    expect(rotatedDocument(before, "a", 37)).toBe(before);
  });

  it("declines by identity for an element that is not there", () => {
    const before = doc(0);
    expect(rotatedDocument(before, "missing", 37)).toBe(before);
  });

  it("leaves every other field alone and does not mutate its input", () => {
    const before = doc(0);
    const snapshot = JSON.parse(JSON.stringify(before));
    const after = rotatedDocument(before, "a", 90);
    expect(after.elements.a).toMatchObject({ filetype: "shape", width: 10 });
    expect(before).toEqual(snapshot);
  });
});
