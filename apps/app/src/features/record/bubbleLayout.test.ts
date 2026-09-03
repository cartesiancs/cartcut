import { describe, expect, it } from "vitest";

import {
  bubbleCornerRadius,
  bubbleRect,
  bubbleSourceRect,
} from "./bubbleLayout";

const FRAME = { width: 1920, height: 1080 };
const WEBCAM = { width: 1280, height: 720 };

describe("bubbleRect", () => {
  it("puts a circle bubble in the corner it was asked for", () => {
    const rect = bubbleRect(FRAME, WEBCAM, "medium", "bottom-left", "circle");

    // 2.5% of the frame height, and 20% of it for a medium bubble.
    expect(rect.width).toBe(216);
    expect(rect.height).toBe(216);
    expect(rect.x).toBe(27);
    expect(rect.y).toBe(1080 - 27 - 216);
  });

  it("mirrors into the other three corners", () => {
    const size = 216;
    const margin = 27;

    expect(bubbleRect(FRAME, WEBCAM, "medium", "top-left", "circle")).toMatchObject(
      { x: margin, y: margin },
    );
    expect(
      bubbleRect(FRAME, WEBCAM, "medium", "top-right", "circle"),
    ).toMatchObject({ x: 1920 - margin - size, y: margin });
    expect(
      bubbleRect(FRAME, WEBCAM, "medium", "bottom-right", "circle"),
    ).toMatchObject({ x: 1920 - margin - size, y: 1080 - margin - size });
  });

  it("scales with the named size", () => {
    const small = bubbleRect(FRAME, WEBCAM, "small", "top-left", "circle");
    const large = bubbleRect(FRAME, WEBCAM, "large", "top-left", "circle");
    expect(small.height).toBeLessThan(large.height);
  });

  // A circle is square whatever the camera is; a rounded bubble keeps the
  // camera's aspect. That difference is the shape, before any rounding.
  it("gives a rounded bubble the camera's own aspect", () => {
    const rounded = bubbleRect(FRAME, WEBCAM, "medium", "top-left", "rounded");
    expect(rounded.height).toBe(216);
    expect(rounded.width).toBe(384);
  });

  // Sizes are fractions of height, so the bubble looks the same on an
  // ultrawide as on 16:9 rather than growing with the diagonal.
  it("sizes off the height, not the width", () => {
    const wide = bubbleRect(
      { width: 3440, height: 1080 },
      WEBCAM,
      "medium",
      "top-left",
      "circle",
    );
    expect(wide.height).toBe(216);
  });

  // A wide `"rounded"` bubble runs out of width on a narrow frame long before
  // it runs out of height, so the fit has to consider both axes.
  it("fits rather than overflowing a frame too narrow to hold it", () => {
    const narrow = { width: 60, height: 160 };
    const rect = bubbleRect(narrow, WEBCAM, "large", "bottom-right", "rounded");

    expect(rect.width).toBeLessThan(80);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(narrow.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(narrow.height);
  });
});

describe("bubbleSourceRect", () => {
  // The classic bubble bug: drawing a 16:9 camera into a square hole without a
  // crop squashes the face.
  it("centre-crops a wide camera into a square hole", () => {
    const source = bubbleSourceRect(WEBCAM, {
      x: 0,
      y: 0,
      width: 216,
      height: 216,
    });

    expect(source).toEqual({ x: 280, y: 0, width: 720, height: 720 });
  });

  it("crops top and bottom when the camera is taller than the hole", () => {
    const source = bubbleSourceRect(
      { width: 480, height: 640 },
      { x: 0, y: 0, width: 320, height: 180 },
    );

    expect(source.x).toBe(0);
    expect(source.width).toBe(480);
    expect(source.height).toBeCloseTo(270, 6);
    expect(source.y).toBeCloseTo((640 - 270) / 2, 6);
  });

  it("is the whole frame when the aspects already agree", () => {
    const source = bubbleSourceRect(WEBCAM, {
      x: 0,
      y: 0,
      width: 384,
      height: 216,
    });

    expect(source).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it("always stays inside the camera frame", () => {
    for (const destination of [
      { x: 0, y: 0, width: 1, height: 1000 },
      { x: 0, y: 0, width: 1000, height: 1 },
    ]) {
      const source = bubbleSourceRect(WEBCAM, destination);
      expect(source.x).toBeGreaterThanOrEqual(0);
      expect(source.y).toBeGreaterThanOrEqual(0);
      expect(source.x + source.width).toBeLessThanOrEqual(WEBCAM.width + 1e-9);
      expect(source.y + source.height).toBeLessThanOrEqual(WEBCAM.height + 1e-9);
    }
  });
});

describe("bubbleCornerRadius", () => {
  // A circle is the rounded rectangle whose radius is half its shorter side, so
  // the renderer has one path and no shape name in it.
  it("makes a circle out of a square at half the side", () => {
    const rect = { x: 0, y: 0, width: 216, height: 216 };
    expect(bubbleCornerRadius(rect, "circle")).toBe(108);
  });

  it("rounds a rounded bubble by much less", () => {
    const rect = { x: 0, y: 0, width: 384, height: 216 };
    const radius = bubbleCornerRadius(rect, "rounded");
    expect(radius).toBeGreaterThan(0);
    expect(radius).toBeLessThan(108);
  });
});
