import { describe, expect, it } from "vitest";

import {
  overlayBoundsFor,
  sameBounds,
  type DisplayLike,
} from "./overlayPlacement.js";

const DISPLAYS: DisplayLike[] = [
  { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } },
  { id: 2, bounds: { x: 1512, y: -180, width: 2560, height: 1440 } },
];

describe("overlayBoundsFor", () => {
  it("answers the bounds of the display the capture names", () => {
    expect(overlayBoundsFor(DISPLAYS, "2")).toEqual({
      x: 1512,
      y: -180,
      width: 2560,
      height: 1440,
    });
  });

  it("matches a numeric Display.id against a string display_id", () => {
    // The whole point of the string comparison: `Display.id` is a number and
    // `desktopCapturer` reports `display_id` as text.
    expect(overlayBoundsFor(DISPLAYS, "1")?.width).toBe(1512);
  });

  it("declines for a window source, which has no display at all", () => {
    expect(overlayBoundsFor(DISPLAYS, "")).toBeNull();
  });

  it("declines for an id no display answers to", () => {
    expect(overlayBoundsFor(DISPLAYS, "9")).toBeNull();
  });

  it("declines anything that is not a string", () => {
    expect(overlayBoundsFor(DISPLAYS, undefined)).toBeNull();
    expect(overlayBoundsFor(DISPLAYS, 2)).toBeNull();
  });

  it("declines a display with no area rather than hiding the overlay", () => {
    const reconfiguring: DisplayLike[] = [
      { id: 3, bounds: { x: 0, y: 0, width: 0, height: 0 } },
    ];
    expect(overlayBoundsFor(reconfiguring, "3")).toBeNull();
  });
});

describe("sameBounds", () => {
  const rect = { x: 0, y: 0, width: 100, height: 50 };

  it("is true for equal rectangles and false for any difference", () => {
    expect(sameBounds(rect, { ...rect })).toBe(true);
    expect(sameBounds(rect, { ...rect, x: 1 })).toBe(false);
    expect(sameBounds(rect, { ...rect, height: 51 })).toBe(false);
  });

  it("treats null as its own value", () => {
    expect(sameBounds(null, null)).toBe(true);
    expect(sameBounds(rect, null)).toBe(false);
    expect(sameBounds(null, rect)).toBe(false);
  });
});
