import { describe, expect, it } from "vitest";
import { lineIndices } from "./lines";

const box = (top: number, height = 20, left = 0, width = 40) => ({
  top,
  bottom: top + height,
  left,
  right: left + width,
});

describe("lineIndices", () => {
  it("starts a line where the block-axis centre moves", () => {
    expect(lineIndices([box(0), box(0), box(24), box(24), box(48)], false)).toEqual([0, 0, 1, 1, 2]);
  });

  it("keeps words within 2px of the line's first word on that line", () => {
    // A word nudged by a baseline shift is still on the line.
    expect(lineIndices([box(0), box(1), box(0.5, 20)], false)).toEqual([0, 0, 0]);
  });

  it("reads the inline axis in vertical writing", () => {
    const col = (left: number, top: number) => box(top, 40, left, 20);
    expect(lineIndices([col(100, 0), col(100, 40), col(70, 0)], true)).toEqual([0, 0, 1]);
  });

  it("answers nothing for no words", () => {
    expect(lineIndices([], false)).toEqual([]);
  });
});
