import { describe, it, expect, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import type { Timeline, VisualTimelineElement } from "../../@types/timeline";
import {
  solid,
  points,
  imageElement,
  shapeElement,
  audioElement,
  inactiveAnimation,
} from "./testing";

const store = { getImage: () => solid(60, 60, "#ff4400") };
vi.mock("../asset/loadedAssetStore", () => ({
  loadedAssetStore: { getState: () => store },
}));

const { renderTimelineAtTime } = await import("./timeline");
const { renderImage } = await import("./image");
const { renderShape } = await import("./shape");

/**
 * Golden frames — the regression net for the renderer.
 *
 * A fixed scene is composited at several timecodes and each frame's pixels are
 * reduced to a stable digest. A changed digest means the picture changed: fine
 * when that is the point of the commit (re-baseline in the same change, and say
 * why), a bug when it happens during a refactor that was supposed to preserve
 * output.
 *
 * Text is deliberately absent — its metrics come from whichever font the host
 * resolves, which would make the digest differ between machines. `text.test.ts`
 * covers it with font-independent assertions instead. The digest does depend on
 * the pinned `@napi-rs/canvas`, so a Skia bump is a legitimate re-baseline.
 */

const SIZE = 240;

const renderers = {
  image: renderImage,
  shape: renderShape,
  video: () => {},
  gif: () => {},
  text: () => {},
} as unknown as Parameters<typeof renderTimelineAtTime>[3];

function timeline(): Timeline {
  return {
    backdrop: imageElement({
      priority: 1,
      startTime: 0,
      duration: 4000,
      location: { x: 0, y: 0 },
      width: SIZE,
      height: SIZE,
    }),
    // drifts right and fades out across the clip
    flyer: imageElement({
      priority: 2,
      startTime: 0,
      duration: 4000,
      location: { x: 20, y: 20 },
      width: 60,
      height: 60,
      rotation: 15,
      animation: {
        ...inactiveAnimation(),
        opacity: {
          isActivate: true,
          x: [],
          ax: points([0, 100], [2000, 50], [4000, 0]),
        },
        position: {
          isActivate: true,
          x: [],
          y: [],
          ax: points([0, 20], [2000, 120], [4000, 20]),
          ay: points([0, 20], [4000, 20]),
        },
      },
    }),
    // grows about its centre
    badge: shapeElement({
      priority: 3,
      startTime: 0,
      duration: 4000,
      location: { x: 90, y: 90 },
      width: 60,
      height: 60,
      oWidth: 60,
      rotation: 30,
      option: { fillColor: "#ffcc00" },
      shape: [
        [0, 0],
        [60, 0],
        [30, 60],
      ],
      animation: {
        opacity: { isActivate: true, x: [], ax: points([0, 100], [4000, 30]) },
      },
    }),
    // never visible in the sampled window; guards the visibility filter
    late: imageElement({
      priority: 4,
      startTime: 9000,
      duration: 1000,
      location: { x: 0, y: 0 },
      width: SIZE,
      height: SIZE,
    }),
    // audio must never reach the canvas
    music: audioElement({ priority: 5, startTime: 0, duration: 4000 }),
  };
}

/** FNV-1a over the RGBA buffer — stable across platforms, unlike a PNG blob. */
function digest(data: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function frameDigest(timeInMs: number): string {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  renderTimelineAtTime(
    ctx,
    timeline(),
    timeInMs,
    renderers,
    "#101020",
    SIZE,
    SIZE,
  );
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

  it("draws exactly the elements that are on screen", () => {
    const canvas = createCanvas(SIZE, SIZE);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    const drawn: string[] = [];

    renderTimelineAtTime(
      ctx,
      timeline(),
      2000,
      renderers,
      "#101020",
      SIZE,
      SIZE,
      undefined,
      (id: string, _el: VisualTimelineElement) => drawn.push(id),
    );

    expect(drawn).toEqual(["backdrop", "flyer", "badge"]);
  });
});
