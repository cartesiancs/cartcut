import { describe, it, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { renderFrame } from "./renderFrame";
import { solid, noAssets } from "../test/canvas";
import type { AssetResolver, CanvasCtx } from "./types";
import type { RenderTimeline, RenderOptions } from "../model/timeline.types";

/**
 * Golden frames — the regression net for the consolidation.
 *
 * A fixed scene is composited at several timecodes and each frame's pixels are
 * reduced to a stable digest. These digests must not move when the preview and
 * the two export paths are cut over to `renderFrame` in later steps: if all
 * three callers produce the same frames the engine produces here, "preview and
 * export draw the same picture" holds mechanically rather than by inspection.
 *
 * A changed digest means the composited image changed. That is fine when it is
 * intended (update the snapshot in the same commit as the behaviour change, and
 * say why); it is a bug when it happens during a pure move of call-sites.
 *
 * Video is excluded — it needs a real WebGL context for filters. `drawVideo` is
 * covered directly in drawers/video.test.ts with the shader stubbed.
 */

const SIZE = 240;

const options: RenderOptions = {
  width: SIZE,
  height: SIZE,
  backgroundColor: "#101020",
};

function timeline(): RenderTimeline {
  return {
    backdrop: {
      filetype: "image",
      priority: 1,
      startTime: 0,
      duration: 4000,
      location: { x: 0, y: 0 },
      width: SIZE,
      height: SIZE,
      opacity: 100,
      rotation: 0,
      animation: {},
    },
    // fades out and drifts right across the clip
    flyer: {
      filetype: "image",
      priority: 2,
      startTime: 0,
      duration: 4000,
      location: { x: 20, y: 20 },
      width: 60,
      height: 60,
      opacity: 100,
      rotation: 15,
      animation: {
        opacity: {
          isActivate: true,
          ax: [
            [0, 100],
            [2000, 50],
            [4000, 0],
          ],
        },
        position: {
          isActivate: true,
          ax: [
            [0, 20],
            [2000, 120],
            [4000, 20],
          ],
          ay: [
            [0, 20],
            [2000, 20],
            [4000, 20],
          ],
        },
      },
    },
    // grows over the clip
    stamp: {
      filetype: "gif",
      priority: 3,
      startTime: 0,
      duration: 4000,
      location: { x: 150, y: 150 },
      width: 60,
      height: 60,
      opacity: 80,
      rotation: 0,
    },
    badge: {
      filetype: "shape",
      priority: 4,
      startTime: 0,
      duration: 4000,
      location: { x: 90, y: 90 },
      width: 60,
      height: 60,
      oWidth: 60,
      opacity: 100,
      rotation: 30,
      option: { fillColor: "#ffcc00" },
      shape: [
        [0, 0],
        [60, 0],
        [30, 60],
      ],
      animation: {
        opacity: {
          isActivate: true,
          ax: [
            [0, 100],
            [4000, 30],
          ],
        },
      },
    },
    caption: {
      filetype: "text",
      priority: 5,
      startTime: 0,
      duration: 4000,
      parentKey: "standalone",
      location: { x: 10, y: 190 },
      width: 220,
      height: 40,
      opacity: 100,
      rotation: 0,
      text: "HELLO NUGGET RENDER",
      textcolor: "#ffffff",
      fontsize: 20,
      fontname: "sans-serif",
      letterSpacing: 0,
      options: {
        align: "center",
        isBold: true,
        isItalic: false,
        outline: { enable: true, size: 2, color: "#ff0044" },
      },
      background: { enable: true, color: "#003366" },
      animation: {},
    },
    // never visible in the sampled window; guards the visibility filter
    late: {
      filetype: "image",
      priority: 6,
      startTime: 9000,
      duration: 1000,
      location: { x: 0, y: 0 },
      width: SIZE,
      height: SIZE,
      opacity: 100,
      rotation: 0,
      animation: {},
    },
    // audio must never reach the canvas
    music: {
      filetype: "audio",
      priority: 7,
      startTime: 0,
      duration: 4000,
      speed: 1,
    },
  };
}

const assets: AssetResolver = {
  getImage: (id) =>
    (id === "backdrop"
      ? solid(SIZE, SIZE, "#204060")
      : solid(60, 60, "#ff4400")) as never,
  getGifFrame: () => solid(60, 60, "#00cc88") as never,
  getVideo: () => null,
};

/** FNV-1a over the RGBA buffer — stable across platforms, unlike a PNG blob. */
function digest(data: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function frameDigest(timeMs: number): string {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d") as unknown as CanvasCtx;
  renderFrame(ctx, timeline(), options, timeMs, { assets });
  return digest(canvas.getContext("2d").getImageData(0, 0, SIZE, SIZE).data);
}

describe("golden frames", () => {
  it("composites a stable frame at each sampled timecode", () => {
    const frames = Object.fromEntries(
      [0, 1000, 2000, 3000, 3999].map((t) => [t, frameDigest(t)]),
    );
    expect(frames).toMatchSnapshot();
  });

  it("is deterministic — the same timecode digests identically", () => {
    expect(frameDigest(2000)).toBe(frameDigest(2000));
  });

  it("actually changes between timecodes, so the digest is not a constant", () => {
    expect(frameDigest(0)).not.toBe(frameDigest(2000));
  });

  it("reports the elements it drew, excluding audio and out-of-window clips", () => {
    const canvas = createCanvas(SIZE, SIZE);
    const ctx = canvas.getContext("2d") as unknown as CanvasCtx;
    const res = renderFrame(ctx, timeline(), options, 2000, { assets });
    expect(res.drawn).toEqual([
      "backdrop",
      "flyer",
      "stamp",
      "badge",
      "caption",
    ]);
  });

  it("paints only the background when no assets have loaded", () => {
    const canvas = createCanvas(SIZE, SIZE);
    const ctx = canvas.getContext("2d") as unknown as CanvasCtx;
    const res = renderFrame(ctx, timeline(), options, 2000, {
      assets: noAssets,
    });
    // shape and text need no resolver, so they still draw
    expect(res.drawn).toEqual(["badge", "caption"]);
  });
});
