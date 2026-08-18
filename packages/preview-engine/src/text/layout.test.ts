import { describe, it, expect } from "vitest";
import {
  alignedLineX,
  textBackgroundBox,
  TEXT_BACKGROUND_PADDING,
} from "./layout";

// Box spans x = 100..300 (width 200); the line measures 80px wide.
const BOX_X = 100;
const BOX_W = 200;
const LINE_W = 80;

describe("alignedLineX", () => {
  it("puts a left-aligned line at the box origin", () => {
    expect(alignedLineX("left", BOX_X, BOX_W, LINE_W)).toBe(100);
  });

  it("centers a center-aligned line in the box", () => {
    // 100 + 100 - 40
    expect(alignedLineX("center", BOX_X, BOX_W, LINE_W)).toBe(160);
  });

  it("flushes a right-aligned line to the box's right edge", () => {
    // 100 + 200 - 80
    expect(alignedLineX("right", BOX_X, BOX_W, LINE_W)).toBe(220);
  });

  it("falls back to left for an absent or unknown align", () => {
    expect(alignedLineX(undefined, BOX_X, BOX_W, LINE_W)).toBe(100);
    expect(alignedLineX("justify", BOX_X, BOX_W, LINE_W)).toBe(100);
  });

  it("keeps a line wider than its box starting inside for left, overflowing left for right", () => {
    expect(alignedLineX("left", BOX_X, BOX_W, 300)).toBe(100);
    expect(alignedLineX("right", BOX_X, BOX_W, 300)).toBe(0);
  });
});

describe("textBackgroundBox", () => {
  it("starts one padding left of the line and is one padding wider", () => {
    const box = textBackgroundBox("left", BOX_X, BOX_W, LINE_W);
    expect(box.x).toBe(100 - TEXT_BACKGROUND_PADDING);
    expect(box.width).toBe(LINE_W + TEXT_BACKGROUND_PADDING);
  });

  it("tracks the aligned line position for center and right", () => {
    expect(textBackgroundBox("center", BOX_X, BOX_W, LINE_W).x).toBe(
      160 - TEXT_BACKGROUND_PADDING,
    );
    expect(textBackgroundBox("right", BOX_X, BOX_W, LINE_W).x).toBe(
      220 - TEXT_BACKGROUND_PADDING,
    );
  });

  it("is asymmetric — padding is added on the left only, matching the original", () => {
    const box = textBackgroundBox("left", BOX_X, BOX_W, LINE_W);
    const lineStart = alignedLineX("left", BOX_X, BOX_W, LINE_W);
    expect(lineStart - box.x).toBe(TEXT_BACKGROUND_PADDING);
    // right edge of the box sits exactly at the end of the text, no trailing pad
    expect(box.x + box.width).toBe(lineStart + LINE_W);
  });
});
