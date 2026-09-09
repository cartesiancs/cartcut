import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import type { Timeline, VisualTimelineElement } from "../../@types/timeline";
import type { RenderOptions } from "../../states/renderOptionStore";
import type { ILoadedAssetStore } from "../asset/loadedAssetStore";
import type { VideoScope } from "../asset/videoScope";
import type { TimelineRenderers } from "../renderer/timeline";
import { imageElement, shapeElement, audioElement } from "../renderer/testing";
import { DEFAULT_EXPORT_SETTINGS } from "./settings";

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
  exportSettings: DEFAULT_EXPORT_SETTINGS,
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
    loadExportScope: vi.fn(async () => {
      calls.push("load");
    }),
    seekScope: vi.fn(
      async (_scope: VideoScope, _timeline: Timeline, time: number) => {
        calls.push(`seek:${time}`);
      },
    ),
    releaseVideoScope: vi.fn(() => {
      calls.push("release");
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

    expect(store.loadExportScope).toHaveBeenCalledTimes(1);
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
      // Last, and only once: the scope outlives every frame and is dropped in
      // the `finally`.
      "release",
    ]);
  });

  it("maps frame index to timecode by fps", async () => {
    const seeks: number[] = [];
    const store = {
      loadExportScope: vi.fn(async () => {}),
      seekScope: vi.fn(async (_s: VideoScope, _t: Timeline, time: number) => {
        seeks.push(time);
      }),
      releaseVideoScope: vi.fn(),
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

  it("hands back one raw RGBA buffer per frame, at the exact stride", async () => {
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
      // The pipe is `-f rawvideo -pix_fmt rgba`, which is unframed: a frame
      // that is off by even one byte shears every frame after it.
      expect(buf.byteLength).toBe(options.previewSize.w * options.previewSize.h * 4);
    }
  });

  /**
   * These replace an earlier pair that pinned a window of exactly one — the
   * loop awaited every callback before rendering the next frame. Measured at
   * 1080p that strict alternation cost ~38 ms per frame against ~25 ms with
   * two or more outstanding, because the renderer and FFmpeg each idled while
   * the other worked. The contract is now a bounded window, not a lockstep.
   */
  describe("in-flight window", () => {
    /**
     * Frame callbacks that resolve only when told to.
     *
     * `openAll` also has to make *future* callbacks resolve immediately:
     * releasing only the promises outstanding at that moment lets the loop
     * start the next frames, which would then block forever on gates nobody
     * is left to open.
     */
    function gated() {
      const started: number[] = [];
      const pending: Array<() => void> = [];
      let open = false;

      const callback = (_buf: ArrayBuffer, i: number) => {
        started.push(i);
        if (open) return Promise.resolve();
        return new Promise<void>((resolve) => pending.push(resolve));
      };
      const releaseOne = () => pending.shift()?.();
      const openAll = () => {
        open = true;
        while (pending.length > 0) pending.shift()!();
      };
      return { started, callback, releaseOne, openAll };
    }

    it("runs ahead up to the window without waiting", async () => {
      const { started, callback, openAll } = gated();
      // 40x40 frames, so the window is the maximum of 4.
      const done = renderTimeline(
        makeStore(),
        {},
        renderers,
        { ...options, fps: 8, duration: 1 },
        callback,
      );

      await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
      // Held there: the window is full and nothing has been acknowledged.
      await new Promise((r) => setTimeout(r, 20));
      expect(started).toEqual([0, 1, 2, 3]);

      openAll();
      await done;
      expect(started).toHaveLength(8);
    });

    it("admits exactly one more frame per acknowledgement", async () => {
      const { started, callback, releaseOne, openAll } = gated();
      const done = renderTimeline(
        makeStore(),
        {},
        renderers,
        { ...options, fps: 8, duration: 1 },
        callback,
      );

      await vi.waitFor(() => expect(started).toHaveLength(4));
      releaseOne();
      await vi.waitFor(() => expect(started).toHaveLength(5));
      await new Promise((r) => setTimeout(r, 20));
      expect(started).toHaveLength(5);

      openAll();
      await done;
    });

    it("hands frames over in order", async () => {
      const seen: number[] = [];
      await renderTimeline(
        makeStore(),
        {},
        renderers,
        { ...options, fps: 10, duration: 2 },
        async (_buf, i) => {
          seen.push(i);
          // Resolve out of order on purpose: a later frame acknowledged first
          // must still not change the order they were handed over in.
          await new Promise((r) => setTimeout(r, i % 3));
        },
      );

      expect(seen).toEqual([...Array(20).keys()]);
    });

    it("does not resolve until every outstanding frame has landed", async () => {
      // The caller closes FFmpeg's stdin the moment this resolves, so an
      // unacknowledged frame here would be a truncated file.
      let settled = 0;
      await renderTimeline(
        makeStore(),
        {},
        renderers,
        { ...options, fps: 8, duration: 1 },
        async () => {
          await new Promise((r) => setTimeout(r, 5));
          settled += 1;
        },
      );

      expect(settled).toBe(8);
    });

    it("surfaces a rejection from a frame that was already in flight", async () => {
      await expect(
        renderTimeline(
          makeStore(),
          {},
          renderers,
          { ...options, fps: 8, duration: 1 },
          async (_buf, i) => {
            if (i === 1) throw new Error("pipe died");
          },
        ),
      ).rejects.toThrow("pipe died");
    });
  });

  it("stops on an aborted signal and does not emit the rest", async () => {
    const controller = new AbortController();
    const frames: number[] = [];

    await expect(
      renderTimeline(
        makeStore(),
        {},
        renderers,
        { ...options, fps: 4, duration: 1 },
        (_buf, i) => {
          frames.push(i);
          if (i === 1) {
            controller.abort();
          }
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled/i);

    expect(frames).toEqual([0, 1]);
  });

  it("does not start at all when the signal is already aborted", async () => {
    const frames: number[] = [];
    await expect(
      renderTimeline(
        makeStore(),
        {},
        renderers,
        options,
        (_buf, i) => frames.push(i),
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow(/cancelled/i);

    expect(frames).toEqual([]);
  });

  it("loads into a scope of its own, never the shared cache", async () => {
    // The whole of the background-export safety rests on this: the preview's
    // draw path seeks and releases handles in `_loadedElementVideo`, so an
    // export that decoded into it would have frames moved under its loop.
    // Audio is skipped as it always was — FFmpeg rebuilds that graph itself.
    const store = makeStore();
    await renderTimeline(store, {}, renderers, options, () => {});

    expect(store.loadExportScope).toHaveBeenCalledTimes(1);
    const [scope, timeline] = (store.loadExportScope as any).mock.calls[0];
    expect(timeline).toEqual({});
    expect(scope.videos).toEqual({});
    expect(scope.id).toMatch(/^export:/);
  });

  it("seeks the same scope it loaded, every frame", async () => {
    const store = makeStore();
    await renderTimeline(
      store,
      {},
      renderers,
      { ...options, fps: 4, duration: 1 },
      () => {},
    );

    const loaded = (store.loadExportScope as any).mock.calls[0][0];
    const seeks = (store.seekScope as any).mock.calls;
    expect(seeks).toHaveLength(4);
    for (const call of seeks) {
      expect(call[0]).toBe(loaded);
    }
  });

  it("releases its scope when the run finishes", async () => {
    const store = makeStore();
    await renderTimeline(store, {}, renderers, options, () => {});

    const loaded = (store.loadExportScope as any).mock.calls[0][0];
    expect(store.releaseVideoScope).toHaveBeenCalledWith(loaded);
  });

  it("releases its scope when a frame callback throws", async () => {
    // Nothing else holds a reference, so a leaked scope is a set of decoders
    // nobody will ever free.
    const store = makeStore();

    await expect(
      renderTimeline(store, {}, renderers, options, () => {
        throw new Error("pipe closed");
      }),
    ).rejects.toThrow("pipe closed");

    const loaded = (store.loadExportScope as any).mock.calls[0][0];
    expect(store.releaseVideoScope).toHaveBeenCalledWith(loaded);
  });

  it("releases its scope when the export is aborted", async () => {
    const store = makeStore();
    const controller = new AbortController();
    controller.abort();

    await expect(
      renderTimeline(store, {}, renderers, options, () => {}, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    const loaded = (store.loadExportScope as any).mock.calls[0][0];
    expect(store.releaseVideoScope).toHaveBeenCalledWith(loaded);
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
