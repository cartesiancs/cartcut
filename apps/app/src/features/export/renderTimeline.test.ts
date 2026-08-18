import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import type { Timeline, VisualTimelineElement } from "../../@types/timeline";
import type { RenderOptions } from "../../states/renderOptionStore";
import type { ILoadedAssetStore } from "../asset/loadedAssetStore";
import type { TimelineRenderers } from "../renderer/timeline";
import { imageElement, shapeElement, audioElement } from "../renderer/testing";

/**
 * The export canvas is created through `document`, and encoded through
 * `toBlob`, neither of which exists in Node. The stub hands back a real Skia
 * canvas with a `toBlob` shim so the loop can be exercised end to end and the
 * composited pixels inspected.
 */
const createdCanvases: Canvas[] = [];

vi.stubGlobal("document", {
  createElement: (tag: string) => {
    if (tag !== "canvas") throw new Error(`unexpected createElement(${tag})`);
    const canvas = createCanvas(1, 1) as Canvas & {
      toBlob: (cb: (blob: unknown) => void, type?: string) => void;
    };
    canvas.toBlob = (cb) => {
      const buffer = canvas.toBuffer("image/png");
      cb({ arrayBuffer: async () => buffer.buffer });
    };
    createdCanvases.push(canvas);
    return canvas;
  },
});

const { renderTimeline } = await import("./renderTimeline");

const options: RenderOptions = {
  previewSize: { w: 40, h: 40 },
  fps: 10,
  duration: 2,
  backgroundColor: "#101020",
};

/** Renderers that fill the element's local box. */
const renderers = {
  image: (ctx: CanvasRenderingContext2D, _id: string, el: VisualTimelineElement) => {
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, el.width, el.height);
  },
  video: () => {},
  gif: () => {},
  text: () => {},
  shape: (ctx: CanvasRenderingContext2D, _id: string, el: VisualTimelineElement) => {
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(0, 0, el.width, el.height);
  },
} as unknown as TimelineRenderers;

function makeStore(calls: string[] = []) {
  return {
    loadEntireTimeline: vi.fn(async () => {
      calls.push("load");
    }),
    seek: vi.fn(async (_timeline: Timeline, time: number) => {
      calls.push(`seek:${time}`);
    }),
  } as unknown as ILoadedAssetStore;
}

beforeEach(() => {
  createdCanvases.length = 0;
});

describe("renderTimeline", () => {
  it("emits duration * fps frames, numbered from zero", async () => {
    const frames: Array<[number, number]> = [];
    await renderTimeline(
      makeStore(),
      {},
      renderers,
      options,
      (_buf, i, total) => {
        frames.push([i, total]);
      },
    );

    expect(frames).toHaveLength(20);
    expect(frames[0]).toEqual([0, 20]);
    expect(frames[19]).toEqual([19, 20]);
  });

  it("loads every asset once, before the first frame", async () => {
    const calls: string[] = [];
    const store = makeStore(calls);

    await renderTimeline(store, {}, renderers, options, () => {});

    expect(store.loadEntireTimeline).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBe("load");
    expect(calls.filter((c) => c === "load")).toHaveLength(1);
  });

  it("seeks to each timecode before compositing it", async () => {
    const calls: string[] = [];
    const store = makeStore(calls);

    await renderTimeline(
      store,
      {},
      renderers,
      { ...options, fps: 4, duration: 1 },
      () => calls.push("frame"),
    );

    expect(calls).toEqual([
      "load",
      "seek:0",
      "frame",
      "seek:250",
      "frame",
      "seek:500",
      "frame",
      "seek:750",
      "frame",
    ]);
  });

  it("maps frame index to timecode by fps", async () => {
    const seeks: number[] = [];
    const store = {
      loadEntireTimeline: vi.fn(async () => {}),
      seek: vi.fn(async (_t: Timeline, time: number) => {
        seeks.push(time);
      }),
    } as unknown as ILoadedAssetStore;

    await renderTimeline(
      store,
      {},
      renderers,
      { ...options, fps: 25, duration: 1 },
      () => {},
    );

    expect(seeks).toHaveLength(25);
    expect(seeks[1]).toBe(40);
    expect(seeks[24]).toBe(960);
  });

  it("hands back an encoded buffer for every frame", async () => {
    const buffers: ArrayBuffer[] = [];
    await renderTimeline(
      makeStore(),
      {},
      renderers,
      { ...options, fps: 2, duration: 1 },
      (buf) => buffers.push(buf),
    );

    expect(buffers).toHaveLength(2);
    for (const buf of buffers) {
      expect(buf.byteLength).toBeGreaterThan(0);
    }
  });

  it("composites the timeline onto a canvas at the requested size", async () => {
    const timeline: Timeline = {
      pic: imageElement({
        priority: 1,
        location: { x: 0, y: 0 },
        width: 40,
        height: 40,
        startTime: 0,
        duration: 4000,
      }),
    };

    await renderTimeline(makeStore(), timeline, renderers, options, () => {});

    const canvas = createdCanvases.at(-1)!;
    expect(canvas.width).toBe(40);
    expect(canvas.height).toBe(40);
    const d = canvas.getContext("2d").getImageData(20, 20, 1, 1).data;
    expect([d[0], d[1], d[2]]).toEqual([255, 0, 0]);
  });

  it("advances the timeline, so elements come and go across frames", async () => {
    const timeline: Timeline = {
      early: imageElement({
        priority: 1,
        location: { x: 0, y: 0 },
        width: 40,
        height: 40,
        startTime: 0,
        duration: 500,
      }),
      late: shapeElement({
        priority: 2,
        location: { x: 0, y: 0 },
        width: 40,
        height: 40,
        startTime: 500,
        duration: 500,
        shape: [
          [0, 0],
          [40, 0],
          [40, 40],
          [0, 40],
        ],
      }),
    };

    const sampled: Array<[number, number, number]> = [];
    await renderTimeline(
      makeStore(),
      timeline,
      renderers,
      { ...options, fps: 2, duration: 1 },
      () => {
        const canvas = createdCanvases.at(-1)!;
        const d = canvas.getContext("2d").getImageData(20, 20, 1, 1).data;
        sampled.push([d[0], d[1], d[2]]);
      },
    );

    expect(sampled[0]).toEqual([255, 0, 0]);
    expect(sampled[1]).toEqual([0, 255, 0]);
  });

  it("emits nothing for a zero-length project", async () => {
    const frames: number[] = [];
    await renderTimeline(
      makeStore(),
      {},
      renderers,
      { ...options, duration: 0 },
      (_b, i) => frames.push(i),
    );
    expect(frames).toEqual([]);
  });

  it("keeps audio out of the composited frame", async () => {
    const timeline: Timeline = {
      music: audioElement({ priority: 1, startTime: 0, duration: 4000 }),
    };

    await renderTimeline(
      makeStore(),
      timeline,
      renderers,
      { ...options, fps: 1, duration: 1 },
      () => {},
    );

    const canvas = createdCanvases.at(-1)!;
    const d = canvas.getContext("2d").getImageData(20, 20, 1, 1).data;
    expect([d[0], d[1], d[2]]).toEqual([0x10, 0x10, 0x20]);
  });

  it("rejects when the canvas context cannot be obtained", async () => {
    const broken = {
      createElement: () => ({ getContext: () => null }),
    };
    vi.stubGlobal("document", broken);

    await expect(
      renderTimeline(makeStore(), {}, renderers, options, () => {}),
    ).rejects.toThrow(/canvas context/i);
  });
});
