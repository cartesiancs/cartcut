/**
 * Test-only helpers for the renderer suites.
 *
 * `@napi-rs/canvas` gives a real Skia 2D context in Node, so the renderers can
 * be exercised exactly as the browser runs them and asserted on actual pixels
 * rather than on recorded call sequences.
 *
 * The timeline element types are wide and fully required, so building one inline
 * per test buries the two or three fields a test actually cares about. These
 * factories supply a neutral element and take an override patch.
 */

import { createCanvas, type Canvas } from "@napi-rs/canvas";
import type {
  GifElementType,
  ImageElementType,
  ShapeElementType,
  TextElementType,
  VideoElementType,
  AudioElementType,
} from "../../@types/timeline";
import { emptyAnimation, type Keyframe } from "../animation/keyframes";

export type Rgba = { r: number; g: number; b: number; a: number };

/** A canvas plus its 2D context, typed as the renderers expect. */
export function scene(w: number, h: number, background?: string) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }
  return { canvas, ctx };
}

/** A solid-colour canvas usable as a `drawImage` source. */
export function solid(w: number, h: number, color: string): Canvas {
  const c = createCanvas(w, h);
  const cx = c.getContext("2d");
  cx.fillStyle = color;
  cx.fillRect(0, 0, w, h);
  return c;
}

export function pixel(canvas: Canvas, x: number, y: number): Rgba {
  const d = canvas.getContext("2d").getImageData(x, y, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] };
}

/** Bounding box and count of everything drawn over a pure-black background. */
export function inkBounds(canvas: Canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 40) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY, count };
}

/** Baked `[timeMs, value]` animation points, the form `interpolate` samples. */
export function points(...pairs: Array<[number, number]>): number[][] {
  return pairs.map(([t, v]) => [t, v]);
}

/**
 * Authored keyframes from `[timeMs, value]` tuples — the `x`/`y` form, as
 * `points` is the baked `ax`/`ay` form.
 *
 * Handles collapse onto the anchor, so a track built this way is a plain
 * polyline and its baked output is easy to reason about in an assertion.
 */
export function keys(...pairs: Array<[number, number]>): Keyframe[] {
  return pairs.map(([t, v]) => ({
    type: "cubic" as const,
    p: [t, v] as [number, number],
    cs: [t, v] as [number, number],
    ce: [t, v] as [number, number],
  }));
}

/**
 * A small deterministic PRNG for the property-based suites.
 *
 * Seeded so a failure is reproducible; `Math.random` would make a fuzz failure
 * a one-off nobody can chase.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const placed = {
  key: "el",
  localpath: "/tmp/asset",
  trackId: "track-1",
  priority: 1,
  blob: "",
  startTime: 0,
  duration: 4000,
  location: { x: 0, y: 0 },
  timelineOptions: { color: "#ffffff" },
};

const visual = {
  width: 100,
  height: 100,
  ratio: 1,
  opacity: 100,
  rotation: 0,
};

/**
 * All four tracks present and inactive — the neutral animation state.
 *
 * Delegates to the shipping definition rather than restating it. This helper
 * used to write the *correct* `ax: []` while every runtime factory wrote
 * `ax: [[], []]`, so no test ever exercised the shape the app actually built.
 */
export function inactiveAnimation() {
  return emptyAnimation("image");
}

export function imageElement(
  over: Partial<ImageElementType> = {},
): ImageElementType {
  return {
    ...placed,
    ...visual,
    filetype: "image",
    animation: inactiveAnimation(),
    ...over,
  };
}

export function gifElement(over: Partial<GifElementType> = {}): GifElementType {
  return { ...placed, ...visual, filetype: "gif", ...over };
}

export function shapeElement(
  over: Partial<ShapeElementType> = {},
): ShapeElementType {
  return {
    ...placed,
    ...visual,
    filetype: "shape",
    animation: { opacity: { isActivate: false, x: [], ax: [] } },
    oWidth: 100,
    oHeight: 100,
    shape: [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ],
    option: { fillColor: "#ff0000" },
    ...over,
  };
}

export function videoElement(
  over: Partial<VideoElementType> = {},
): VideoElementType {
  return {
    ...placed,
    ...visual,
    filetype: "video",
    animation: inactiveAnimation(),
    trim: { startTime: 0, endTime: 4000 },
    sourceDuration: 4000,
    isExistAudio: true,
    codec: { video: "h264", audio: "aac" },
    speed: 1,
    filter: { enable: false, list: [] },
    origin: { width: 100, height: 100 },
    ...over,
  };
}

export function textElement(
  over: Partial<TextElementType> = {},
): TextElementType {
  return {
    ...placed,
    ...visual,
    filetype: "text",
    animation: inactiveAnimation(),
    text: "AB",
    textcolor: "#ffffff",
    fontsize: 40,
    fontpath: "",
    fontname: "sans-serif",
    fontweight: "normal",
    fonttype: "ttf",
    letterSpacing: 0,
    options: {
      isBold: false,
      isItalic: false,
      align: "left",
      outline: { enable: false, size: 0, color: "#000000" },
    },
    background: { enable: false, color: "#000000" },
    widthInner: 100,
    width: 200,
    height: 60,
    ...over,
  };
}

export function audioElement(
  over: Partial<AudioElementType> = {},
): AudioElementType {
  return {
    ...placed,
    filetype: "audio",
    trim: { startTime: 0, endTime: 4000 },
    sourceDuration: 4000,
    speed: 1,
    ...over,
  };
}
