import { describe, it, expect } from "vitest";
import { measureTextBlock, renderText } from "./text";
import { scene, pixel, inkBounds, textElement } from "./testing";

/**
 * Text geometry depends on the host's font metrics, so these assert relative
 * placement — which part of the box the glyphs land in, whether a background
 * rect was painted — rather than exact pixel columns.
 */
const base = () =>
  textElement({
    location: { x: 0, y: 0 },
    width: 200,
    height: 60,
    fontsize: 40,
    text: "AB",
    textcolor: "#ffffff",
  });

describe("renderText", () => {
  it("paints the glyphs near the top-left of the box for left align", () => {
    const { canvas, ctx } = scene(300, 300, "#000000");
    renderText(ctx, "t", base(), 0);

    const ink = inkBounds(canvas);
    expect(ink.count).toBeGreaterThan(0);
    expect(ink.minX).toBeLessThan(10);
  });

  it("flushes right-aligned text to the right edge of the box", () => {
    const left = scene(300, 300, "#000000");
    renderText(left.ctx, "t", base(), 0);
    const leftInk = inkBounds(left.canvas);

    const right = scene(300, 300, "#000000");
    const el = base();
    el.options.align = "right";
    renderText(right.ctx, "t", el, 0);
    const rightInk = inkBounds(right.canvas);

    expect(rightInk.maxX).toBeGreaterThan(leftInk.maxX + 100);
    // the box is 200 wide, so the text ends at its right edge
    expect(Math.abs(200 - rightInk.maxX)).toBeLessThan(6);
  });

  it("centres center-aligned text in the box", () => {
    const { canvas, ctx } = scene(300, 300, "#000000");
    const el = base();
    el.options.align = "center";
    renderText(ctx, "t", el, 0);

    const ink = inkBounds(canvas);
    const mid = (ink.minX + ink.maxX) / 2;
    expect(Math.abs(mid - 100)).toBeLessThan(8);
  });

  it("restores textAlign so it does not leak into the next element", () => {
    const { ctx } = scene(300, 300, "#000000");
    ctx.textAlign = "start";
    const el = base();
    el.options.align = "center";
    renderText(ctx, "t", el, 0);
    expect(ctx.textAlign).toBe("start");
  });

  it("wraps onto further lines, advancing by the line height", () => {
    const single = scene(400, 400, "#000000");
    renderText(single.ctx, "t", base(), 0);
    const oneLine = inkBounds(single.canvas);

    const wrapped = scene(400, 400, "#000000");
    const el = base();
    el.text = "AAAA BBBB CCCC DDDD EEEE FFFF";
    renderText(wrapped.ctx, "t", el, 0);
    const many = inkBounds(wrapped.canvas);

    expect(many.count).toBeGreaterThan(oneLine.count);
    // the second line sits a full advance (fontsize 40 × 1.2 = 48) lower
    expect(many.maxY).toBeGreaterThan(oneLine.maxY + 30);
  });

  it("draws a background band behind each line when enabled", () => {
    const plain = scene(300, 300, "#000000");
    renderText(plain.ctx, "t", base(), 0);
    const withoutBg = inkBounds(plain.canvas);

    const boxed = scene(300, 300, "#000000");
    const el = base();
    el.background = { enable: true, color: "#ff0000" };
    renderText(boxed.ctx, "t", el, 0);
    const withBg = inkBounds(boxed.canvas);

    expect(withBg.count).toBeGreaterThan(withoutBg.count);

    let reddish = 0;
    const data = boxed.canvas
      .getContext("2d")
      .getImageData(0, 0, 300, 300).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 120 && data[i + 1] < 90 && data[i + 2] < 90) reddish++;
    }
    expect(reddish).toBeGreaterThan(0);
  });

  it("strokes an outline in its own colour when enabled", () => {
    const { canvas, ctx } = scene(300, 300, "#000000");
    const el = base();
    el.options.outline = { enable: true, size: 6, color: "#ff0000" };
    renderText(ctx, "t", el, 0);

    const data = canvas.getContext("2d").getImageData(0, 0, 300, 300).data;
    let reddish = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 120 && data[i + 1] < 90 && data[i + 2] < 90) reddish++;
    }
    expect(reddish).toBeGreaterThan(0);
  });

  it("renders larger glyphs for a larger fontsize", () => {
    const small = scene(400, 400, "#000000");
    renderText(small.ctx, "t", base(), 0);

    const large = scene(400, 400, "#000000");
    const el = base();
    el.fontsize = 80;
    renderText(large.ctx, "t", el, 0);

    expect(inkBounds(large.canvas).count).toBeGreaterThan(
      inkBounds(small.canvas).count,
    );
  });

  it("draws nothing visible for empty text", () => {
    const { canvas, ctx } = scene(300, 300, "#000000");
    const el = base();
    el.text = "";
    renderText(ctx, "t", el, 0);

    expect(inkBounds(canvas).count).toBe(0);
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 0, g: 0, b: 0 });
  });
});

/**
 * The wrap is cached, because `measureText`-per-word was running on every
 * frame for every caption even though nothing it reads depends on the cursor.
 * These pin the cache key: anything that changes the layout must miss it.
 */
describe("renderText wrap caching", () => {
  const wrapping = (overrides = {}) =>
    textElement({
      location: { x: 0, y: 0 },
      width: 200,
      height: 30,
      fontsize: 20,
      text: "alpha bravo charlie delta echo foxtrot golf hotel",
      textcolor: "#ffffff",
      ...overrides,
    });

  it("draws identically when the same text is rendered twice", () => {
    const first = scene(300, 300, "#000000");
    renderText(first.ctx, "t", wrapping(), 0);
    const second = scene(300, 300, "#000000");
    renderText(second.ctx, "t", wrapping(), 1000);

    expect(inkBounds(second.canvas)).toEqual(inkBounds(first.canvas));
  });

  it("re-wraps when the box width changes", () => {
    const narrow = scene(300, 300, "#000000");
    renderText(narrow.ctx, "t", wrapping({ width: 100 }), 0);
    const wide = scene(300, 300, "#000000");
    renderText(wide.ctx, "t", wrapping({ width: 280 }), 0);

    // A narrower box takes more lines, so the ink reaches further down.
    expect(inkBounds(narrow.canvas).maxY).toBeGreaterThan(
      inkBounds(wide.canvas).maxY,
    );
  });

  it("re-wraps when the font size changes", () => {
    const small = scene(300, 300, "#000000");
    renderText(small.ctx, "t", wrapping({ fontsize: 12 }), 0);
    const large = scene(300, 300, "#000000");
    renderText(large.ctx, "t", wrapping({ fontsize: 28 }), 0);

    expect(inkBounds(large.canvas).count).not.toBe(
      inkBounds(small.canvas).count,
    );
  });

  it("re-wraps when the text itself changes", () => {
    const a = scene(300, 300, "#000000");
    renderText(a.ctx, "t", wrapping({ text: "one two" }), 0);
    const b = scene(300, 300, "#000000");
    renderText(b.ctx, "t", wrapping({ text: "completely different words" }), 0);

    expect(inkBounds(b.canvas).count).not.toBe(inkBounds(a.canvas).count);
  });
});

/**
 * Text effects.
 *
 * Same discipline as above: relative placement and colour counts, never exact
 * columns, because the glyph metrics come from whatever face the host resolves.
 */
describe("renderText effects", () => {
  /** Pixels matching a predicate, with their bounding box. */
  function coloured(
    canvas: ReturnType<typeof scene>["canvas"],
    pick: (r: number, g: number, b: number) => boolean,
  ) {
    const { width, height } = canvas;
    const d = canvas.getContext("2d").getImageData(0, 0, width, height).data;
    let count = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (pick(d[i], d[i + 1], d[i + 2])) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return { count, minX, minY, maxX, maxY };
  }

  const isRed = (r: number, g: number, b: number) => r > 30 && g < 30 && b < 30;
  const isWhite = (r: number, g: number, b: number) =>
    r > 200 && g > 200 && b > 200;

  const shadowed = (over: Record<string, unknown> = {}) => {
    const el = base();
    el.options.shadow = {
      enable: true,
      offsetX: 20,
      offsetY: 14,
      blur: 0,
      color: "#ff0000",
      opacity: 100,
      ...over,
    };
    return el;
  };

  it("casts a shadow down and to the right of the glyphs", () => {
    const { canvas, ctx } = scene(300, 300, "#000000");
    renderText(ctx, "t", shadowed(), 0);

    const white = coloured(canvas, isWhite);
    const red = coloured(canvas, isRed);

    expect(red.count).toBeGreaterThan(0);
    expect(red.minX).toBeGreaterThan(white.minX);
    expect(red.minY).toBeGreaterThan(white.minY);
    // Within a pixel of the requested offset: the two colours cross the
    // detection threshold at slightly different points on an antialiased edge.
    expect(Math.abs(red.maxX - white.maxX - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(red.maxY - white.maxY - 14)).toBeLessThanOrEqual(1);
  });

  it("draws no shadow while it is disabled", () => {
    const el = shadowed();
    el.options.shadow!.enable = false;

    const { canvas, ctx } = scene(300, 300, "#000000");
    renderText(ctx, "t", el, 0);

    expect(coloured(canvas, isRed).count).toBe(0);
    expect(inkBounds(canvas).count).toBeGreaterThan(0);
  });

  it("leaves the glyphs themselves untouched by the shadow pass", () => {
    // `paintShadowOnly` must not print the lettering a second time — the ink
    // the glyphs occupy has to be identical with and without a shadow.
    const plain = scene(300, 300, "#000000");
    renderText(plain.ctx, "t", base(), 0);

    const withShadow = scene(300, 300, "#000000");
    renderText(withShadow.ctx, "t", shadowed(), 0);

    expect(coloured(withShadow.canvas, isWhite).count).toBe(
      coloured(plain.canvas, isWhite).count,
    );
  });

  it("spreads a glow on every side of the glyphs", () => {
    const el = base();
    el.options.glow = {
      enable: true,
      size: 10,
      color: "#ff0000",
      opacity: 100,
    };

    const { canvas, ctx } = scene(300, 300, "#000000");
    renderText(ctx, "t", el, 0);

    const white = coloured(canvas, isWhite);
    const red = coloured(canvas, isRed);

    expect(red.minX).toBeLessThan(white.minX);
    expect(red.maxX).toBeGreaterThan(white.maxX);
    expect(red.minY).toBeLessThan(white.minY);
    expect(red.maxY).toBeGreaterThan(white.maxY);
  });

  it("fades the glyphs with textOpacity but not the background band", () => {
    const boxed = () => {
      const el = base();
      el.background = { enable: true, color: "#0000ff", opacity: 100 };
      return el;
    };

    const opaque = scene(300, 300, "#000000");
    renderText(opaque.ctx, "t", boxed(), 0);

    const faded = boxed();
    faded.textOpacity = 40;
    const half = scene(300, 300, "#000000");
    renderText(half.ctx, "t", faded, 0);

    // The glyphs dim...
    expect(coloured(half.canvas, isWhite).count).toBeLessThan(
      coloured(opaque.canvas, isWhite).count,
    );
    // ...while the box behind them keeps its own colour.
    const isBlue = (r: number, g: number, b: number) => b > 200 && r < 60;
    expect(coloured(half.canvas, isBlue).count).toBeGreaterThan(0);
  });

  it("honours the background opacity", () => {
    const el = base();
    el.text = " ";
    el.background = { enable: true, color: "#ffffff", opacity: 50 };

    const { canvas, ctx } = scene(300, 300, "#000000");
    renderText(ctx, "t", el, 0);

    // A 50%-opaque white band over black lands around mid grey.
    const band = pixel(canvas, 4, 30);
    expect(band.r).toBeGreaterThan(90);
    expect(band.r).toBeLessThan(170);
  });

  it("rounds the background corners", () => {
    const boxed = (radius: number) => {
      const el = base();
      el.background = {
        enable: true,
        color: "#ffffff",
        opacity: 100,
        padding: 20,
        radius,
      };
      return el;
    };

    const square = scene(300, 300, "#000000");
    renderText(square.ctx, "t", boxed(0), 0);
    const round = scene(300, 300, "#000000");
    renderText(round.ctx, "t", boxed(20), 0);

    // Rounding removes area at the corners and nowhere else.
    expect(inkBounds(round.canvas).count).toBeLessThan(
      inkBounds(square.canvas).count,
    );
  });

  it("does not throw on a radius larger than the box", () => {
    const el = base();
    el.background = {
      enable: true,
      color: "#ffffff",
      opacity: 100,
      padding: 4,
      radius: 9999,
    };

    const { ctx } = scene(300, 300, "#000000");
    expect(() => renderText(ctx, "t", el, 0)).not.toThrow();
  });

  it("paints a gradient fill that differs across the block", () => {
    const el = base();
    el.text = "AAAAAA";
    // Roughly the drawn width of that string, so the glyphs sample the whole
    // gradient. In a much wider box they would only ever touch its first third
    // and never reach the "to" colour at all.
    el.width = 150;
    el.fill = { type: "gradient", from: "#ff0000", to: "#0000ff", angle: 0 };

    const { canvas, ctx } = scene(300, 300, "#000000");
    renderText(ctx, "t", el, 0);

    // Which channel dominates, rather than an absolute threshold — the middle
    // of the ramp is a purple that is neither "red" nor "blue".
    const red = coloured(canvas, (r, _g, b) => r > 30 && r > b);
    const blue = coloured(canvas, (r, _g, b) => b > 30 && b > r);

    expect(red.count).toBeGreaterThan(0);
    expect(blue.count).toBeGreaterThan(0);
    // 0° runs left to right, so the "from" colour is on the left.
    expect(red.minX).toBeLessThan(blue.minX);
    expect(blue.maxX).toBeGreaterThan(red.maxX);
  });

  it("turns the gradient with its angle", () => {
    const gradientAt = (angle: number) => {
      const el = base();
      el.text = "AAAAAA";
      el.width = 150;
      el.fill = { type: "gradient", from: "#ff0000", to: "#0000ff", angle };
      const { canvas, ctx } = scene(300, 300, "#000000");
      renderText(ctx, "t", el, 0);
      return coloured(canvas, (r, _g, b) => b > 30 && b > r);
    };

    // At 0° the blue end is on the right; at 180° it has swapped to the left.
    expect(gradientAt(180).minX).toBeLessThan(gradientAt(0).minX);
  });

  it("uppercases before measuring, so the wrap reflects the drawn text", () => {
    const lower = scene(300, 300, "#000000");
    const a = base();
    a.text = "abc";
    renderText(lower.ctx, "t", a, 0);

    const upper = scene(300, 300, "#000000");
    const b = base();
    b.text = "abc";
    b.options.textTransform = "uppercase";
    renderText(upper.ctx, "t", b, 0);

    // Capitals are taller and wider in essentially every face.
    expect(inkBounds(upper.canvas).maxX).toBeGreaterThan(
      inkBounds(lower.canvas).maxX,
    );
  });

  it("renders a pre-effects element exactly as it did before", () => {
    // The compatibility guarantee: an element with none of the new fields must
    // produce the same pixels as one whose effects are all explicitly off.
    const legacy = base();
    delete (legacy as { fill?: unknown }).fill;
    delete (legacy as { textOpacity?: unknown }).textOpacity;

    const a = scene(300, 300, "#000000");
    renderText(a.ctx, "t", legacy, 0);

    const explicit = base();
    explicit.textOpacity = 100;
    explicit.fill = { type: "solid" };
    const b = scene(300, 300, "#000000");
    renderText(b.ctx, "t", explicit, 0);

    expect(inkBounds(b.canvas)).toEqual(inkBounds(a.canvas));
  });
});

/**
 * Explicit line breaks.
 *
 * `ctx.fillText` draws no break — it collapses a `\n` and paints the run as one
 * line — so every assertion here is really asking whether the string reached
 * the canvas as separate draws. Same discipline as above: two scenes compared
 * against each other, never an absolute column, because the metrics come from
 * whichever face the host resolved.
 */
describe("renderText hard line breaks", () => {
  const withText = (text: string, over: Record<string, unknown> = {}) => {
    const el = base();
    el.text = text;
    Object.assign(el, over);
    return el;
  };

  const draw = (text: string, over: Record<string, unknown> = {}, size = 400) => {
    const { canvas, ctx } = scene(size, size, "#000000");
    renderText(ctx, "t", withText(text, over), 0);
    return canvas;
  };

  /** Ink bounds restricted to a horizontal band, for asking about one line. */
  function inkBandIn(
    canvas: ReturnType<typeof scene>["canvas"],
    y0: number,
    y1: number,
  ) {
    const { width } = canvas;
    const d = canvas.getContext("2d").getImageData(0, y0, width, y1 - y0).data;
    let count = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let y = 0; y < y1 - y0; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    return { count, minX, maxX };
  }

  it("breaks the line at a newline", () => {
    const one = inkBounds(draw("AB"));
    const two = inkBounds(draw("A\nB"));

    // The second glyph moved off the first line: narrower, and a full line
    // advance (fontsize 40 × 1.2 = 48) further down.
    expect(two.maxX).toBeLessThan(one.maxX);
    expect(two.maxY).toBeGreaterThan(one.maxY + 30);
  });

  it("breaks even when both words would have fitted on one line", () => {
    // "A B" is far narrower than the 200px box, so the greedy wrap leaves it
    // alone. Only the newline can split this — which is exactly what splitting
    // on spaces alone can never do.
    const spaced = inkBounds(draw("A B"));
    const broken = inkBounds(draw("A\nB"));

    expect(broken.maxY).toBeGreaterThan(spaced.maxY + 30);
  });

  it("gives a blank line a full line advance of its own", () => {
    const tight = inkBounds(draw("A\nB"));
    const spaced = inkBounds(draw("A\n\nB"));

    // One extra advance — fontsize 40 × the default 1.2 line height — and
    // nothing else. `element.height` is 60 here and must not enter into it.
    expect(Math.abs(spaced.maxY - tight.maxY - 48)).toBeLessThanOrEqual(4);
    expect(spaced.minY).toBe(tight.minY);
  });

  it("reads CRLF and a lone CR as the same break", () => {
    expect(inkBounds(draw("A\r\nB"))).toEqual(inkBounds(draw("A\nB")));
    expect(inkBounds(draw("A\rB"))).toEqual(inkBounds(draw("A\nB")));
  });

  it("still wraps to the box width inside each paragraph", () => {
    // "AAAA BBBB CCCC" cannot fit a 200px box at 40px, so it wraps on its own.
    // How many lines that takes depends on the host's face, so the claim is
    // only that it took more than one — and that the newline then adds one more
    // on top of whatever the wrap decided.
    const single = inkBounds(draw("AAAA"));
    const plain = inkBounds(draw("AAAA BBBB CCCC"));
    const wrapped = inkBounds(draw("AAAA BBBB CCCC\nDD"));

    expect(plain.maxY).toBeGreaterThan(single.maxY + 30);
    expect(wrapped.maxY).toBeGreaterThan(plain.maxY + 30);
  });

  it("applies alignment to each line separately", () => {
    const canvas = draw("AAAA\nB", { options: { ...base().options, align: "right" } });

    // Both lines end at the box's right edge, so the short one is not left
    // hanging where the long one ended.
    const first = inkBandIn(canvas, 0, 60);
    const second = inkBandIn(canvas, 60, 130);
    expect(first.count).toBeGreaterThan(0);
    expect(second.count).toBeGreaterThan(0);
    expect(Math.abs(200 - first.maxX)).toBeLessThan(6);
    expect(Math.abs(200 - second.maxX)).toBeLessThan(6);
  });

  it("centres each line on its own width", () => {
    const canvas = draw("AAAA\nB", { options: { ...base().options, align: "center" } });

    const second = inkBandIn(canvas, 60, 130);
    expect(second.count).toBeGreaterThan(0);
    expect(Math.abs((second.minX + second.maxX) / 2 - 100)).toBeLessThan(8);
  });

  it("draws no background band behind a blank line", () => {
    const reds = (text: string) => {
      const canvas = draw(text, {
        background: { enable: true, color: "#ff0000", opacity: 100 },
      });
      const d = canvas.getContext("2d").getImageData(0, 0, 400, 400).data;
      let count = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 120 && d[i + 1] < 90 && d[i + 2] < 90) count++;
      }
      return count;
    };

    // A line holding a single space has width, so it earns a band; a truly
    // empty one does not. Both occupy the same three line advances, so the
    // only difference between these two is the guard.
    expect(reds("A\n\nB")).toBeLessThan(reds("A\n \nB"));
  });

  it("runs one gradient down the whole block, not one per line", () => {
    const canvas = draw("A\nB", {
      fill: { type: "gradient", from: "#ff0000", to: "#0000ff", angle: 90 },
    });

    const d = canvas.getContext("2d").getImageData(0, 0, 400, 400).data;
    let redMaxY = -Infinity;
    let blueMaxY = -Infinity;
    let redCount = 0;
    for (let y = 0; y < 400; y++) {
      for (let x = 0; x < 400; x++) {
        const i = (y * 400 + x) * 4;
        if (d[i] > 30 && d[i] > d[i + 2]) {
          redCount++;
          if (y > redMaxY) redMaxY = y;
        } else if (d[i + 2] > 30 && d[i + 2] > d[i]) {
          if (y > blueMaxY) blueMaxY = y;
        }
      }
    }

    // 90° runs top to bottom, so the first line sits in the "from" half and the
    // second entirely in the "to" half. Restarting the ramp per line would put
    // red at the top of the second line too.
    expect(redCount).toBeGreaterThan(0);
    expect(redMaxY).toBeLessThan(60);
    expect(blueMaxY).toBeGreaterThan(60);
  });

  it("still draws nothing visible for empty text", () => {
    const canvas = draw("");
    expect(inkBounds(canvas).count).toBe(0);
  });
});

/**
 * The block measurement, which sizes the offscreen canvas rasterisation draws
 * into and is what `element/textFit.ts` writes back as the element's height.
 * A block is taller than one line by one advance per extra line — get this
 * wrong and a rasterised PNG slices its own lower lines off.
 */
describe("measureTextBlock", () => {
  const measure = (text: string, over: Record<string, unknown> = {}) => {
    const { ctx } = scene(400, 400, "#000000");
    const el = base();
    el.text = text;
    Object.assign(el, over);
    return measureTextBlock(ctx, el);
  };

  it("counts one line for text with no break", () => {
    expect(measure("A").lineCount).toBe(1);
  });

  it("grows by exactly one advance per newline", () => {
    const one = measure("A");
    const two = measure("A\nB");

    expect(two.lineCount).toBe(2);
    // Exactly one advance: fontsize 40 × the default 1.2 line height. The
    // trailing slack comes from the *font's* descent, which is the same for
    // both, so this is an equality rather than a window.
    expect(two.blockHeight - one.blockHeight).toBeCloseTo(48, 5);
  });

  it("does not depend on the element's height", () => {
    // The regression this whole change is about.
    expect(measure("A\nB", { height: 300 }).blockHeight).toBeCloseTo(
      measure("A\nB", { height: 10 }).blockHeight,
      5,
    );
  });

  it("follows the line height", () => {
    const single = base();
    const tight = measure("A\nB", {
      options: { ...single.options, lineHeight: 1 },
    });
    const loose = measure("A\nB", {
      options: { ...single.options, lineHeight: 2 },
    });

    expect(loose.blockHeight - tight.blockHeight).toBeCloseTo(40, 5);
  });

  it("does not jump when the last line gains a descender", () => {
    // Font metrics, not ink metrics. A box measured from the ink would be
    // shorter for "oo" than for "gg", so the element would resize itself every
    // time the last line's letters changed.
    expect(measure("A\noo").blockHeight).toBeCloseTo(
      measure("A\ngg").blockHeight,
      5,
    );
  });

  it("counts a trailing newline as a line", () => {
    // A textarea shows a caret on that line, so the block owns the space.
    expect(measure("A\n").lineCount).toBe(2);
  });

  it("counts a blank line between paragraphs", () => {
    expect(measure("A\n\nB").lineCount).toBe(3);
  });
});

/**
 * Line spacing, now that it is a property of the type rather than of the box.
 *
 * This is the bug these tests exist for: growing a text clip's `height` used to
 * push its lines apart, because `height` *was* the line advance. It no longer
 * reaches the layout at all.
 */
describe("renderText line spacing", () => {
  const draw = (over: Record<string, unknown> = {}, text = "A\nB") => {
    const { canvas, ctx } = scene(400, 400, "#000000");
    const el = base();
    el.text = text;
    Object.assign(el, over);
    renderText(ctx, "t", el, 0);
    return canvas;
  };

  it("ignores the element height entirely", () => {
    // A 5× taller box must draw the identical picture.
    expect(inkBounds(draw({ height: 300 }))).toEqual(
      inkBounds(draw({ height: 60 })),
    );
    expect(inkBounds(draw({ height: 1 }))).toEqual(
      inkBounds(draw({ height: 60 })),
    );
  });

  it("scales the spacing with the font size", () => {
    const small = inkBounds(draw({ fontsize: 20 }));
    const large = inkBounds(draw({ fontsize: 40 }));

    // Twice the size, twice the advance, so the block reaches further down.
    expect(large.maxY).toBeGreaterThan(small.maxY + 20);
  });

  it("moves the second line by the line height", () => {
    const options = base().options;
    const single = inkBounds(draw({ options }, "A"));
    const tight = inkBounds(draw({ options: { ...options, lineHeight: 1 } }));
    const loose = inkBounds(draw({ options: { ...options, lineHeight: 2 } }));

    // The second baseline sits `fontsize × lineHeight` below the first, so the
    // drop from a one-line block doubles when the leading does.
    const tightDrop = tight.maxY - single.maxY;
    const looseDrop = loose.maxY - single.maxY;
    expect(Math.abs(looseDrop - tightDrop * 2)).toBeLessThanOrEqual(4);
  });

  it("treats an absent lineHeight as 1.2", () => {
    const options = base().options;
    expect(inkBounds(draw({ options: { ...options, lineHeight: 1.2 } }))).toEqual(
      inkBounds(draw({ options })),
    );
  });

  it("draws single-line text identically whatever the height or leading", () => {
    // The compatibility guarantee: the advance is only consulted from the
    // second line on, so every existing one-line title is untouched.
    const options = base().options;
    const reference = inkBounds(draw({}, "AB"));

    expect(inkBounds(draw({ height: 300 }, "AB"))).toEqual(reference);
    expect(inkBounds(draw({ options: { ...options, lineHeight: 3 } }, "AB"))).toEqual(
      reference,
    );
  });

  it("survives a nonsense line height rather than stacking the lines", () => {
    const options = base().options;
    const broken = inkBounds(
      draw({ options: { ...options, lineHeight: NaN } }),
    );
    expect(broken).toEqual(inkBounds(draw({ options })));
  });
});



/**
 * The frosted background band: `background.blur` as a *backdrop* blur.
 *
 * The band's own edge stays crisp and its colour is unchanged; what moves is the
 * picture behind it. So every test here paints a **sharp vertical edge** first —
 * red on the left, blue on the right — and then asks what happened to that edge
 * inside the band and outside it. A step that became a ramp is a frost; a step
 * that stayed a step is not.
 *
 * `renderText` reads the backdrop from its fifth argument rather than from
 * `ctx.canvas`, which is what lets the frost survive the isolated compositing
 * path — `backdropComposite.test.ts` is where that is checked, through
 * `renderElement`. Here the backdrop is passed explicitly, including the case
 * where it *is* the destination, because the fast path draws straight onto the
 * frame and the engine has to tolerate a canvas being its own source.
 */
describe("renderText background blur", () => {
  /**
   * Where the element is placed, in its own pixels, and where the backdrop's
   * step is painted at 1x. They are equal, which puts the step at the element's
   * own x = 0 — well inside a band that spans -60..71 — at every scale.
   */
  const OFFSET = 100;
  const EDGE = 100;
  const SIZE = 400;

  /** A sharp vertical edge to frost, and its context. */
  function backdropScene(scale = 1) {
    const { canvas, ctx } = scene(SIZE * scale, SIZE * scale);
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, EDGE * scale, SIZE * scale);
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(EDGE * scale, 0, (SIZE - EDGE) * scale, SIZE * scale);
    return { canvas, ctx };
  }

  const frosted = (over: Record<string, unknown> = {}) => {
    const el = base();
    // A wide band with no lettering in it: " " keeps the line non-blank (a blank
    // line draws no band at all) while leaving the frost unobscured by glyphs.
    el.text = " ";
    el.width = 240;
    el.background = {
      enable: true,
      color: "#000000",
      // A transparent tint, so what the pixels show is the frost alone. The
      // colour is the one thing about the band this feature did not change.
      opacity: 0,
      padding: 60,
      radius: 0,
      ...over,
    };
    return el;
  };

  /**
   * Draw `element` over the sharp edge and hand back the canvas.
   *
   * `scale` goes on the context the way the preview's zoom × DPR does, and the
   * translate puts the band well inside the frame so its own edges are not
   * confused with the canvas's.
   */
  function frost(element: ReturnType<typeof frosted>, scale = 1) {
    const { canvas, ctx } = backdropScene(scale);
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(OFFSET, OFFSET);
    renderText(ctx, "t", element, 0, { canvas });
    ctx.restore();
    return canvas;
  }

  /** How many pixels of `row` are neither the red nor the blue of the edge. */
  function rampWidth(canvas: ReturnType<typeof scene>["canvas"], y: number) {
    const width = canvas.width;
    const d = canvas.getContext("2d").getImageData(0, y, width, 1).data;
    let mixed = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = [d[x * 4], d[x * 4 + 1], d[x * 4 + 2]];
      // Anything between the two solids: the blur mixes them channel by channel.
      if (r > 20 && r < 235 && b > 20 && b < 235) {
        mixed += 1;
      }
      // The engines disagree by a hair on an antialiased sample, not on hue.
      expect(g).toBeLessThan(40);
    }
    return mixed;
  }

  it("blurs the picture behind the band", () => {
    const sharp = frost(frosted());
    const glass = frost(frosted({ blur: 12 }));

    // Through the middle of the band: a step becomes a ramp tens of pixels wide.
    const middle = OFFSET + base().fontsize;
    expect(rampWidth(sharp, middle)).toBe(0);
    expect(rampWidth(glass, middle)).toBeGreaterThan(20);
  });

  it("leaves everything outside the band alone", () => {
    const glass = frost(frosted({ blur: 12 }));

    // Above the band, the edge is still an edge...
    expect(rampWidth(glass, 8)).toBe(0);
    // ...and the two solids are untouched on the row that is frosted.
    const middle = OFFSET + base().fontsize;
    const left = pixel(glass, 4, middle);
    const right = pixel(glass, SIZE - 4, middle);
    expect([left.r, left.g, left.b]).toEqual([255, 0, 0]);
    expect([right.r, right.g, right.b]).toEqual([0, 0, 255]);
  });

  it("draws the same pixels for blur 0 as for no blur at all", () => {
    // The compatibility case. A project written before the field existed has no
    // `blur` and has to take the untouched path — which is what lets this
    // feature leave `SCHEMA_VERSION` alone.
    const absent = frost(frosted());
    const zero = frost(frosted({ blur: 0 }));

    const a = absent.getContext("2d").getImageData(0, 0, SIZE, SIZE).data;
    const b = zero.getContext("2d").getImageData(0, 0, SIZE, SIZE).data;
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
  });

  it("keeps the band's own edge crisp", () => {
    // What is soft is the backdrop, not the band. An opaque band over a plain
    // backdrop must go from paper to tint within an antialiased pixel, whatever
    // the blur — a blurred *band* would ramp across tens of them.
    const { canvas, ctx } = scene(SIZE, SIZE, "#ffffff");
    ctx.translate(OFFSET, OFFSET);
    renderText(ctx, "t", frosted({ blur: 20, opacity: 100 }), 0, { canvas });

    const d = canvas
      .getContext("2d")
      .getImageData(0, OFFSET + base().fontsize, SIZE, 1).data;
    let partial = 0;
    for (let x = 0; x < SIZE; x += 1) {
      const v = d[x * 4];
      if (v > 20 && v < 235) {
        partial += 1;
      }
    }
    // One antialiased pixel per edge, at most: the band's box has a fractional
    // right edge because the line's measured width does.
    expect(partial).toBeLessThanOrEqual(2);
  });

  it("frosts only inside the rounded corners", () => {
    // Over stripes rather than a single step, because the frosted *area* is what
    // is being measured and stripes make every pixel of it mixed. The clip is
    // traced under the element's own transform, so the corner is a real rounded
    // corner and not the band's bounding box.
    const striped = (element: ReturnType<typeof frosted>) => {
      const { canvas, ctx } = scene(SIZE, SIZE);
      for (let x = 0; x < SIZE; x += 20) {
        ctx.fillStyle = "#ff0000";
        ctx.fillRect(x, 0, 10, SIZE);
        ctx.fillStyle = "#0000ff";
        ctx.fillRect(x + 10, 0, 10, SIZE);
      }
      ctx.translate(OFFSET, OFFSET);
      renderText(ctx, "t", element, 0, { canvas });

      const d = canvas.getContext("2d").getImageData(0, 0, SIZE, SIZE).data;
      let mixed = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 20 && d[i] < 235 && d[i + 2] > 20 && d[i + 2] < 235) {
          mixed += 1;
        }
      }
      return mixed;
    };

    const square = striped(frosted({ blur: 12, radius: 0 }));
    const round = striped(frosted({ blur: 12, radius: 40 }));

    // Sharp stripes are never mixed, so what is counted is the frosted area.
    expect(square).toBeGreaterThan(0);
    // Rounding takes frosted area off the four corners and nowhere else: four
    // corners of a 40px radius are 4 * (1 - pi/4) * 1600 ~ 1370 pixels.
    expect(square - round).toBeGreaterThan(900);
    expect(square - round).toBeLessThan(1900);
  });

  it("scales the blur with the transform", () => {
    // The preview draws through zoom × DPR and the export draws 1:1, so a blur
    // that did not go through the matrix would be a different picture in the
    // two. At 2x the ramp is twice as wide in device pixels — the same picture,
    // twice the size.
    const one = rampWidth(frost(frosted({ blur: 12 })), OFFSET + 40);
    const two = rampWidth(frost(frosted({ blur: 12 }), 2), (OFFSET + 40) * 2);

    expect(one).toBeGreaterThan(20);
    expect(Math.abs(two - one * 2)).toBeLessThanOrEqual(4);
  });

  it("draws no frost, and no band, behind a blank line", () => {
    const blank = frosted({ blur: 12 });
    blank.text = "\n";

    const glass = frost(blank);
    expect(rampWidth(glass, OFFSET + 40)).toBe(0);
  });

  it("frosts every line of a wrapped block in one pass", () => {
    // Two lines whose bands overlap at the default padding, which is the case
    // the union pass exists for: the seam between them must be frosted once,
    // not frosted and then frosted again through the first band's tint.
    const el = frosted({ blur: 10, padding: 12, opacity: 60 });
    el.text = "AAAA\nAAAA";
    el.textcolor = "#000000";

    const glass = frost(el);
    const firstLine = OFFSET + base().fontsize - 8;
    const secondLine = OFFSET + base().fontsize + 48 - 8;
    expect(rampWidth(glass, firstLine)).toBeGreaterThan(10);
    expect(rampWidth(glass, secondLine)).toBeGreaterThan(10);
  });

  it("declines silently when there is no backdrop to read", () => {
    // `rasterizeText` draws onto an empty canvas and passes none, and a
    // transition's isolated buffer has none either. A frosted band then draws
    // its tint and no frost — the contract a LUT that is not installed has.
    const { canvas, ctx } = backdropScene();
    ctx.translate(OFFSET, OFFSET);
    expect(() =>
      renderText(ctx, "t", frosted({ blur: 12 }), 0),
    ).not.toThrow();

    expect(rampWidth(canvas, OFFSET + 40)).toBe(0);
  });

  it("declines when the backdrop is not on the destination's pixel grid", () => {
    // The frost is blitted at identity, so a backdrop of another size would
    // land out of register. Better to draw no frost than the wrong picture.
    const { canvas, ctx } = backdropScene();
    const other = scene(SIZE / 2, SIZE / 2, "#00ff00");
    ctx.translate(OFFSET, OFFSET);
    renderText(ctx, "t", frosted({ blur: 12 }), 0, { canvas: other.canvas });

    expect(rampWidth(canvas, OFFSET + 40)).toBe(0);
  });
});
