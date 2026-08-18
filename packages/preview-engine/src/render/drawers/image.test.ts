import { describe, it, expect } from "vitest";
import { drawImage } from "./image";
import { scene, solid, pixel, noAssets, track } from "../../test/canvas";
import type { AssetResolver } from "../types";
import type { RenderElement } from "../../model/timeline.types";

const base: RenderElement = {
  filetype: "image",
  startTime: 0,
  duration: 2000,
  location: { x: 50, y: 50 },
  width: 100,
  height: 100,
  opacity: 100,
  rotation: 0,
  animation: {},
};

function red(): AssetResolver {
  return { ...noAssets, getImage: () => solid(100, 100, "#ff0000") as never };
}

describe("drawImage", () => {
  it("returns false when the asset has not loaded", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    expect(drawImage(ctx, "i", base, 0, { assets: noAssets })).toBe(false);
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("draws at the element's static box", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    expect(drawImage(ctx, "i", base, 0, { assets: red() })).toBe(true);
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 20, 20)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("grows about the box center when the scale track is active", () => {
    // scale track values are tenths: 20 => 2x
    const el: RenderElement = {
      ...base,
      animation: { scale: { isActivate: true, ax: track([0, 20]) } },
    };
    const { canvas, ctx } = scene(200, 200, "#000000");
    drawImage(ctx, "i", el, 0, { assets: red() });
    // center unchanged, but the box now spans 0..200 instead of 50..150
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 10, 10)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("moves the box when the position track is active", () => {
    const el: RenderElement = {
      ...base,
      animation: {
        position: {
          isActivate: true,
          ax: track([0, 0], [1000, 100]),
          ay: track([0, 0], [1000, 100]),
        },
      },
    };
    const { canvas, ctx } = scene(200, 200, "#000000");
    drawImage(ctx, "i", el, 1000, { assets: red() });
    // sampled to (100,100) => box spans ~100..200
    expect(pixel(canvas, 150, 150)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 60, 60)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("ignores the position track for ids the caller is dragging", () => {
    const el: RenderElement = {
      ...base,
      animation: {
        position: {
          isActivate: true,
          ax: track([0, 0], [1000, 100]),
          ay: track([0, 0], [1000, 100]),
        },
      },
    };
    const { canvas, ctx } = scene(200, 200, "#000000");
    drawImage(ctx, "i", el, 1000, {
      assets: red(),
      ignorePositionIds: new Set(["i"]),
    });
    // stays at its static location instead of following the keyframes
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 190, 190)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("aborts when a keyframed track is sampled before the element start", () => {
    const el: RenderElement = {
      ...base,
      startTime: 5000,
      animation: { opacity: { isActivate: true, ax: track([0, 100]) } },
    };
    const { canvas, ctx } = scene(200, 200, "#000000");
    expect(drawImage(ctx, "i", el, 0, { assets: red() })).toBe(false);
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("composes scale, rotation and position in one pass", () => {
    // The preview's video path used to drop rotation whenever position was
    // active; image never did, and both now share this ordering.
    const el: RenderElement = {
      ...base,
      width: 100,
      height: 20,
      animation: {
        rotation: { isActivate: true, ax: track([0, 90]) },
        position: {
          isActivate: true,
          ax: track([0, 50]),
          ay: track([0, 90]),
        },
      },
    };
    const { canvas, ctx } = scene(200, 200, "#000000");
    drawImage(ctx, "i", el, 0, {
      assets: { ...noAssets, getImage: () => solid(100, 20, "#ff0000") as never },
    });
    // box moved to ~(50,90) size 100x20, center ~(100,100), rotated 90deg
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 100, 60)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 55, 100)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("resets globalAlpha so the next element starts clean", () => {
    const { ctx } = scene(200, 200, "#000000");
    drawImage(ctx, "i", { ...base, opacity: 20 }, 0, { assets: red() });
    expect(ctx.globalAlpha).toBe(1);
  });
});
