/**
 * A LUT as a 2D texture.
 *
 * WebGL 1 has no `TEXTURE_3D` and this app has no WebGL 2 context — both
 * existing ones are `getContext("webgl")` — so a cube has to be flattened into
 * a 2D image before the GPU can see it. The layout is a grid of square tiles,
 * one per blue slice, with red running across a tile and green down it:
 *
 * ```
 *   b=0   b=1   b=2   b=3        cols = ceil(sqrt(size))
 *   b=4   b=5   b=6   b=7        rows = ceil(size / cols)
 *   b=8   ...                    width = cols * size, height = rows * size
 * ```
 *
 * A square-ish grid rather than a single long strip, because a strip of a 64³
 * LUT is 4096 texels wide — exactly the maximum texture size on a good deal of
 * hardware — and a 128³ one would be 16,384 and simply fail. The grid keeps
 * the largest LUT the app accepts at 1536×1408.
 *
 * ## Nodes are fetched, never filtered
 *
 * The shader reads texels with `NEAREST` and does the interpolation itself.
 * Hardware bilinear filtering would be free, but it would also blend across
 * *tile boundaries* — the texel to the right of the last red node of one blue
 * slice is the first red node of the next, and a filtered read there mixes two
 * unrelated colours into a visible seam. Fetching exact texel centres and
 * interpolating in GLSL sidesteps that entirely, and it is also what makes the
 * shader able to be tetrahedral rather than trilinear.
 *
 * ## `toAtlas` and `fromAtlas` are inverses
 *
 * That is the whole correctness argument for this file, and `atlas.test.ts`
 * states it directly. It means the round trip through a texture cannot lose or
 * transpose anything, so the only thing left to verify about the GPU path is
 * that the GLSL fetch reproduces `atlasNodeOffset` — which the end-to-end
 * export spec checks against pixels.
 */

import {
  type Lut1d,
  type Lut3d,
  type LutData,
  type LutTriple,
  nodeOffset,
} from "./lutData";

export type LutAtlas = {
  kind: "3d" | "1d";
  size: number;
  width: number;
  height: number;
  /** Tiles across and down. `1`/`1` for a 1D LUT, which is a single row. */
  cols: number;
  rows: number;
  /** `width * height * 4` floats, RGBA, row-major. Alpha is always 1. */
  data: Float32Array;
  domainMin: LutTriple;
  domainMax: LutTriple;
};

/** Tiles across, for a cube of this size. */
export function colsFor(size: number): number {
  return Math.ceil(Math.sqrt(size));
}

export function toAtlas(lut: LutData): LutAtlas {
  return lut.kind === "1d" ? atlas1d(lut) : atlas3d(lut);
}

function atlas3d(lut: Lut3d): LutAtlas {
  const { size } = lut;
  const cols = colsFor(size);
  const rows = Math.ceil(size / cols);
  const width = cols * size;
  const height = rows * size;
  const data = new Float32Array(width * height * 4);

  // `cols * rows` is at least `size` and often more — a 8³ LUT needs 8 blue
  // slices and gets a 3×3 grid — so the last tiles of the last row are padding
  // that no fetch ever reaches, because the blue node index is clamped to
  // `size - 1` before it is turned into a tile. They are still given an opaque
  // alpha so the uploaded texture has no undefined region: a hole here would
  // read as transparent black in a texture inspector and send whoever is
  // debugging the shader looking for a bug that is not there.
  for (let i = 3; i < data.length; i += 4) {
    data[i] = 1;
  }

  for (let b = 0; b < size; b++) {
    const tileX = (b % cols) * size;
    const tileY = Math.floor(b / cols) * size;
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const from = nodeOffset(size, r, g, b);
        const to = ((tileY + g) * width + tileX + r) * 4;
        data[to] = lut.data[from];
        data[to + 1] = lut.data[from + 1];
        data[to + 2] = lut.data[from + 2];
        data[to + 3] = 1;
      }
    }
  }

  return {
    kind: "3d",
    size,
    width,
    height,
    cols,
    rows,
    data,
    domainMin: lut.domainMin,
    domainMax: lut.domainMax,
  };
}

function atlas1d(lut: Lut1d): LutAtlas {
  const { size } = lut;
  const data = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    data[i * 4] = lut.data[i * 3];
    data[i * 4 + 1] = lut.data[i * 3 + 1];
    data[i * 4 + 2] = lut.data[i * 3 + 2];
    data[i * 4 + 3] = 1;
  }
  return {
    kind: "1d",
    size,
    width: size,
    height: 1,
    cols: 1,
    rows: 1,
    data,
    domainMin: lut.domainMin,
    domainMax: lut.domainMax,
  };
}

/**
 * Where node `(r, g, b)` sits in the atlas, as an offset into `data`.
 *
 * The GLSL `lutNode()` computes the same thing in texel coordinates. Keeping
 * the arithmetic in one exported function on this side means the test can
 * check the layout without a GPU, and the shader has one thing to mirror.
 */
export function atlasNodeOffset(
  atlas: LutAtlas,
  r: number,
  g: number,
  b: number,
): number {
  const { size, cols, width } = atlas;
  const x = (b % cols) * size + r;
  const y = Math.floor(b / cols) * size + g;
  return (y * width + x) * 4;
}

/** Recover the `LutData` an atlas was built from. Exactly inverse to `toAtlas`. */
export function fromAtlas(atlas: LutAtlas): LutData {
  const { size } = atlas;
  if (atlas.kind === "1d") {
    const data = new Float32Array(size * 3);
    for (let i = 0; i < size; i++) {
      data[i * 3] = atlas.data[i * 4];
      data[i * 3 + 1] = atlas.data[i * 4 + 1];
      data[i * 3 + 2] = atlas.data[i * 4 + 2];
    }
    return {
      kind: "1d",
      size,
      data,
      domainMin: atlas.domainMin,
      domainMax: atlas.domainMax,
    };
  }

  const data = new Float32Array(size * size * size * 3);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const from = atlasNodeOffset(atlas, r, g, b);
        const to = nodeOffset(size, r, g, b);
        data[to] = atlas.data[from];
        data[to + 1] = atlas.data[from + 1];
        data[to + 2] = atlas.data[from + 2];
      }
    }
  }
  return {
    kind: "3d",
    size,
    data,
    domainMin: atlas.domainMin,
    domainMax: atlas.domainMax,
  };
}

/**
 * The atlas as bytes, for hosts without float textures.
 *
 * Clamps, because `UNSIGNED_BYTE` cannot hold the out-of-range values an HDR
 * LUT legitimately contains. This is the lossy path — see `gpu.ts`, which
 * prefers half-float precisely so that it is rarely taken.
 */
export function toAtlasBytes(atlas: LutAtlas): Uint8Array {
  const out = new Uint8Array(atlas.data.length);
  for (let i = 0; i < atlas.data.length; i++) {
    const v = atlas.data[i];
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  return out;
}

/** The atlas as IEEE half floats, for `OES_texture_half_float`. */
export function toAtlasHalf(atlas: LutAtlas): Uint16Array {
  const out = new Uint16Array(atlas.data.length);
  for (let i = 0; i < atlas.data.length; i++) {
    out[i] = floatToHalf(atlas.data[i]);
  }
  return out;
}

const halfScratch = new Float32Array(1);
const halfScratchBits = new Uint32Array(halfScratch.buffer);

/**
 * IEEE 754 binary32 to binary16, round-to-nearest-even.
 *
 * Written out rather than pulled from a library because it is fifteen lines
 * and this file is already the one place that knows how a LUT becomes bytes.
 * Subnormals and overflow both matter here: a LUT's darkest nodes are small
 * enough to land in the subnormal range, and flushing them to zero would crush
 * shadow detail in exactly the LUTs people notice it in.
 */
export function floatToHalf(value: number): number {
  halfScratch[0] = value;
  const bits = halfScratchBits[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;

  if (exponent === 0xff) {
    // Infinity or NaN. NaN must stay NaN rather than becoming infinity.
    return sign | 0x7c00 | (mantissa !== 0 ? 0x0200 : 0);
  }

  // Rebias 127 -> 15.
  exponent = exponent - 127 + 15;

  if (exponent >= 0x1f) {
    return sign | 0x7c00;
  }
  if (exponent <= 0) {
    if (exponent < -10) {
      return sign;
    }
    // Subnormal: restore the implicit leading 1 and shift it into place.
    mantissa |= 0x800000;
    const shift = 14 - exponent;
    const half = (mantissa + (1 << (shift - 1))) >>> shift;
    return sign | half;
  }

  // Round the 23-bit mantissa to 10 bits, to nearest, ties to even.
  const rounded = mantissa + 0x0fff + ((mantissa >>> 13) & 1);
  if (rounded & 0x800000) {
    return sign | ((exponent + 1) << 10);
  }
  return sign | (exponent << 10) | (rounded >>> 13);
}
