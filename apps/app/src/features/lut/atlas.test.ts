import { describe, expect, it } from "vitest";

import {
  atlasNodeOffset,
  colsFor,
  floatToHalf,
  fromAtlas,
  toAtlas,
  toAtlasBytes,
  toAtlasHalf,
} from "./atlas";
import { MAX_LUT_3D_SIZE, identityLut1d, identityLut3d, nodeOffset } from "./lutData";
import { sampleLut } from "./sample";

/** A LUT whose every node is distinct, so a transposition cannot hide. */
function marked(size: number) {
  const lut = identityLut3d(size);
  const total = size * size * size;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const at = nodeOffset(size, r, g, b);
        const index = (b * size + g) * size + r;
        lut.data[at] = index / total;
        lut.data[at + 1] = (index * 7919) % total / total;
        lut.data[at + 2] = 1 - index / total;
      }
    }
  }
  return lut;
}

describe("the atlas layout", () => {
  // The correctness argument for the whole GPU path. If the round trip is
  // lossless then a texture cannot lose or transpose anything, and the only
  // thing left to check about the shader is that its fetch mirrors
  // `atlasNodeOffset` — which the export spec checks against real pixels.
  it("round-trips every node of every size a real LUT uses", () => {
    for (const size of [2, 3, 8, 17, 25, 32, 33, 64]) {
      const original = marked(size);
      const again = fromAtlas(toAtlas(original));
      expect(again.kind).toBe("3d");
      expect(again.size).toBe(size);
      expect(Array.from(again.data)).toEqual(Array.from(original.data));
    }
  });

  it("round-trips a 1D LUT", () => {
    const original = identityLut1d(64);
    const again = fromAtlas(toAtlas(original));
    expect(again.kind).toBe("1d");
    expect(Array.from(again.data)).toEqual(Array.from(original.data));
  });

  it("carries the domain across", () => {
    const lut = { ...identityLut3d(4), domainMin: [-1, 0, 0] as const, domainMax: [3, 1, 1] as const };
    const atlas = toAtlas(lut);
    expect(atlas.domainMin).toEqual([-1, 0, 0]);
    expect(fromAtlas(atlas).domainMax).toEqual([3, 1, 1]);
  });

  it("samples identically to the LUT it came from", () => {
    const original = marked(17);
    const recovered = fromAtlas(toAtlas(original));
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        const r = i / 20;
        const g = j / 20;
        const b = ((i * 7 + j * 3) % 21) / 20;
        const a = sampleLut(original, r, g, b);
        const c = sampleLut(recovered, r, g, b);
        expect(c.r).toBeCloseTo(a.r, 6);
        expect(c.g).toBeCloseTo(a.g, 6);
        expect(c.b).toBeCloseTo(a.b, 6);
      }
    }
  });

  it("puts node (r,g,b) exactly where the shader looks for it", () => {
    const size = 17;
    const atlas = toAtlas(marked(size));
    const cols = colsFor(size);
    for (const [r, g, b] of [
      [0, 0, 0],
      [16, 0, 0],
      [0, 16, 0],
      [0, 0, 16],
      [5, 11, 9],
      [16, 16, 16],
    ]) {
      // Restated here rather than called, so this is a check on the layout and
      // not a tautology about `atlasNodeOffset`.
      const x = (b % cols) * size + r;
      const y = Math.floor(b / cols) * size + g;
      expect(atlasNodeOffset(atlas, r, g, b)).toBe((y * atlas.width + x) * 4);
    }
  });

  // A 8³ LUT needs 8 blue slices and gets a 3×3 grid, so one tile is
  // padding. Nothing ever fetches it — the blue node index is clamped to
  // `size - 1` first — but the texture must still be fully defined.
  it("writes an opaque alpha everywhere, padding tiles included", () => {
    const atlas = toAtlas(marked(8));
    expect(atlas.cols * atlas.rows).toBeGreaterThan(atlas.size);
    for (let i = 3; i < atlas.data.length; i += 4) {
      expect(atlas.data[i]).toBe(1);
    }
  });
});

describe("the atlas stays inside what a GPU will accept", () => {
  // A single strip of the largest LUT allowed would be 16,384 texels wide and
  // simply fail to allocate. The square-ish grid is what keeps this true.
  it("never exceeds 2048 in either dimension, even at the size cap", () => {
    for (let size = 2; size <= MAX_LUT_3D_SIZE; size++) {
      const atlas = toAtlas(identityLut3d(size));
      expect(atlas.width).toBeLessThanOrEqual(2048);
      expect(atlas.height).toBeLessThanOrEqual(2048);
      // Every blue slice must land inside the allocated grid.
      expect(atlas.cols * atlas.rows).toBeGreaterThanOrEqual(size);
    }
  });
});

describe("uploading", () => {
  it("clamps to 0..255 in the byte path", () => {
    const lut = identityLut3d(2);
    lut.data[0] = -0.5;
    lut.data[1] = 1.5;
    const bytes = toAtlasBytes(toAtlas(lut));
    expect(bytes[0]).toBe(0);
    expect(bytes[1]).toBe(255);
  });

  it("keeps out-of-range values in the half-float path", () => {
    const lut = identityLut3d(2);
    lut.data[0] = -0.5;
    lut.data[1] = 1.5;
    const halves = toAtlasHalf(toAtlas(lut));
    expect(halfToFloat(halves[0])).toBeCloseTo(-0.5, 3);
    expect(halfToFloat(halves[1])).toBeCloseTo(1.5, 3);
  });
});

describe("floatToHalf", () => {
  it("round-trips the values a LUT actually holds to better than 1/2048", () => {
    for (let i = 0; i <= 4096; i++) {
      const v = i / 4096;
      expect(halfToFloat(floatToHalf(v))).toBeCloseTo(v, 3);
    }
  });

  it("keeps signs, zero and small shadow values", () => {
    expect(halfToFloat(floatToHalf(0))).toBe(0);
    expect(halfToFloat(floatToHalf(-0.25))).toBeCloseTo(-0.25, 4);
    // A dark node lands in the subnormal range; flushing it to zero would
    // crush shadow detail in exactly the LUTs where it is noticed.
    expect(halfToFloat(floatToHalf(3e-5))).toBeCloseTo(3e-5, 7);
  });

  it("saturates rather than wrapping on overflow", () => {
    expect(halfToFloat(floatToHalf(1e6))).toBe(Number.POSITIVE_INFINITY);
    expect(halfToFloat(floatToHalf(-1e6))).toBe(Number.NEGATIVE_INFINITY);
  });

  it("keeps NaN a NaN", () => {
    expect(Number.isNaN(halfToFloat(floatToHalf(Number.NaN)))).toBe(true);
  });
});

/** The inverse, written here because only the test needs it. */
function halfToFloat(half: number): number {
  const sign = (half & 0x8000) === 0 ? 1 : -1;
  const exponent = (half >> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  if (exponent === 0) {
    return sign * mantissa * Math.pow(2, -24);
  }
  if (exponent === 0x1f) {
    return mantissa === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  }
  return sign * (1 + mantissa / 1024) * Math.pow(2, exponent - 15);
}
