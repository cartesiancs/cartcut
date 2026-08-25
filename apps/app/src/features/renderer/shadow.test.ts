import { describe, it, expect } from "vitest";
import { matrixScale, paintShadowOnly } from "./shadow";
import { inkBounds, pixel, scene } from "./testing";

/** Pixels that are recognisably the shadow colour rather than the source. */
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

const isRed = (r: number, g: number, b: number) => r > 80 && g < 60 && b < 60;
const isWhite = (r: number, g: number, b: number) =>
  r > 200 && g > 200 && b > 200;

/** Draw a 20×20 white square at user (40,40). */
function square(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(40, 40, 20, 20);
}

describe("paintShadowOnly", () => {
  it("paints the shadow but not the source", () => {
    // The whole point: several passes draw the same shape, so none of them may
    // leave the shape itself behind or the final glyph gets painted N times.
    const { canvas, ctx } = scene(200, 200, "#000000");

    paintShadowOnly(ctx, () => square(ctx), {
      offsetX: 0,
      offsetY: 0,
      blur: 0,
      color: "#ff0000",
    });

    expect(coloured(canvas, isRed).count).toBeGreaterThan(300);
    expect(coloured(canvas, isWhite).count).toBe(0);
  });

  it("places a hard-edged shadow at the requested offset", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");

    paintShadowOnly(ctx, () => square(ctx), {
      offsetX: 30,
      offsetY: 10,
      blur: 0,
      color: "#ff0000",
    });

    const red = coloured(canvas, isRed);
    expect(red.minX).toBe(70); // 40 + 30
    expect(red.minY).toBe(50); // 40 + 10
    expect(red.maxX).toBe(89);
    expect(red.maxY).toBe(69);
  });

  it("spreads past the shape when blurred", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");

    paintShadowOnly(ctx, () => square(ctx), {
      offsetX: 0,
      offsetY: 0,
      blur: 12,
      color: "#ff0000",
    });

    const red = coloured(canvas, isRed);
    expect(red.minX).toBeLessThan(40);
    expect(red.minY).toBeLessThan(40);
    expect(red.maxX).toBeGreaterThan(59);
  });

  it("scales the offset with the transform", () => {
    // The regression that matters most. Canvas shadow offsets are device-space
    // and ignore the CTM, so without the correction in `paintShadowOnly` this
    // shadow would sit 30px from the square instead of 60 — which is exactly
    // how a zoomed preview would disagree with the export.
    const { canvas, ctx } = scene(400, 400, "#000000");
    ctx.scale(2, 2);

    paintShadowOnly(ctx, () => square(ctx), {
      offsetX: 30,
      offsetY: 0,
      blur: 0,
      color: "#ff0000",
    });

    const red = coloured(canvas, isRed);
    // Square occupies device 80..119; a 30 element-space offset under scale(2)
    // is 60 device px.
    expect(red.minX).toBe(140);
    expect(red.maxX).toBe(179);
  });

  it("scales the blur with the transform", () => {
    // A blur fades out, so where its edge is judged to be depends on the
    // detection threshold. This one is deliberately sensitive: at `r > 80` the
    // measurable reach is only 2px at 1:1, too coarse to compare ratios.
    const faintRed = (r: number, g: number, b: number) =>
      r > 10 && g < 60 && b < 60;

    const at = (zoom: number) => {
      const { canvas, ctx } = scene(400, 400, "#000000");
      ctx.scale(zoom, zoom);
      paintShadowOnly(ctx, () => square(ctx), {
        offsetX: 0,
        offsetY: 0,
        blur: 10,
        color: "#ff0000",
      });
      // How far the blur reaches beyond the shape, in device px.
      return 40 * zoom - coloured(canvas, faintRed).minX;
    };

    const oneToOne = at(1);
    const doubled = at(2);

    expect(oneToOne).toBeGreaterThan(6);
    // Without the CTM correction `doubled` would equal `oneToOne` — the blur
    // would stay 10 device px however far the view is zoomed in.
    expect(doubled / oneToOne).toBeGreaterThan(1.7);
    expect(doubled / oneToOne).toBeLessThan(2.3);
  });

  it("rotates the offset with the transform", () => {
    // A 90° rotation should send a +x shadow offset to +y on screen.
    const { canvas, ctx } = scene(300, 300, "#000000");
    ctx.translate(150, 60);
    ctx.rotate(Math.PI / 2);

    paintShadowOnly(
      ctx,
      () => {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(-10, -10, 20, 20);
      },
      { offsetX: 40, offsetY: 0, blur: 0, color: "#ff0000" },
    );

    const red = coloured(canvas, isRed);
    // The shape sits at device (140..159, 50..69); the shadow moves +40 in y.
    expect(red.minY).toBeGreaterThan(80);
    expect(red.minX).toBeGreaterThan(130);
    expect(red.maxX).toBeLessThan(170);
  });

  it("restores the context state it touched", () => {
    const { ctx } = scene(200, 200, "#000000");
    ctx.shadowColor = "#0000ff";
    ctx.shadowBlur = 3;
    ctx.shadowOffsetX = 7;

    paintShadowOnly(ctx, () => square(ctx), {
      offsetX: 5,
      offsetY: 5,
      blur: 9,
      color: "#ff0000",
    });

    expect(ctx.shadowBlur).toBe(3);
    expect(ctx.shadowOffsetX).toBe(7);
    const m = ctx.getTransform();
    expect(m.e).toBe(0);
    expect(m.f).toBe(0);
  });

  it("draws nothing for a clip scaled to nothing", () => {
    // `push` divides by the scale, so a degenerate matrix must bail rather
    // than translate by Infinity.
    const { canvas, ctx } = scene(200, 200, "#000000");
    ctx.scale(0, 0);

    expect(() =>
      paintShadowOnly(ctx, () => square(ctx), {
        offsetX: 4,
        offsetY: 4,
        blur: 4,
        color: "#ff0000",
      }),
    ).not.toThrow();

    expect(inkBounds(canvas).count).toBe(0);
  });

  it("carries alpha through the shadow colour", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");

    paintShadowOnly(ctx, () => square(ctx), {
      offsetX: 0,
      offsetY: 0,
      blur: 0,
      color: "rgba(255, 0, 0, 0.5)",
    });

    const p = pixel(canvas, 50, 50);
    expect(p.r).toBeGreaterThan(100);
    expect(p.r).toBeLessThan(180);
  });
});

describe("matrixScale", () => {
  it("is 1 for the identity", () => {
    const { ctx } = scene(10, 10);
    expect(matrixScale(ctx.getTransform())).toBeCloseTo(1);
  });

  it("reads a uniform scale", () => {
    const { ctx } = scene(10, 10);
    ctx.scale(3, 3);
    expect(matrixScale(ctx.getTransform())).toBeCloseTo(3);
  });

  it("is unchanged by rotation", () => {
    const { ctx } = scene(10, 10);
    ctx.scale(2, 2);
    ctx.rotate(Math.PI / 3);
    expect(matrixScale(ctx.getTransform())).toBeCloseTo(2);
  });

  it("takes the geometric mean of a non-uniform scale", () => {
    const { ctx } = scene(10, 10);
    ctx.scale(2, 8);
    expect(matrixScale(ctx.getTransform())).toBeCloseTo(4);
  });
});
