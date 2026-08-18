import { describe, it, expect, vi, beforeEach } from "vitest";
import { scene, solid, pixel, noAssets, track } from "../../test/canvas";
import type { AssetResolver } from "../types";
import type { RenderElement } from "../../model/timeline.types";

/**
 * glFilter needs a real WebGL context, so it is stubbed here. These tests are
 * about how the drawer *drives* the filters (which ones, in what order, with
 * what `isChangeFilter`) and about the box transform — the shader itself is
 * browser-only and out of scope for the node suite.
 */
const calls: Array<{ name: string; isChangeFilter: boolean | undefined }> = [];
const filterOutput: Record<string, unknown> = {};

vi.mock("../../filters/glFilter", () => {
  const make = (name: string) => (
    _ctx: unknown,
    _video: unknown,
    _el: unknown,
    _w: number,
    _h: number,
    _x: number,
    _y: number,
    _sw: number,
    _sh: number,
    isChangeFilter?: boolean,
  ) => {
    calls.push({ name, isChangeFilter });
    return filterOutput[name];
  };
  return {
    glFilter: {
      applyChromaKey: make("chromakey"),
      applyBlur: make("blur"),
      applyRadialBlur: make("radialblur"),
    },
  };
});

const { drawVideo } = await import("./video");

const base: RenderElement = {
  filetype: "video",
  startTime: 0,
  duration: 2000,
  speed: 1,
  trim: { startTime: 0, endTime: 2000 },
  location: { x: 50, y: 50 },
  width: 100,
  height: 100,
  opacity: 100,
  rotation: 0,
  animation: {},
};

function videoAssets(source = solid(100, 100, "#ff0000")): AssetResolver {
  return { ...noAssets, getVideo: () => ({ object: source as never }) };
}

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(filterOutput)) delete filterOutput[k];
});

describe("drawVideo", () => {
  it("returns false when the video handle is not available", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    expect(drawVideo(ctx, "v", base, 0, { assets: noAssets })).toBe(false);
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("draws the resolved frame at the element's box", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    expect(drawVideo(ctx, "v", base, 0, { assets: videoAssets() })).toBe(true);
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 20, 20)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("applies the position keyframe track", () => {
    // The export renderers sampled the animated coordinates into `nx`/`ny` and
    // then composited from the un-animated ones, so video position animation
    // silently disappeared from exports.
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
    drawVideo(ctx, "v", el, 1000, { assets: videoAssets() });
    expect(pixel(canvas, 150, 150)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 60, 60)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("keeps rotation when the position track is also active", () => {
    const el: RenderElement = {
      ...base,
      width: 100,
      height: 20,
      animation: {
        rotation: { isActivate: true, ax: track([0, 90]) },
        position: { isActivate: true, ax: track([0, 50]), ay: track([0, 90]) },
      },
    };
    const { canvas, ctx } = scene(200, 200, "#000000");
    drawVideo(ctx, "v", el, 0, {
      assets: videoAssets(solid(100, 20, "#ff0000")),
    });
    expect(pixel(canvas, 100, 60)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 55, 100)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("runs no filters when the filter set is disabled or empty", () => {
    const { ctx } = scene(200, 200, "#000000");
    drawVideo(ctx, "v", { ...base, filter: { enable: false, list: [{ name: "blur", value: "f=4" }] } }, 0, {
      assets: videoAssets(),
    });
    drawVideo(ctx, "v", { ...base, filter: { enable: true, list: [] } }, 0, {
      assets: videoAssets(),
    });
    expect(calls).toEqual([]);
  });

  it("applies every filter in the list, in order", () => {
    // The export copies only ever applied `list[0]`, so a stacked chromakey +
    // blur lost the blur.
    const el: RenderElement = {
      ...base,
      filter: {
        enable: true,
        list: [
          { name: "chromakey", value: "r=0:g=255:b=0:f=0.4" },
          { name: "blur", value: "f=4" },
          { name: "radialblur", value: "f=8" },
        ],
      },
    };
    const { ctx } = scene(200, 200, "#000000");
    drawVideo(ctx, "v", el, 0, { assets: videoAssets() });
    expect(calls.map((c) => c.name)).toEqual([
      "chromakey",
      "blur",
      "radialblur",
    ]);
  });

  it("forwards isChangeFilter so the shader can re-initialise after an edit", () => {
    const el: RenderElement = {
      ...base,
      filter: { enable: true, list: [{ name: "blur", value: "f=4" }] },
    };
    const { ctx } = scene(200, 200, "#000000");
    drawVideo(ctx, "v", el, 0, { assets: videoAssets(), isChangeFilter: true });
    expect(calls[0].isChangeFilter).toBe(true);
  });

  it("composites the filtered output rather than the raw frame", () => {
    filterOutput.blur = solid(100, 100, "#0000ff");
    const el: RenderElement = {
      ...base,
      filter: { enable: true, list: [{ name: "blur", value: "f=4" }] },
    };
    const { canvas, ctx } = scene(200, 200, "#000000");
    drawVideo(ctx, "v", el, 0, { assets: videoAssets() });
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 0, g: 0, b: 255 });
  });

  it("keeps the last good source when a filter fails to initialise", () => {
    // A shader that fails to link returns undefined; the frame should still be
    // drawn unfiltered rather than vanishing.
    const el: RenderElement = {
      ...base,
      filter: { enable: true, list: [{ name: "chromakey", value: "r=0:g=255:b=0" }] },
    };
    const { canvas, ctx } = scene(200, 200, "#000000");
    expect(drawVideo(ctx, "v", el, 0, { assets: videoAssets() })).toBe(true);
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("aborts when a keyframed track is sampled before the element start", () => {
    const el: RenderElement = {
      ...base,
      startTime: 5000,
      animation: { opacity: { isActivate: true, ax: track([0, 100]) } },
    };
    const { canvas, ctx } = scene(200, 200, "#000000");
    expect(drawVideo(ctx, "v", el, 0, { assets: videoAssets() })).toBe(false);
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 0, g: 0, b: 0 });
  });
});
