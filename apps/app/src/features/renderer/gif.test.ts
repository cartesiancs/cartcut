import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { scene, pixel, gifElement } from "./testing";

// The module builds a scratch canvas at import time, so `document` has to exist
// before it is loaded.
vi.stubGlobal("document", {
  createElement: (tag: string) => {
    if (tag !== "canvas") throw new Error(`unexpected createElement(${tag})`);
    return createCanvas(1, 1);
  },
});

const store = {
  getGif: vi.fn<[string], unknown>(),
};

vi.mock("../asset/loadedAssetStore", () => ({
  loadedAssetStore: { getState: () => store },
}));

const { renderGif } = await import("./gif");

/** A decoded frame of a single flat colour, in the shape the store hands over. */
function frame(color: [number, number, number], delay: number, size = 8) {
  const imageData = createCanvas(size, size)
    .getContext("2d")
    .createImageData(size, size);
  for (let i = 0; i < imageData.data.length; i += 4) {
    imageData.data[i] = color[0];
    imageData.data[i + 1] = color[1];
    imageData.data[i + 2] = color[2];
    imageData.data[i + 3] = 255;
  }
  return {
    imageData,
    parsedFrame: { delay, dims: { width: size, height: size } },
  };
}

const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];
const BLUE: [number, number, number] = [0, 0, 255];

function threeFrames(delay = 100) {
  return [frame(RED, delay), frame(GREEN, delay), frame(BLUE, delay)];
}

beforeEach(() => {
  store.getGif.mockReset();
});

describe("renderGif", () => {
  it("stretches the current frame over the element's local box", () => {
    store.getGif.mockReturnValue(threeFrames());
    const el = gifElement({ width: 80, height: 60 });

    const { canvas, ctx } = scene(100, 100, "#000000");
    renderGif(ctx, "g", el, 0);

    expect(pixel(canvas, 1, 1)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 78, 58)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 82, 58)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("advances one frame per delay", () => {
    store.getGif.mockReturnValue(threeFrames(100));
    const el = gifElement({ startTime: 0, width: 50, height: 50 });

    const at = (cursor: number) => {
      const { canvas, ctx } = scene(60, 60, "#000000");
      renderGif(ctx, "g", el, cursor);
      return pixel(canvas, 25, 25);
    };

    expect(at(0)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(at(99)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(at(100)).toMatchObject({ r: 0, g: 255, b: 0 });
    expect(at(200)).toMatchObject({ r: 0, g: 0, b: 255 });
  });

  it("loops back to the first frame at the end of the sequence", () => {
    store.getGif.mockReturnValue(threeFrames(100));
    const el = gifElement({ startTime: 0, width: 50, height: 50 });

    const { canvas, ctx } = scene(60, 60, "#000000");
    renderGif(ctx, "g", el, 300);
    expect(pixel(canvas, 25, 25)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("starts from the first frame wherever the clip sits on the timeline", () => {
    // Playback is relative to the clip's own start, so two copies of a GIF
    // placed at different times are each in step with themselves rather than
    // phase-locked to the project clock.
    store.getGif.mockReturnValue(threeFrames(100));
    const late = gifElement({ startTime: 5000, width: 50, height: 50 });

    const { canvas, ctx } = scene(60, 60, "#000000");
    renderGif(ctx, "g", late, 5000);
    expect(pixel(canvas, 25, 25)).toMatchObject({ r: 255, g: 0, b: 0 });

    const next = scene(60, 60, "#000000");
    renderGif(next.ctx, "g", late, 5100);
    expect(pixel(next.canvas, 25, 25)).toMatchObject({ r: 0, g: 255, b: 0 });
  });

  it("looks the GIF up by its path", () => {
    store.getGif.mockReturnValue(threeFrames());
    const { ctx } = scene(60, 60);
    renderGif(ctx, "g", gifElement({ localpath: "/assets/loop.gif" }), 0);
    expect(store.getGif).toHaveBeenCalledWith("/assets/loop.gif");
  });

  it("draws nothing while the GIF is still decoding", () => {
    store.getGif.mockReturnValue(null);
    const { canvas, ctx } = scene(60, 60, "#000000");
    expect(() => renderGif(ctx, "g", gifElement(), 0)).not.toThrow();
    expect(pixel(canvas, 25, 25)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("does not blend one frame into the next when frame sizes differ", () => {
    // The scratch canvas is shared across every GIF, so it has to be cleared
    // between frames or a smaller frame keeps the previous one's edges.
    store.getGif.mockReturnValue([frame(RED, 100, 16), frame(GREEN, 100, 4)]);
    const el = gifElement({ startTime: 0, width: 50, height: 50 });

    const first = scene(60, 60, "#000000");
    renderGif(first.ctx, "g", el, 0);

    const second = scene(60, 60, "#000000");
    renderGif(second.ctx, "g", el, 100);
    expect(pixel(second.canvas, 25, 25)).toMatchObject({ r: 0, g: 255, b: 0 });
    expect(pixel(second.canvas, 5, 5)).toMatchObject({ r: 0, g: 255, b: 0 });
  });
});
