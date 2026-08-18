import { describe, it, expect } from "vitest";
import { drawGif } from "./gif";
import { drawImage } from "./image";
import { scene, solid, pixel, noAssets } from "../../test/canvas";
import type { AssetResolver } from "../types";
import type { RenderElement } from "../../model/timeline.types";

const gifEl: RenderElement = {
  filetype: "gif",
  startTime: 0,
  duration: 1000,
  location: { x: 0, y: 0 },
  width: 100,
  height: 100,
  opacity: 100,
  rotation: 0,
};

function resolver(frame: unknown): AssetResolver {
  return { ...noAssets, getGifFrame: () => frame as never };
}

describe("drawGif", () => {
  it("returns false and draws nothing when the frame is not decoded yet", () => {
    const { canvas, ctx } = scene(100, 100, "#000000");
    expect(drawGif(ctx, "g", gifEl, 0, { assets: noAssets })).toBe(false);
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("composites the resolved frame at the element's box", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    const el = { ...gifEl, location: { x: 50, y: 50 } };
    drawGif(ctx, "g", el, 0, { assets: resolver(solid(100, 100, "#ff0000")) });
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 10, 10)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("applies the element's static opacity", () => {
    const { canvas, ctx } = scene(100, 100, "#000000");
    drawGif(ctx, "g", { ...gifEl, opacity: 50 }, 0, {
      assets: resolver(solid(100, 100, "#ffffff")),
    });
    const p = pixel(canvas, 50, 50);
    expect(p.r).toBeGreaterThan(100);
    expect(p.r).toBeLessThan(160);
  });

  it("does not inherit globalAlpha left over from a previously drawn element", () => {
    // The export renderers skipped setting globalAlpha for gifs, so a gif drawn
    // after a semi-transparent element silently picked up that element's alpha.
    const { canvas, ctx } = scene(100, 100, "#000000");

    const faint: RenderElement = {
      filetype: "image",
      startTime: 0,
      duration: 1000,
      location: { x: 0, y: 0 },
      width: 100,
      height: 100,
      opacity: 10,
      rotation: 0,
      animation: {},
    };
    ctx.globalAlpha = 0.1; // as the leaky path would have left it
    drawImage(ctx, "i", faint, 0, {
      assets: { ...noAssets, getImage: () => solid(100, 100, "#0000ff") as never },
    });

    drawGif(ctx, "g", gifEl, 0, {
      assets: resolver(solid(100, 100, "#ff0000")),
    });

    // fully opaque red, not a 10%-alpha wash
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("resets globalAlpha so the next element starts clean", () => {
    const { ctx } = scene(100, 100, "#000000");
    drawGif(ctx, "g", { ...gifEl, opacity: 25 }, 0, {
      assets: resolver(solid(100, 100, "#ffffff")),
    });
    expect(ctx.globalAlpha).toBe(1);
  });

  it("rotates about the element's center", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    // A wide, short bar rotated 90deg becomes tall and narrow.
    const bar: RenderElement = {
      ...gifEl,
      location: { x: 50, y: 90 },
      width: 100,
      height: 20,
      rotation: 90,
    };
    drawGif(ctx, "g", bar, 0, {
      assets: resolver(solid(100, 20, "#00ff00")),
    });
    // center of the box stays covered
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 0, g: 255, b: 0 });
    // rotated: now covers vertically above/below the center...
    expect(pixel(canvas, 100, 60)).toMatchObject({ r: 0, g: 255, b: 0 });
    // ...and no longer covers the horizontal extremes of the unrotated bar
    expect(pixel(canvas, 55, 100)).toMatchObject({ r: 0, g: 0, b: 0 });
  });
});
