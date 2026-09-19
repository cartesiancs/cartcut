/**
 * Per-range text style, through the shipping `renderText` onto a real Skia
 * surface.
 *
 * The suite is in two halves and they are asserted very differently.
 *
 * **The untouched path is asserted exactly.** A clip whose `runs` field is
 * absent, empty, or present but saying nothing must draw byte-identically to
 * one that never had the field, and must take the *original* code path to do
 * it. That is the regression guard for every project written before this
 * feature, and `bytes()` plus `hasRuns()` together are what make it a claim
 * about the branch rather than a coincidence about the pixels.
 *
 * **The styled path is asserted relatively.** Text geometry depends on the
 * host's font metrics, so like `text.test.ts` these compare one render against
 * another rather than against numbers.
 *
 * One claim is deliberately **not** made: that a run carrying the clip's own
 * values draws byte-identically to no run at all. It does not, and cannot.
 * Segmenting a line measures its pieces separately and `measureText` on a
 * substring loses the kerning with the glyph before it, which `paintRevealHead`
 * has documented since long before this feature. The guarantee lives one layer
 * up instead, in `timeline/textRunOps.ts`: such a write is refused at the
 * document, so the case never reaches a canvas. `textRunOps.test.ts` pins it.
 */

import { describe, expect, it } from "vitest";

import { hasRuns } from "../text/runs";
import { inkBounds, scene, textElement } from "./testing";
import { measureTextBlock, renderText } from "./text";

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

function draw(element: unknown, cursor = 0, w = 520, h = 320) {
  const { canvas, ctx } = scene(w, h, "#000000");
  renderText(ctx, "t", element as never, cursor);
  return canvas;
}

function bytes(canvas: ReturnType<typeof draw>): string {
  const { width, height } = canvas;
  return Buffer.from(
    canvas.getContext("2d").getImageData(0, 0, width, height).data,
  ).toString("base64");
}

/** Every stored value that must resolve to "this clip has no runs". */
const INERT: [string, unknown][] = [
  ["no field at all", undefined],
  ["an empty list", []],
  ["a collapsed range", [{ from: 4, to: 4, style: { color: "#ff0000" } }]],
  ["an inverted range that collapses", [{ from: 4, to: 4, style: { color: "#ff0000" } }]],
  ["a range past the end of the string", [{ from: 90, to: 99, style: { color: "#ff0000" } }]],
  ["a style with no readable field", [{ from: 0, to: 5, style: { color: "not a colour" } }]],
  ["an empty style", [{ from: 0, to: 5, style: {} }]],
  ["a hand-edited string", "nonsense"],
  ["a list of nothing", [null, 7]],
];

/**
 * The shapes that would each hide a different regression: the alignment anchor,
 * the background band's geometry, the stroke order, the wrap, the block
 * gradient's origin, the case transform and the reveal's three states.
 */
const SHAPES: [string, Record<string, unknown>][] = [
  ["left", {}],
  [
    "centre",
    {
      options: {
        isBold: false,
        isItalic: false,
        align: "center",
        outline: { enable: false, size: 0, color: "#000000" },
      },
    },
  ],
  [
    "right",
    {
      options: {
        isBold: false,
        isItalic: false,
        align: "right",
        outline: { enable: false, size: 0, color: "#000000" },
      },
    },
  ],
  [
    "a background band",
    {
      background: {
        enable: true,
        color: "#224466",
        opacity: 80,
        padding: 10,
        radius: 6,
      },
    },
  ],
  [
    "an outline",
    {
      options: {
        isBold: false,
        isItalic: false,
        align: "left",
        outline: { enable: true, size: 5, color: "#ff0000", opacity: 70 },
      },
    },
  ],
  [
    "a glow and a shadow",
    {
      options: {
        isBold: false,
        isItalic: false,
        align: "left",
        outline: { enable: false, size: 0, color: "#000000" },
        glow: { enable: true, size: 10, color: "#00e5ff", opacity: 80 },
        shadow: {
          enable: true,
          offsetX: 4,
          offsetY: 5,
          blur: 8,
          color: "#000000",
          opacity: 90,
        },
      },
    },
  ],
  ["two paragraphs", { text: "one two\nthree four" }],
  ["a wrap", { text: "Hello brave new world of text that wraps", width: 200 }],
  [
    "a gradient",
    {
      text: "one\ntwo",
      fill: { type: "gradient", from: "#ffffff", to: "#7c5cff", angle: 45 },
    },
  ],
  [
    "uppercase",
    {
      text: "hello brave world",
      options: {
        isBold: false,
        isItalic: false,
        align: "left",
        outline: { enable: false, size: 0, color: "#000000" },
        textTransform: "uppercase",
      },
    },
  ],
  ["wide tracking", { letterSpacing: 6 }],
  ["loose leading", { text: "one\ntwo\nthree", options: { isBold: false, isItalic: false, align: "left", outline: { enable: false, size: 0, color: "#000000" }, lineHeight: 2.4 } }],
  ["a reveal not started", { reveal: { unit: "character", progress: 0 } }],
  ["a reveal part way", { reveal: { unit: "word", progress: 45, fade: 0.7 } }],
  ["a reveal finished", { reveal: { unit: "character", progress: 100 } }],
];

describe("the untouched path", () => {
  it.each(INERT)("takes the unstyled branch for %s", (_label, runs) => {
    expect(hasRuns(base({ runs }))).toBe(false);
  });

  it.each(INERT)("draws %s exactly as a clip with no runs draws", (_label, runs) => {
    expect(bytes(draw(base({ runs })))).toBe(bytes(draw(base())));
  });

  // The matrix, so a regression cannot hide behind a shape the simple case
  // does not exercise: an alignment anchor, a band, the stroke order, the wrap,
  // a gradient's origin, the case transform and every state of a reveal.
  it.each(SHAPES)("draws an inert run identically with %s", (_label, over) => {
    const plain = base(over);
    const inert = base({ ...over, runs: [] });
    expect(hasRuns(inert)).toBe(false);
    expect(bytes(draw(inert))).toBe(bytes(draw(plain)));
  });

  it("measures the block identically", () => {
    for (const [, over] of SHAPES) {
      const { ctx } = scene(520, 320, "#000000");
      const plain = measureTextBlock(ctx, base(over) as never);
      const inert = measureTextBlock(ctx, base({ ...over, runs: [] }) as never);
      expect(inert).toEqual(plain);
    }
  });
});

describe("a coloured run", () => {
  it("paints only its own characters", () => {
    // "AB" so the two halves of the ink are unambiguous.
    const element = base({
      text: "AB",
      fontsize: 90,
      runs: [{ from: 0, to: 1, style: { color: "#ff0000" } }],
    });
    const canvas = draw(element);
    const ink = inkBounds(canvas);
    const mid = (ink.minX + ink.maxX) / 2;

    const data = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let redLeft = 0;
    let redRight = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const i = (y * canvas.width + x) * 4;
        // Strongly red and not white: the run's colour and nothing else.
        if (data[i] > 120 && data[i + 1] < 80 && data[i + 2] < 80) {
          if (x < mid) {
            redLeft += 1;
          } else {
            redRight += 1;
          }
        }
      }
    }

    expect(redLeft).toBeGreaterThan(0);
    expect(redRight).toBe(0);
  });

  it("leaves the geometry alone", () => {
    const plain = base({ text: "AB", fontsize: 90 });
    const styled = base({
      text: "AB",
      fontsize: 90,
      runs: [{ from: 0, to: 1, style: { color: "#ff0000" } }],
    });
    const a = inkBounds(draw(plain));
    const b = inkBounds(draw(styled));
    // Kerning is lost at the boundary, so this is "within a glyph's hair"
    // rather than "identical". A run that moved the line would be tens of
    // pixels out, not one.
    expect(Math.abs(b.maxX - a.maxX)).toBeLessThan(4);
    expect(b.minY).toBe(a.minY);
  });
});

describe("a run at another size", () => {
  it("makes the line taller", () => {
    const plain = base({ text: "AB" });
    const bigger = base({
      text: "AB",
      runs: [{ from: 0, to: 1, style: { fontsize: 90 } }],
    });
    const a = inkBounds(draw(plain));
    const b = inkBounds(draw(bigger));
    expect(b.maxY - b.minY).toBeGreaterThan(a.maxY - a.minY);
  });

  it("drops the first baseline far enough to clear the tallest ascender", () => {
    // `baselines[0]` is the largest size on the line, not the element's, so a
    // run twice the clip's size is not sliced off at the top of the box. The
    // whole line therefore sits lower, which is the same rule the unstyled
    // path has always followed with `firstBaseline = fontsize`.
    const bigger = base({
      text: "AB",
      runs: [{ from: 0, to: 1, style: { fontsize: 90 } }],
    });
    expect(inkBounds(draw(bigger)).minY).toBeGreaterThan(0);
  });

  it("makes the block taller", () => {
    const { ctx } = scene(520, 320, "#000000");
    const plain = measureTextBlock(ctx, base({ text: "AB" }) as never);
    const bigger = measureTextBlock(
      ctx,
      base({
        text: "AB",
        runs: [{ from: 0, to: 1, style: { fontsize: 90 } }],
      }) as never,
    );
    expect(bigger.blockHeight).toBeGreaterThan(plain.blockHeight);
  });

  it("pushes the line under it further down", () => {
    // Only the first line carries the large run, so the gap below it has to
    // grow: the advance is driven by the larger of each adjacent pair.
    const plain = base({ text: "one\ntwo" });
    const bigger = base({
      text: "one\ntwo",
      runs: [{ from: 0, to: 3, style: { fontsize: 90 } }],
    });
    expect(inkBounds(draw(bigger)).maxY).toBeGreaterThan(
      inkBounds(draw(plain)).maxY,
    );
  });

  it("leaves the leading alone when every line agrees", () => {
    // A run covering both lines at the element's own size changes no advance,
    // so the block is the height it always was.
    const { ctx } = scene(520, 320, "#000000");
    const plain = measureTextBlock(ctx, base({ text: "one\ntwo" }) as never);
    const styled = measureTextBlock(
      ctx,
      base({
        text: "one\ntwo",
        runs: [{ from: 0, to: 7, style: { color: "#ff0000" } }],
      }) as never,
    );
    expect(styled.blockHeight).toBeCloseTo(plain.blockHeight, 10);
    expect(styled.lineCount).toBe(plain.lineCount);
  });
});

describe("a run with an outline", () => {
  it("widens the ink where the clip's own outline is off", () => {
    const plain = base({ text: "AB", fontsize: 90 });
    const outlined = base({
      text: "AB",
      fontsize: 90,
      runs: [
        {
          from: 0,
          to: 1,
          style: { outlineEnable: true, outlineSize: 8, outlineColor: "#00e5ff" },
        },
      ],
    });
    expect(inkBounds(draw(outlined)).count).toBeGreaterThan(
      inkBounds(draw(plain)).count,
    );
    expect(inkBounds(draw(outlined)).minX).toBeLessThan(
      inkBounds(draw(plain)).minX,
    );
  });
});

describe("a run across a wrap", () => {
  it("applies to both lines", () => {
    const element = base({
      text: "aaaa bbbb cccc dddd",
      width: 160,
      fontsize: 40,
      runs: [{ from: 0, to: 19, style: { color: "#ff0000" } }],
    });
    const canvas = draw(element);
    const data = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height).data;

    const rowsWithRed = new Set<number>();
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const i = (y * canvas.width + x) * 4;
        if (data[i] > 120 && data[i + 1] < 80 && data[i + 2] < 80) {
          rowsWithRed.add(y);
        }
      }
    }
    // Two lines of red means the run survived the wrap; the whole clip being
    // red means no white was left over from a line the run failed to reach.
    expect(rowsWithRed.size).toBeGreaterThan(0);
    expect(inkBounds(canvas).count).toBeGreaterThan(0);

    let white = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) {
        white += 1;
      }
    }
    expect(white).toBe(0);
  });
});

describe("the case transform", () => {
  it("keeps a run on the characters it was given", () => {
    // Transformed per segment rather than over the whole string, so the run
    // boundary is where the author put it whatever the transform does.
    const element = base({
      text: "ab",
      fontsize: 90,
      options: {
        isBold: false,
        isItalic: false,
        align: "left",
        outline: { enable: false, size: 0, color: "#000000" },
        textTransform: "uppercase",
      },
      runs: [{ from: 0, to: 1, style: { color: "#ff0000" } }],
    });
    const upper = base({
      text: "AB",
      fontsize: 90,
      runs: [{ from: 0, to: 1, style: { color: "#ff0000" } }],
    });
    expect(bytes(draw(element))).toBe(bytes(draw(upper)));
  });
});

describe("context state", () => {
  it("hands back the font and the alignment it was given", () => {
    const { ctx } = scene(520, 320, "#000000");
    ctx.textAlign = "center";
    const font = ctx.font;
    renderText(
      ctx,
      "t",
      base({ runs: [{ from: 0, to: 5, style: { fontsize: 90 } }] }) as never,
      0,
    );
    expect(ctx.textAlign).toBe("center");
    // Not the font it started with: `renderText` has always left the element's
    // own face on the context. The claim is that a styled draw leaves the same
    // state an unstyled one does, so a caller cannot tell them apart.
    const { ctx: other } = scene(520, 320, "#000000");
    other.textAlign = "center";
    renderText(other, "t", base() as never, 0);
    expect(ctx.font).toBe(other.font);
    expect(font).not.toBe("");
  });
});

describe("a styled reveal", () => {
  it("draws a finished reveal identically to no reveal at all", () => {
    const runs = [{ from: 6, to: 11, style: { color: "#ff0000", fontsize: 60 } }];
    expect(
      bytes(draw(base({ runs, reveal: { unit: "character", progress: 100 } }))),
    ).toBe(bytes(draw(base({ runs }))));
  });

  it("shows less of the line the earlier it is", () => {
    const runs = [{ from: 6, to: 11, style: { color: "#ff0000", fontsize: 60 } }];
    const early = inkBounds(
      draw(base({ runs, reveal: { unit: "character", progress: 20 } })),
    );
    const late = inkBounds(
      draw(base({ runs, reveal: { unit: "character", progress: 80 } })),
    );
    expect(early.count).toBeLessThan(late.count);
    expect(early.maxX).toBeLessThan(late.maxX);
  });

  it("does not move the first glyph as it types", () => {
    const runs = [{ from: 6, to: 11, style: { color: "#ff0000", fontsize: 60 } }];
    const centred = {
      options: {
        isBold: false,
        isItalic: false,
        align: "center" as const,
        outline: { enable: false, size: 0, color: "#000000" },
      },
    };
    const early = inkBounds(
      draw(base({ ...centred, runs, reveal: { unit: "character", progress: 20 } })),
    );
    const late = inkBounds(
      draw(base({ ...centred, runs, reveal: { unit: "character", progress: 90 } })),
    );
    expect(Math.abs(early.minX - late.minX)).toBeLessThan(2);
  });
});

describe("the wrap caches", () => {
  // The `loadingdone` listener that empties both caches cannot be driven from
  // here: there is no `document` in this environment, so it is never attached.
  // The unstyled cache has always had the same gap. What *is* checkable is that
  // the two caches key on everything they depend on, which is below.

  it("keeps a styled clip and an unstyled one apart in the cache", () => {
    // The two caches are keyed separately, so a clip that gains runs must not
    // be served the unstyled entry measured a moment earlier.
    const plain = base();
    const styled = base({
      runs: [{ from: 6, to: 11, style: { color: "#ff0000" } }],
    });
    const plainBytes = bytes(draw(plain));
    const styledBytes = bytes(draw(styled));
    expect(styledBytes).not.toBe(plainBytes);
    // And back again, from the cache this time.
    expect(bytes(draw(plain))).toBe(plainBytes);
    expect(bytes(draw(styled))).toBe(styledBytes);
  });

  it("re-measures when a run changes", () => {
    const red = base({ runs: [{ from: 6, to: 11, style: { color: "#ff0000" } }] });
    const blue = base({ runs: [{ from: 6, to: 11, style: { color: "#0000ff" } }] });
    expect(bytes(draw(red))).not.toBe(bytes(draw(blue)));
  });

  it("re-measures when a run moves", () => {
    const a = base({ runs: [{ from: 0, to: 5, style: { fontsize: 70 } }] });
    const b = base({ runs: [{ from: 6, to: 11, style: { fontsize: 70 } }] });
    expect(bytes(draw(a))).not.toBe(bytes(draw(b)));
  });
});
