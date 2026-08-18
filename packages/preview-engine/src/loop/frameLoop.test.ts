import { describe, it, expect, vi } from "vitest";
import { runFrameLoop } from "./frameLoop";
import type { FrameSink, FrameLoopDeps } from "./frameLoop";
import { scene, solid, noAssets } from "../test/canvas";
import type { AssetResolver } from "../render/types";
import type { RenderTimeline, RenderOptions } from "../model/timeline.types";

const options: RenderOptions = {
  width: 40,
  height: 40,
  backgroundColor: "#000000",
};

function image(over: Partial<RenderTimeline[string]> = {}) {
  return {
    filetype: "image",
    priority: 1,
    startTime: 0,
    duration: 4000,
    location: { x: 0, y: 0 },
    width: 40,
    height: 40,
    opacity: 100,
    rotation: 0,
    animation: {},
    ...over,
  };
}

const assets: AssetResolver = {
  ...noAssets,
  getImage: () => solid(40, 40, "#ff0000") as never,
};

/** A sink that records what it was handed. */
function recordingSink() {
  const frames: number[] = [];
  let finished = 0;
  const sink: FrameSink = {
    sendFrame: (_buf, percent) => {
      frames.push(percent);
    },
    finish: () => {
      finished++;
    },
  };
  return { sink, frames, finished: () => finished };
}

function makeDeps(over: Partial<FrameLoopDeps> = {}): FrameLoopDeps {
  return {
    assets,
    prepareFrame: () => {},
    encodeCanvas: async () => new ArrayBuffer(8),
    ...over,
  };
}

describe("runFrameLoop", () => {
  it("emits fps * duration frames and finishes exactly once", async () => {
    const { ctx } = scene(40, 40);
    const { sink, frames, finished } = recordingSink();

    const res = await runFrameLoop(
      ctx,
      { a: image() },
      options,
      { fps: 10, durationSec: 2 },
      makeDeps(),
      sink,
    );

    expect(res).toEqual({ totalFrames: 20, framesSent: 20, framesFailed: 0 });
    expect(frames).toHaveLength(20);
    expect(finished()).toBe(1);
  });

  it("reports progress from 0 up to just under 100", async () => {
    const { ctx } = scene(40, 40);
    const { sink, frames } = recordingSink();
    await runFrameLoop(
      ctx,
      { a: image() },
      options,
      { fps: 4, durationSec: 1 },
      makeDeps(),
      sink,
    );
    expect(frames).toEqual([0, 25, 50, 75]);
  });

  it("prepares each frame before compositing it, and in timecode order", async () => {
    const { ctx } = scene(40, 40);
    const { sink } = recordingSink();
    const order: string[] = [];

    await runFrameLoop(
      ctx,
      { a: image() },
      options,
      { fps: 2, durationSec: 1 },
      makeDeps({
        prepareFrame: async (timeMs) => {
          order.push(`prepare:${timeMs}`);
          await Promise.resolve();
        },
        encodeCanvas: async () => {
          order.push("encode");
          return new ArrayBuffer(8);
        },
      }),
      sink,
    );

    expect(order).toEqual([
      "prepare:0",
      "encode",
      "prepare:500",
      "encode",
    ]);
  });

  it("tells prepareFrame which elements the frame actually needs", async () => {
    const { ctx } = scene(40, 40);
    const { sink } = recordingSink();
    const seen: string[][] = [];

    const timeline: RenderTimeline = {
      early: image({ priority: 1, startTime: 0, duration: 500 }),
      late: image({ priority: 2, startTime: 500, duration: 500 }),
      music: { filetype: "audio", priority: 3, startTime: 0, duration: 1000, speed: 1 },
    };

    await runFrameLoop(
      ctx,
      timeline,
      options,
      { fps: 2, durationSec: 1 },
      makeDeps({ prepareFrame: (_t, ids) => void seen.push(ids) }),
      sink,
    );

    // audio never appears, and each frame lists only what is on screen then
    expect(seen).toEqual([["early"], ["late"]]);
  });

  it("keeps going when a frame fails, and still closes the stream", async () => {
    // This is the regression guard for the offscreen renderer's stall: a frame
    // that cannot be produced must not end the export.
    const { ctx } = scene(40, 40);
    const { sink, frames, finished } = recordingSink();
    const onFrameError = vi.fn();

    const res = await runFrameLoop(
      ctx,
      { a: image() },
      options,
      { fps: 5, durationSec: 1 },
      makeDeps({
        prepareFrame: (timeMs) => {
          if (timeMs === 400) throw new Error("seek failed");
        },
      }),
      sink,
      { onFrameError },
    );

    expect(res).toEqual({ totalFrames: 5, framesSent: 4, framesFailed: 1 });
    expect(frames).toHaveLength(4);
    expect(finished()).toBe(1);
    expect(onFrameError).toHaveBeenCalledTimes(1);
    expect(onFrameError.mock.calls[0][1]).toBe(2); // frame index
  });

  it("survives an encode failure the same way", async () => {
    const { ctx } = scene(40, 40);
    const { sink, finished } = recordingSink();
    let call = 0;

    const res = await runFrameLoop(
      ctx,
      { a: image() },
      options,
      { fps: 3, durationSec: 1 },
      makeDeps({
        encodeCanvas: async () => {
          call++;
          if (call === 2) throw new Error("toBlob returned null");
          return new ArrayBuffer(8);
        },
      }),
      sink,
    );

    expect(res.framesSent).toBe(2);
    expect(res.framesFailed).toBe(1);
    expect(finished()).toBe(1);
  });

  it("does not let an element that cannot draw reduce the frame count", async () => {
    // An element whose keyframe track precedes its start aborts its own draw.
    // Every frame must still be emitted.
    const { ctx } = scene(40, 40);
    const { sink, frames } = recordingSink();

    const timeline: RenderTimeline = {
      broken: image({
        startTime: 0,
        duration: 4000,
        animation: { opacity: { isActivate: true, ax: [[0, 100]] } },
      }),
    };
    timeline.broken.startTime = 0;

    const res = await runFrameLoop(
      ctx,
      timeline,
      options,
      { fps: 10, durationSec: 1 },
      makeDeps({ assets: noAssets }), // nothing ever resolves, every draw returns false
      sink,
    );

    expect(res.framesSent).toBe(10);
    expect(frames).toHaveLength(10);
  });

  it("emits nothing but still finishes for a zero-length project", async () => {
    const { ctx } = scene(40, 40);
    const { sink, frames, finished } = recordingSink();
    const res = await runFrameLoop(
      ctx,
      { a: image() },
      options,
      { fps: 60, durationSec: 0 },
      makeDeps(),
      sink,
    );
    expect(res.totalFrames).toBe(0);
    expect(frames).toEqual([]);
    expect(finished()).toBe(1);
  });

  it("actually composites onto the context it was given", async () => {
    const { canvas, ctx } = scene(40, 40);
    const { sink } = recordingSink();
    await runFrameLoop(
      ctx,
      { a: image() },
      options,
      { fps: 1, durationSec: 1 },
      makeDeps(),
      sink,
    );
    const d = canvas.getContext("2d").getImageData(20, 20, 1, 1).data;
    expect([d[0], d[1], d[2]]).toEqual([255, 0, 0]);
  });
});
