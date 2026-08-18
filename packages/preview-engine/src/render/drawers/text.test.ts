import { describe, it, expect } from "vitest";
import { drawText } from "./text";
import { scene, pixel, noAssets, track } from "../../test/canvas";
import { TEXT_BACKGROUND_PADDING } from "../../text/layout";
import type { Canvas } from "@napi-rs/canvas";
import type { RenderElement } from "../../model/timeline.types";

/**
 * Text geometry depends on the host's font metrics, so these assert relative
 * placement (which half of the box the glyphs land in, whether a background
 * rect was painted) rather than exact pixel columns.
 */
function inkBounds(canvas: Canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // anything not pure black counts as ink
      if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 40) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY, count };
}

const base: RenderElement = {
  filetype: "text",
  startTime: 0,
  duration: 2000,
  location: { x: 0, y: 0 },
  width: 200,
  height: 60,
  opacity: 100,
  rotation: 0,
  text: "AB",
  textcolor: "#ffffff",
  fontsize: 40,
  fontname: "sans-serif",
  letterSpacing: 0,
  options: { align: "left", isBold: false, isItalic: false },
  animation: {},
};

const deps = { assets: noAssets };

describe("drawText", () => {
  it("paints glyphs inside the element box", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    expect(drawText(ctx, "t", base, 0, deps)).toBe(true);
    const ink = inkBounds(canvas);
    expect(ink.count).toBeGreaterThan(0);
    expect(ink.minY).toBeGreaterThanOrEqual(0);
    expect(ink.maxY).toBeLessThan(60);
  });

  it("places a left-aligned line against the left edge of the box", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    drawText(ctx, "t", base, 0, deps);
    const ink = inkBounds(canvas);
    expect(ink.minX).toBeLessThan(10);
  });

  it("places a right-aligned line against the right edge of the box", () => {
    const left = scene(200, 200, "#000000");
    drawText(left.ctx, "t", base, 0, deps);
    const leftInk = inkBounds(left.canvas);

    const right = scene(200, 200, "#000000");
    drawText(right.ctx, "t", { ...base, options: { ...base.options, align: "right" } }, 0, deps);
    const rightInk = inkBounds(right.canvas);

    // Lines keep their trailing space (the original's wrap did too), so the
    // glyphs stop just short of the box edge rather than touching it.
    expect(rightInk.minX).toBeGreaterThan(100);
    expect(rightInk.maxX).toBeGreaterThan(leftInk.maxX + 100);
    expect(200 - rightInk.maxX).toBeLessThan(30);
  });

  it("centers a center-aligned line in the box", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    drawText(ctx, "t", { ...base, options: { ...base.options, align: "center" } }, 0, deps);
    const ink = inkBounds(canvas);
    const mid = (ink.minX + ink.maxX) / 2;
    expect(Math.abs(mid - 100)).toBeLessThan(8);
  });

  it("wraps onto further lines and advances by the element height", () => {
    const single = scene(400, 400, "#000000");
    drawText(single.ctx, "t", { ...base, text: "AB" }, 0, deps);
    const oneLine = inkBounds(single.canvas);

    const wrapped = scene(400, 400, "#000000");
    drawText(
      wrapped.ctx,
      "t",
      { ...base, text: "AAAA BBBB CCCC DDDD EEEE FFFF" },
      0,
      deps,
    );
    const many = inkBounds(wrapped.canvas);

    expect(many.count).toBeGreaterThan(oneLine.count);
    // additional lines sit a full element height below the first
    expect(many.maxY).toBeGreaterThan(oneLine.maxY + 40);
  });

  it("draws a background rect behind the line when enabled", () => {
    // Offset the box so the left padding is on-canvas rather than clipped.
    const offset = { ...base, location: { x: 50, y: 0 } };

    const plain = scene(300, 200, "#000000");
    drawText(plain.ctx, "t", offset, 0, deps);
    const withoutBg = inkBounds(plain.canvas);

    const boxed = scene(300, 200, "#000000");
    drawText(
      boxed.ctx,
      "t",
      { ...offset, background: { enable: true, color: "#ff0000" } },
      0,
      deps,
    );
    const withBg = inkBounds(boxed.canvas);

    expect(withBg.count).toBeGreaterThan(withoutBg.count);
    // the rect starts one padding left of where the glyphs begin
    expect(withBg.minX).toBe(50 - TEXT_BACKGROUND_PADDING);
    expect(pixel(boxed.canvas, 45, 30)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("strokes an outline in its own colour when enabled", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    drawText(
      ctx,
      "t",
      {
        ...base,
        options: {
          ...base.options,
          outline: { enable: true, size: 6, color: "#ff0000" },
        },
      },
      0,
      deps,
    );
    const data = canvas.getContext("2d").getImageData(0, 0, 200, 200).data;
    let reddish = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 120 && data[i + 1] < 90 && data[i + 2] < 90) reddish++;
    }
    expect(reddish).toBeGreaterThan(0);
  });

  it("scales the font, not the box, when the scale track is active", () => {
    const normal = scene(400, 400, "#000000");
    drawText(normal.ctx, "t", base, 0, deps);
    const small = inkBounds(normal.canvas);

    const scaled = scene(400, 400, "#000000");
    drawText(
      scaled.ctx,
      "t",
      // 200 => raw/100 => 2x the authored font size
      { ...base, animation: { scale: { isActivate: true, ax: track([0, 200]) } } },
      0,
      deps,
    );
    const big = inkBounds(scaled.canvas);

    expect(big.count).toBeGreaterThan(small.count);
    // the box itself is unchanged — only the glyphs grew
    expect(big.minX).toBeLessThan(10);
  });

  it("reads the scale track as raw/100, unlike image and video which read raw/10", () => {
    // Every original renderer divided by 10 twice for text. A track value of 100
    // is therefore the identity for text, while 100 would be 10x for an image.
    const authored = scene(400, 400, "#000000");
    drawText(authored.ctx, "t", base, 0, deps);
    const unscaled = inkBounds(authored.canvas);

    const identity = scene(400, 400, "#000000");
    drawText(
      identity.ctx,
      "t",
      { ...base, animation: { scale: { isActivate: true, ax: track([0, 100]) } } },
      0,
      deps,
    );
    const atHundred = inkBounds(identity.canvas);

    expect(atHundred.count).toBe(unscaled.count);

    const tenth = scene(400, 400, "#000000");
    drawText(
      tenth.ctx,
      "t",
      { ...base, animation: { scale: { isActivate: true, ax: track([0, 10]) } } },
      0,
      deps,
    );
    expect(inkBounds(tenth.canvas).count).toBeLessThan(unscaled.count);
  });

  it("moves with the position track and stays put for ignored ids", () => {
    const el: RenderElement = {
      ...base,
      animation: {
        position: {
          isActivate: true,
          ax: track([0, 0], [1000, 120]),
          ay: track([0, 0], [1000, 120]),
        },
      },
    };

    const moved = scene(400, 400, "#000000");
    drawText(moved.ctx, "t", el, 1000, deps);
    const movedInk = inkBounds(moved.canvas);
    expect(movedInk.minX).toBeGreaterThan(100);

    const pinned = scene(400, 400, "#000000");
    drawText(pinned.ctx, "t", el, 1000, {
      ...deps,
      ignorePositionIds: new Set(["t"]),
    });
    const pinnedInk = inkBounds(pinned.canvas);
    expect(pinnedInk.minX).toBeLessThan(10);
  });

  it("aborts when a keyframed track is sampled before the element start", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    const el: RenderElement = {
      ...base,
      startTime: 5000,
      animation: { opacity: { isActivate: true, ax: track([0, 100]) } },
    };
    expect(drawText(ctx, "t", el, 0, deps)).toBe(false);
    expect(inkBounds(canvas).count).toBe(0);
  });

  it("resets globalAlpha so the next element starts clean", () => {
    const { ctx } = scene(200, 200, "#000000");
    drawText(ctx, "t", { ...base, opacity: 30 }, 0, deps);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("draws nothing but does not throw for empty text", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    expect(drawText(ctx, "t", { ...base, text: "" }, 0, deps)).toBe(true);
    expect(inkBounds(canvas).count).toBe(0);
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 0, g: 0, b: 0 });
  });
});
