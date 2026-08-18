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
