import { describe, it, expect } from "vitest";
import {
  DEFAULT_LINE_HEIGHT,
  coerceLineHeight,
  defaultTextHeight,
  lineAdvanceForSize,
  lineAdvanceOf,
  normalizeLineHeight,
} from "./metrics";
import type { TextElementType } from "../../@types/timeline";

const text = (over: Record<string, unknown> = {}) =>
  ({
    filetype: "text",
    fontsize: 40,
    height: 60,
    options: {},
    ...over,
  }) as unknown as TextElementType;

describe("normalizeLineHeight", () => {
  it("answers the default for anything unusable", () => {
    // Runs on every draw, so it must never throw and never return NaN.
    for (const value of [undefined, null, NaN, Infinity, "abc", {}, []]) {
      expect(normalizeLineHeight(value)).toBe(DEFAULT_LINE_HEIGHT);
    }
  });

  it("keeps a usable multiple", () => {
    expect(normalizeLineHeight(1)).toBe(1);
    expect(normalizeLineHeight(1.5)).toBe(1.5);
    expect(normalizeLineHeight(2)).toBe(2);
  });

  it("clamps rather than refusing", () => {
    expect(normalizeLineHeight(0.1)).toBe(0.5);
    expect(normalizeLineHeight(-3)).toBe(0.5);
    expect(normalizeLineHeight(99)).toBe(4);
  });

  it("reads a numeric string, because inputs write strings", () => {
    expect(normalizeLineHeight("1.5")).toBe(1.5);
  });
});

describe("coerceLineHeight", () => {
  it("clamps the same way, so an unusable value is unrepresentable", () => {
    expect(coerceLineHeight(0.1)).toBe(0.5);
    expect(coerceLineHeight(99)).toBe(4);
    expect(coerceLineHeight("")).toBe(DEFAULT_LINE_HEIGHT);
  });
});

describe("lineAdvanceOf", () => {
  it("comes from the font size, not the box", () => {
    // The whole point of the change: `height` must not reach the layout.
    expect(lineAdvanceOf(text({ fontsize: 40, height: 60 }))).toBeCloseTo(48);
    expect(lineAdvanceOf(text({ fontsize: 40, height: 300 }))).toBeCloseTo(48);
    expect(lineAdvanceOf(text({ fontsize: 40, height: 1 }))).toBeCloseTo(48);
  });

  it("scales with the font size", () => {
    expect(lineAdvanceOf(text({ fontsize: 20 }))).toBeCloseTo(24);
    expect(lineAdvanceOf(text({ fontsize: 80 }))).toBeCloseTo(96);
  });

  it("honours an explicit lineHeight", () => {
    expect(
      lineAdvanceOf(text({ fontsize: 40, options: { lineHeight: 1 } })),
    ).toBeCloseTo(40);
    expect(
      lineAdvanceOf(text({ fontsize: 40, options: { lineHeight: 2 } })),
    ).toBeCloseTo(80);
  });

  it("survives an element with no options block at all", () => {
    const bare = { filetype: "text", fontsize: 40 } as unknown as TextElementType;
    expect(lineAdvanceOf(bare)).toBeCloseTo(48);
  });

  it("never returns zero, so lines cannot pile up on one baseline", () => {
    expect(lineAdvanceOf(text({ fontsize: 0 }))).toBeGreaterThan(0);
    expect(lineAdvanceOf(text({ fontsize: NaN }))).toBeGreaterThan(0);
  });
});

describe("defaultTextHeight", () => {
  it("is a plausible one-line box for the size", () => {
    // Used where nothing can be measured yet — element creation, and the
    // no-canvas fallback. It only has to be close; the fit corrects it.
    const h = defaultTextHeight(52);
    expect(h).toBeGreaterThan(52);
    expect(h).toBeLessThan(52 * 1.6);
  });

  it("grows with the font size and with the line height", () => {
    expect(defaultTextHeight(80)).toBeGreaterThan(defaultTextHeight(40));
    expect(defaultTextHeight(40, 2)).toBeGreaterThan(defaultTextHeight(40, 1));
  });

  it("is a whole number of pixels", () => {
    expect(Number.isInteger(defaultTextHeight(52))).toBe(true);
  });
});

describe("lineAdvanceForSize", () => {
  it("reproduces lineAdvanceOf for the element's own size", () => {
    for (const fontsize of [1, 12, 52, 120, 999.5]) {
      for (const lineHeight of [undefined, 0.5, 1, 1.2, 2.75, 4]) {
        const element = {
          fontsize,
          options: { lineHeight },
        } as unknown as Parameters<typeof lineAdvanceOf>[0];
        expect(lineAdvanceForSize(fontsize, lineHeight)).toBe(
          lineAdvanceOf(element),
        );
      }
    }
  });

  it("guards an unusable size the same way", () => {
    expect(lineAdvanceForSize(0, 1)).toBe(1);
    expect(lineAdvanceForSize(NaN, 1)).toBe(1);
    expect(lineAdvanceForSize(-4, 1)).toBe(1);
  });

  it("scales with the size it is given, not with the element", () => {
    expect(lineAdvanceForSize(100, 1.2)).toBeCloseTo(120, 10);
  });
});
