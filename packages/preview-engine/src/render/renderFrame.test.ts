import { describe, it, expect } from "vitest";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { renderFrame } from "./renderFrame";
import type { AssetResolver } from "./types";
import type { RenderTimeline } from "../model/timeline.types";

/** Build a solid-color source canvas usable as a drawImage source. */
function solid(w: number, h: number, color: string): Canvas {
  const c = createCanvas(w, h);
  const cx = c.getContext("2d");
  cx.fillStyle = color;
  cx.fillRect(0, 0, w, h);
  return c;
}

function pixel(canvas: Canvas, x: number, y: number) {
  const d = canvas.getContext("2d").getImageData(x, y, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] };
}

describe("renderFrame (headless canvas)", () => {
  it("fills the background and composites nothing when timeline empty", () => {
    const canvas = createCanvas(100, 100);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    const res = renderFrame(
      ctx,
      {},
      { width: 100, height: 100, backgroundColor: "#0000ff" },
      0,
      { assets: {} as AssetResolver },
    );
    expect(res.drawn).toEqual([]);
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 0, g: 0, b: 255 });
  });

  it("draws a visible image at its location, honouring z-order and visibility", () => {
    const canvas = createCanvas(200, 200);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;

    const red = solid(50, 50, "#ff0000");
    const green = solid(200, 200, "#00ff00");

    const timeline: RenderTimeline = {
      // background layer (lower priority) fills everything green
      bg: {
        filetype: "image",
        priority: 1,
        startTime: 0,
        duration: 1000,
        location: { x: 0, y: 0 },
        width: 200,
        height: 200,
        opacity: 100,
        rotation: 0,
        animation: {},
      },
      // red box on top at (75,75)-(125,125)
      box: {
        filetype: "image",
        priority: 2,
        startTime: 0,
        duration: 1000,
        location: { x: 75, y: 75 },
        width: 50,
        height: 50,
        opacity: 100,
        rotation: 0,
        animation: {},
      },
      // invisible at t=500 (starts later)
      later: {
        filetype: "image",
        priority: 3,
        startTime: 800,
        duration: 1000,
        location: { x: 0, y: 0 },
        width: 200,
        height: 200,
        opacity: 100,
        rotation: 0,
        animation: {},
      },
    };

    const assets: AssetResolver = {
      getImage: (id) => (id === "box" ? (red as never) : (green as never)),
      getGifFrame: () => null,
      getVideo: () => null,
    };

    const res = renderFrame(
      ctx,
      timeline,
      { width: 200, height: 200 },
      500,
      { assets },
    );

    // z-order: bg then box; "later" filtered out by visibility
    expect(res.drawn).toEqual(["bg", "box"]);
    // center is red (box on top)
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 255, g: 0, b: 0 });
    // corner is green (background shows through)
    expect(pixel(canvas, 10, 10)).toMatchObject({ r: 0, g: 255, b: 0 });
  });

  it("applies opacity when compositing", () => {
    const canvas = createCanvas(100, 100);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    const white = solid(100, 100, "#ffffff");
    const timeline: RenderTimeline = {
      a: {
        filetype: "image",
        priority: 1,
        startTime: 0,
        duration: 1000,
        location: { x: 0, y: 0 },
        width: 100,
        height: 100,
        opacity: 50,
        rotation: 0,
        animation: {},
      },
    };
    const assets: AssetResolver = {
      getImage: () => white as never,
      getGifFrame: () => null,
      getVideo: () => null,
    };
    renderFrame(ctx, timeline, { width: 100, height: 100, backgroundColor: "#000000" }, 0, {
      assets,
    });
    // 50% white over black ~ mid grey
    const p = pixel(canvas, 50, 50);
    expect(p.r).toBeGreaterThan(100);
    expect(p.r).toBeLessThan(160);
  });

  it("draws a filled shape polygon", () => {
    const canvas = createCanvas(100, 100);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    const timeline: RenderTimeline = {
      s: {
        filetype: "shape",
        priority: 1,
        startTime: 0,
        duration: 1000,
        location: { x: 0, y: 0 },
        width: 100,
        height: 100,
        oWidth: 100,
        opacity: 100,
        rotation: 0,
        option: { fillColor: "#ff0000" },
        // a big triangle covering the center
        shape: [
          [10, 10],
          [90, 10],
          [50, 90],
        ],
      },
    };
    const res = renderFrame(
      ctx,
      timeline,
      { width: 100, height: 100, backgroundColor: "#000000" },
      0,
      { assets: {} as AssetResolver },
    );
    expect(res.drawn).toEqual(["s"]);
    // center of the triangle is red
    expect(pixel(canvas, 50, 40)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("leaves audio elements out of the frame entirely", () => {
    const timeline: RenderTimeline = {
      track: {
        filetype: "audio",
        priority: 1,
        startTime: 0,
        duration: 1000,
        speed: 1,
      },
    };
    const { ctx } = makeScene();
    const res = renderFrame(ctx, timeline, { width: 100, height: 100 }, 0, {
      assets: {} as AssetResolver,
    });
    expect(res.drawn).toEqual([]);
  });

  it("skips ids the caller asked to leave out", () => {
    const timeline = twoImages();
    const white = solid(100, 100, "#ffffff");
    const assets: AssetResolver = {
      getImage: () => white as never,
      getGifFrame: () => null,
      getVideo: () => null,
    };
    const { ctx } = makeScene();
    const res = renderFrame(
      ctx,
      timeline,
      { width: 100, height: 100 },
      0,
      { assets },
      { skipIds: new Set(["b"]) },
    );
    expect(res.drawn).toEqual(["a"]);
  });

  it("keeps compositing the rest of the frame when one element cannot draw", () => {
    // A drawer returning false (asset still loading, or a track sampled before
    // the element start) must never stop the frame. The offscreen renderer's
    // inlined version returned out of its own recursion here and stalled.
    const timeline = twoImages();
    timeline.a.startTime = 5000;
    timeline.a.animation = { opacity: { isActivate: true, ax: [[0, 100]] } };

    const white = solid(100, 100, "#ffffff");
    const assets: AssetResolver = {
      getImage: (id) => (id === "b" ? (white as never) : null),
      getGifFrame: () => null,
      getVideo: () => null,
    };
    const { ctx } = makeScene();
    const res = renderFrame(ctx, timeline, { width: 100, height: 100 }, 0, {
      assets,
    });
    expect(res.drawn).toEqual(["b"]);
  });

  it("does not let one element's transform leak into the next", () => {
    // Each element is drawn inside save()/restore(), so a rotated element
    // cannot shift the one drawn after it.
    const timeline: RenderTimeline = {
      spun: {
        filetype: "image",
        priority: 1,
        startTime: 0,
        duration: 1000,
        location: { x: 0, y: 0 },
        width: 40,
        height: 40,
        opacity: 100,
        rotation: 33,
        animation: {},
      },
      plain: {
        filetype: "image",
        priority: 2,
        startTime: 0,
        duration: 1000,
        location: { x: 100, y: 100 },
        width: 100,
        height: 100,
        opacity: 100,
        rotation: 0,
        animation: {},
      },
    };
    const canvas = createCanvas(200, 200);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    const assets: AssetResolver = {
      getImage: (id) =>
        (id === "plain"
          ? solid(100, 100, "#00ff00")
          : solid(40, 40, "#ff0000")) as never,
      getGifFrame: () => null,
      getVideo: () => null,
    };
    renderFrame(
      ctx,
      timeline,
      { width: 200, height: 200, backgroundColor: "#000000" },
      0,
      { assets },
    );
    // "plain" lands square on (100,100)-(200,200) despite the rotated element
    expect(pixel(canvas, 150, 150)).toMatchObject({ r: 0, g: 255, b: 0 });
    expect(pixel(canvas, 150, 90)).toMatchObject({ r: 0, g: 0, b: 0 });
  });
});

/** A 100x100 black scene. */
function makeScene() {
  const canvas = createCanvas(100, 100);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  return { canvas, ctx };
}

/** Two full-bleed images, `a` under `b`. */
function twoImages(): RenderTimeline {
  const el = (priority: number) => ({
    filetype: "image",
    priority,
    startTime: 0,
    duration: 1000,
    location: { x: 0, y: 0 },
    width: 100,
    height: 100,
    opacity: 100,
    rotation: 0,
    animation: {},
  });
  return { a: el(1), b: el(2) };
}
