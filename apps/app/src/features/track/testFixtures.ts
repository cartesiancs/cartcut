/**
 * Synthetic footage with a known answer.
 *
 * The tracker cannot be checked against real video: there is no ground truth in
 * a recording, only a second opinion. So the suites build a texture, move it by
 * an amount they chose, and ask the tracker what it moved by. Everything here
 * is deterministic — a fixed hash rather than `Math.random` — so a failure is a
 * failure and not a seed.
 *
 * Shared by `tracker.test.ts` and `gray.test.ts`; kept out of a `.test.ts` file
 * so importing it does not register a second empty suite.
 */

import { sampleBilinear, type GrayImage } from "./gray";

/** A cheap integer hash. Same input, same output, on every platform. */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * Value noise at two octaves, in 0..255.
 *
 * Two octaves rather than one because each solves a different half of the
 * problem: the coarse octave gives the pyramid something to see at its top
 * level, and the fine one gives the sub-pixel solve a gradient to work with. A
 * single-octave texture tracks either roughly or not at all.
 */
export function makeTexture(
  width: number,
  height: number,
  seed = 1,
): GrayImage {
  const data = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] =
        140 * valueNoise(x / 12, y / 12, seed) +
        80 * valueNoise(x / 4, y / 4, seed + 7) +
        20;
    }
  }

  return { data, width, height };
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);

  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);

  return (
    (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
  );
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** The same picture, moved by `(dx, dy)`. Sub-pixel, by bilinear resampling. */
export function shift(image: GrayImage, dx: number, dy: number): GrayImage {
  const data = new Float32Array(image.width * image.height);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      data[y * image.width + x] = sampleBilinear(image, x - dx, y - dy);
    }
  }
  return { data, width: image.width, height: image.height };
}

/** `gain * value + lift`, clamped — a shot that brightens under the tracker. */
export function relight(
  image: GrayImage,
  gain: number,
  lift: number,
): GrayImage {
  const data = new Float32Array(image.data.length);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.max(0, Math.min(255, image.data[i] * gain + lift));
  }
  return { data, width: image.width, height: image.height };
}

/** Paint a flat square over the picture — something walking in front of it. */
export function occlude(
  image: GrayImage,
  cx: number,
  cy: number,
  radius: number,
  value = 128,
): GrayImage {
  const data = Float32Array.from(image.data);
  for (let y = Math.round(cy - radius); y <= Math.round(cy + radius); y++) {
    if (y < 0 || y >= image.height) {
      continue;
    }
    for (let x = Math.round(cx - radius); x <= Math.round(cx + radius); x++) {
      if (x < 0 || x >= image.width) {
        continue;
      }
      data[y * image.width + x] = value;
    }
  }
  return { data, width: image.width, height: image.height };
}

/** A picture with no detail at all. */
export function flatImage(
  width: number,
  height: number,
  value = 120,
): GrayImage {
  return { data: new Float32Array(width * height).fill(value), width, height };
}
