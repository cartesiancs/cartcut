/**
 * Where a selected range of a text clip lands on the canvas.
 *
 * `previewCanvas` draws the teal wash from these and then redraws the clip's
 * glyphs over it, so a rect that is out by a line reads as a highlight on the
 * wrong words. Everything here is relative for the usual reason - the host
 * picks the font - except the line count and the ordering, which are exact.
 *
 * `selectionRectsOf` reads the layout the draw uses, so the one thing these
 * cannot check is that the layout is right. `textRuns.test.ts` does that.
 */

import { describe, expect, it } from "vitest";

import { scene, textElement } from "./testing";
import { renderText, selectionRectsOf } from "./text";

const base = (over: Record<string, unknown> = {}) =>
  textElement({
    location: { x: 0, y: 0 },
    width: 420,
    height: 80,
    fontsize: 36,
    text: "Hello brave world",
    textcolor: "#ffffff",
    ...over,
  } as never);

function rects(element: unknown, from: number, to: number) {
  const { ctx } = scene(520, 320, "#000000");
  return selectionRectsOf(ctx, element as never, from, to);
}

describe("a range that covers nothing", () => {
  it.each([
    ["a collapsed caret", 5, 5],
    ["a range past the end", 90, 99],
    ["a range on an empty string", 0, 4],
  ])("answers nothing for %s", (label, from, to) => {
    const element = label.includes("empty") ? base({ text: "" }) : base();
    expect(rects(element, from, to)).toEqual([]);
  });

  it("orders an inverted range rather than refusing it", () => {
    expect(rects(base(), 11, 6)).toEqual(rects(base(), 6, 11));
  });
});

describe("a range inside one line", () => {
  it("is one rect", () => {
    expect(rects(base(), 6, 11)).toHaveLength(1);
  });

  it("starts where the characters before it end", () => {
    const whole = rects(base(), 0, 17)[0];
    const tail = rects(base(), 6, 17)[0];
    expect(tail.x).toBeGreaterThan(whole.x);
    expect(tail.w).toBeLessThan(whole.w);
    // The two must finish together: they end at the same character.
    expect(tail.x + tail.w).toBeCloseTo(whole.x + whole.w, 3);
  });

  it("widens with the range", () => {
    const short = rects(base(), 0, 3)[0];
    const long = rects(base(), 0, 11)[0];
    expect(long.w).toBeGreaterThan(short.w);
  });

  it("covers the whole line when the whole line is selected", () => {
    const { ctx } = scene(520, 320, "#000000");
    const element = base({ text: "Hello" });
    // Drawn first, so `ctx` is in the state the preview's chrome pass finds.
    renderText(ctx, "t", element as never, 0);
    const [rect] = selectionRectsOf(ctx, element as never, 0, 5);
    expect(rect.x).toBeCloseTo(0, 3);
    expect(rect.w).toBeGreaterThan(0);
    expect(rect.h).toBeGreaterThan(0);
  });
});

describe("alignment", () => {
  const aligned = (align: "left" | "center" | "right") =>
    base({
      text: "Hello",
      options: {
        isBold: false,
        isItalic: false,
        align,
        outline: { enable: false, size: 0, color: "#000000" },
      },
    });

  it("follows the line's anchor", () => {
    const left = rects(aligned("left"), 0, 5)[0];
    const centre = rects(aligned("center"), 0, 5)[0];
    const right = rects(aligned("right"), 0, 5)[0];

    expect(left.x).toBeCloseTo(0, 3);
    expect(centre.x).toBeGreaterThan(left.x);
    expect(right.x).toBeGreaterThan(centre.x);
    // The box is 420 wide and the line is drawn flush to its right edge.
    expect(right.x + right.w).toBeCloseTo(420, 3);
  });

  it("gives all three the same width", () => {
    const widths = (["left", "center", "right"] as const).map(
      (align) => rects(aligned(align), 1, 4)[0].w,
    );
    expect(widths[1]).toBeCloseTo(widths[0], 3);
    expect(widths[2]).toBeCloseTo(widths[0], 3);
  });
});

describe("a range across lines", () => {
  it("is one rect per line it touches", () => {
    const element = base({ text: "one\ntwo\nthree" });
    expect(rects(element, 0, 3)).toHaveLength(1);
    expect(rects(element, 0, 7)).toHaveLength(2);
    expect(rects(element, 0, 13)).toHaveLength(3);
  });

  it("puts them in reading order, each below the last", () => {
    const element = base({ text: "one\ntwo\nthree" });
    const all = rects(element, 0, 13);
    for (let i = 1; i < all.length; i += 1) {
      expect(all[i].y).toBeGreaterThan(all[i - 1].y);
    }
  });

  it("skips a line the range does not reach", () => {
    const element = base({ text: "one\ntwo\nthree" });
    // Only the last line.
    expect(rects(element, 8, 13)).toHaveLength(1);
  });

  it("follows a wrap as readily as an authored break", () => {
    const element = base({
      text: "aaaa bbbb cccc dddd eeee",
      width: 160,
    });
    expect(rects(element, 0, 24).length).toBeGreaterThan(1);
  });
});

describe("a styled clip", () => {
  it("measures a range that crosses a run boundary", () => {
    const element = base({
      runs: [{ from: 6, to: 11, style: { fontsize: 80 } }],
    });
    const before = rects(element, 0, 6)[0];
    const across = rects(element, 0, 11)[0];
    expect(across.w).toBeGreaterThan(before.w);
    expect(across.x).toBeCloseTo(before.x, 3);
  });

  it("is as tall as the largest type on the line", () => {
    const plain = rects(base(), 0, 17)[0];
    const styled = rects(
      base({ runs: [{ from: 6, to: 11, style: { fontsize: 80 } }] }),
      0,
      17,
    )[0];
    expect(styled.h).toBeGreaterThan(plain.h);
  });

  it("covers only the run when only the run is selected", () => {
    const element = base({
      runs: [{ from: 6, to: 11, style: { color: "#ff0000" } }],
    });
    const run = rects(element, 6, 11)[0];
    const all = rects(element, 0, 17)[0];
    expect(run.x).toBeGreaterThan(all.x);
    expect(run.x + run.w).toBeLessThan(all.x + all.w);
  });
});

describe("the case transform it cannot map", () => {
  it("answers nothing rather than something wrong", () => {
    // Only on the unstyled path, and only where the transform changed the
    // string's length: the line offsets then index the transformed string and
    // the caller's offsets index the stored one.
    const element = base({
      text: "straße",
      options: {
        isBold: false,
        isItalic: false,
        align: "left",
        outline: { enable: false, size: 0, color: "#000000" },
        textTransform: "uppercase",
      },
    });
    expect("straße".toUpperCase().length).not.toBe("straße".length);
    expect(rects(element, 0, 4)).toEqual([]);
  });

  it("still answers for a transform that kept the length", () => {
    const element = base({
      text: "hello",
      options: {
        isBold: false,
        isItalic: false,
        align: "left",
        outline: { enable: false, size: 0, color: "#000000" },
        textTransform: "uppercase",
      },
    });
    expect(rects(element, 0, 5)).toHaveLength(1);
  });
});

describe("context state", () => {
  it("leaves the context exactly as it found it", () => {
    const { ctx } = scene(520, 320, "#000000");
    renderText(ctx, "t", base() as never, 0);

    const font = ctx.font;
    const align = ctx.textAlign;
    const spacing = (ctx as CanvasRenderingContext2D & { letterSpacing: string })
      .letterSpacing;

    selectionRectsOf(
      ctx,
      base({ runs: [{ from: 6, to: 11, style: { fontsize: 80 } }] }) as never,
      0,
      17,
    );

    expect(ctx.font).toBe(font);
    expect(ctx.textAlign).toBe(align);
    expect(
      (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing,
    ).toBe(spacing);
  });
});
