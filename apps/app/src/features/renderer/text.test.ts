import { describe, it, expect } from "vitest";
import { renderText } from "./text";
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

  it("wraps onto further lines, advancing by the element height", () => {
    const single = scene(400, 400, "#000000");
    renderText(single.ctx, "t", base(), 0);
    const oneLine = inkBounds(single.canvas);

    const wrapped = scene(400, 400, "#000000");
    const el = base();
    el.text = "AAAA BBBB CCCC DDDD EEEE FFFF";
    renderText(wrapped.ctx, "t", el, 0);
    const many = inkBounds(wrapped.canvas);

    expect(many.count).toBeGreaterThan(oneLine.count);
    // the second line sits a full element height (60) below the first
    expect(many.maxY).toBeGreaterThan(oneLine.maxY + 40);
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
