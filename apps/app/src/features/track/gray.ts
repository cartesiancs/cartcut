/**
 * Grayscale images and the pyramid the tracker searches.
 *
 * DOM-free on purpose, the same rule `features/timeline/` and
 * `features/animation/` follow: the tracker has to run under
 * `environment: "node"` so its accuracy can be pinned against synthetic
 * sequences with a known answer. Everything that knows about `<video>` and
 * `<canvas>` lives in `frameSource.ts`; from here down a frame is three numbers
 * and a buffer.
 *
 * Luminance is `Float32Array`, not `Uint8ClampedArray`. The tracker's whole job
 * is sub-pixel, so it samples between pixels on every iteration and takes
 * differences of those samples; rounding each one back to an integer would
 * quantise the gradient the solve depends on. The extra 3 bytes per pixel buys
 * that at a working resolution capped at 960px.
 */

/** One frame's luminance. `data.length === width * height`. */
export type GrayImage = {
  data: Float32Array;
  width: number;
  height: number;
};

/** An `ImageData`-shaped input — anything with RGBA bytes and a size. */
export type RgbaImage = {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
};

/**
 * Rec. 601 luma.
 *
 * Not Rec. 709, and the difference matters less than the consistency: the
 * tracker only ever compares one frame's luma to the next frame's, so any fixed
 * weighting works as long as it is the same one on both sides. 601 is chosen
 * because it weights red more heavily, and skin, rust and tail-lights — the
 * things people actually track — separate from a neutral background better
 * under it.
 */
export function toGray(source: RgbaImage): GrayImage {
  const { width, height } = source;
  const out = new Float32Array(Math.max(0, width * height));
  const src = source.data;

  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
  }

  return { data: out, width, height };
}

/**
 * Half-size, low-passed first.
 *
 * The 5-tap binomial `[1, 4, 6, 4, 1] / 16`, separable, which is what OpenCV's
 * `pyrDown` uses and for the reason it does: decimating without a blur aliases
 * high-frequency detail into the lower level, and the coarse level is precisely
 * where the tracker makes its first, largest guess. An aliased coarse level
 * sends the search to the wrong place and the fine levels then refine a wrong
 * answer very precisely.
 *
 * Edges are clamped rather than wrapped. A wrapped edge makes the left of the
 * frame a plausible match for something leaving the right of it.
 */
export function downsample(src: GrayImage): GrayImage {
  const w = Math.max(1, src.width >> 1);
  const h = Math.max(1, src.height >> 1);
  const out = new Float32Array(w * h);

  // Horizontal pass into a full-height, half-width scratch, then vertical.
  const scratch = new Float32Array(w * src.height);
  for (let y = 0; y < src.height; y++) {
    const row = y * src.width;
    const orow = y * w;
    for (let x = 0; x < w; x++) {
      const cx = x << 1;
      scratch[orow + x] =
        (src.data[row + clampIndex(cx - 2, src.width)] +
          4 * src.data[row + clampIndex(cx - 1, src.width)] +
          6 * src.data[row + clampIndex(cx, src.width)] +
          4 * src.data[row + clampIndex(cx + 1, src.width)] +
          src.data[row + clampIndex(cx + 2, src.width)]) /
        16;
    }
  }

  for (let y = 0; y < h; y++) {
    const cy = y << 1;
    const r0 = clampIndex(cy - 2, src.height) * w;
    const r1 = clampIndex(cy - 1, src.height) * w;
    const r2 = clampIndex(cy, src.height) * w;
    const r3 = clampIndex(cy + 1, src.height) * w;
    const r4 = clampIndex(cy + 2, src.height) * w;
    const orow = y * w;
    for (let x = 0; x < w; x++) {
      out[orow + x] =
        (scratch[r0 + x] +
          4 * scratch[r1 + x] +
          6 * scratch[r2 + x] +
          4 * scratch[r3 + x] +
          scratch[r4 + x]) /
        16;
    }
  }

  return { data: out, width: w, height: h };
}

/**
 * How many levels a frame of this size is worth.
 *
 * Stops before either side falls under `MIN_PYRAMID_SIDE`: a level smaller than
 * the correlation window is not a coarser view of the picture, it *is* the
 * window, and matching it answers "does this patch look like the whole frame".
 */
export const MIN_PYRAMID_SIDE = 32;

export function pyramidLevelsFor(
  width: number,
  height: number,
  max = 4,
): number {
  let levels = 1;
  let w = width;
  let h = height;
  while (
    levels < max &&
    w >> 1 >= MIN_PYRAMID_SIDE &&
    h >> 1 >= MIN_PYRAMID_SIDE
  ) {
    w >>= 1;
    h >>= 1;
    levels++;
  }
  return levels;
}

/** Level 0 is the original; each subsequent level is half the previous. */
export function buildPyramid(src: GrayImage, levels: number): GrayImage[] {
  const out: GrayImage[] = [src];
  for (let level = 1; level < levels; level++) {
    out.push(downsample(out[out.length - 1]));
  }
  return out;
}

/**
 * Bilinear sample, with the border clamped.
 *
 * Out-of-frame reads are the normal case rather than an error: a window centred
 * one pixel inside the edge has half of itself outside, and the tracker has to
 * be able to follow something to the edge of frame and report the confidence
 * honestly rather than throw. Clamping repeats the edge pixel, which flattens
 * the gradient there — so a patch that leaves the frame loses texture, loses
 * correlation, and is reported as lost. That is the outcome we want, arrived at
 * without a special case.
 */
export function sampleBilinear(img: GrayImage, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const x0c = clampIndex(x0, img.width);
  const x1c = clampIndex(x0 + 1, img.width);
  const y0c = clampIndex(y0, img.height);
  const y1c = clampIndex(y0 + 1, img.height);

  const r0 = y0c * img.width;
  const r1 = y1c * img.width;

  const top = img.data[r0 + x0c] * (1 - fx) + img.data[r0 + x1c] * fx;
  const bottom = img.data[r1 + x0c] * (1 - fx) + img.data[r1 + x1c] * fx;

  return top * (1 - fy) + bottom * fy;
}

function clampIndex(value: number, size: number): number {
  if (value < 0) {
    return 0;
  }
  if (value >= size) {
    return size - 1;
  }
  return value;
}
