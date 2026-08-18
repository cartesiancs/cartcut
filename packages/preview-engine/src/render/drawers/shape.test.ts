import { describe, it, expect } from "vitest";
import { drawShape } from "./shape";
import { scene, pixel, track } from "../../test/canvas";
import type { RenderElement } from "../../model/timeline.types";

/** A red square covering (10,10)-(90,90) of a 100x100 element box. */
const square: RenderElement = {
  filetype: "shape",
  startTime: 0,
  duration: 2000,
  location: { x: 0, y: 0 },
  width: 100,
  height: 100,
  oWidth: 100,
  opacity: 100,
  rotation: 0,
  option: { fillColor: "#ff0000" },
  shape: [
    [10, 10],
    [90, 10],
    [90, 90],
    [10, 90],
  ],
};

describe("drawShape", () => {
  it("fills the polygon with fillColor", () => {
    const { canvas, ctx } = scene(100, 100, "#000000");
    expect(drawShape(ctx, "s", square, 0)).toBe(true);
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 2, 2)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("returns false for an element with no points", () => {
    const { canvas, ctx } = scene(100, 100, "#000000");
    expect(drawShape(ctx, "s", { ...square, shape: [] }, 0)).toBe(false);
    expect(drawShape(ctx, "s", { ...square, shape: undefined }, 0)).toBe(false);
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("applies the static opacity", () => {
    const { canvas, ctx } = scene(100, 100, "#000000");
    drawShape(ctx, "s", { ...square, opacity: 50 }, 0);
    const p = pixel(canvas, 50, 50);
    expect(p.r).toBeGreaterThan(100);
    expect(p.r).toBeLessThan(160);
  });

  it("applies the opacity keyframe track, which the export path ignored", () => {
    const animated: RenderElement = {
      ...square,
      opacity: 100,
      animation: {
        opacity: { isActivate: true, ax: track([0, 100], [1000, 20]) },
      },
    };

    const early = scene(100, 100, "#000000");
    drawShape(early.ctx, "s", animated, 0);
    expect(pixel(early.canvas, 50, 50).r).toBeGreaterThan(240);

    const late = scene(100, 100, "#000000");
    drawShape(late.ctx, "s", animated, 1000);
    const p = pixel(late.canvas, 50, 50);
    // 20% red over black
    expect(p.r).toBeGreaterThan(30);
    expect(p.r).toBeLessThan(80);
  });

  it("aborts the draw when the opacity track is sampled before the element start", () => {
    const { canvas, ctx } = scene(100, 100, "#000000");
    const animated: RenderElement = {
      ...square,
      startTime: 5000,
      animation: {
        opacity: { isActivate: true, ax: track([0, 100]) },
      },
    };
    expect(drawShape(ctx, "s", animated, 0)).toBe(false);
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("scales authoring-space points back by oWidth/width", () => {
    // Same points authored at 200px wide, rendered into a 100px box: the shape
    // halves, so (10,10)-(90,90) becomes (5,5)-(45,45).
    const { canvas, ctx } = scene(100, 100, "#000000");
    drawShape(ctx, "s", { ...square, oWidth: 200 }, 0);
    expect(pixel(canvas, 25, 25)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 70, 70)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("resets globalAlpha so the next element starts clean", () => {
    const { ctx } = scene(100, 100, "#000000");
    drawShape(ctx, "s", { ...square, opacity: 30 }, 0);
    expect(ctx.globalAlpha).toBe(1);
  });
});
