import { describe, expect, it } from "vitest";

import {
  candidateLayouts,
  type ImagePixels,
  parseImageLut,
} from "./haldImage";
import { LutParseError, nodeOffset } from "./lutData";
import { sampleLut } from "./sample";

/**
 * Paint a cube into an image under one of the two conventions.
 *
 * Deliberately the *encoder*, written independently of `haldImage.ts`'s
 * decoder: if both shared a layout helper, a wrong layout would round-trip
 * happily and prove nothing.
 */
function encode(
  size: number,
  layout: "hald" | "strip",
  grade: (r: number, g: number, b: number) => [number, number, number],
  stripCols = Math.round(Math.sqrt(size)),
): ImagePixels {
  const last = size - 1;
  let width: number;
  let height: number;
  let cols: number;
  if (layout === "hald") {
    const level = Math.round(Math.sqrt(size));
    width = level * level * level;
    height = width;
    cols = 0;
  } else {
    // `cols * rows` must be exactly `size`, so the caller has to pick a
    // divisor — 32 tiles cannot be laid out 6 across.
    cols = stripCols;
    if (size % cols !== 0) {
      throw new Error(`${cols} tiles across does not divide a ${size}³ LUT`);
    }
    width = cols * size;
    height = (size / cols) * size;
  }
  const data = new Uint8ClampedArray(width * height * 4);

  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const [x, y, z] = grade(r / last, g / last, b / last);
        let at: number;
        if (layout === "hald") {
          // Plain row-major pixel order, red fastest.
          at = ((b * size + g) * size + r) * 4;
        } else {
          const tileX = (b % cols) * size;
          const tileY = Math.floor(b / cols) * size;
          at = ((tileY + g) * width + tileX + r) * 4;
        }
        data[at] = Math.round(x * 255);
        data[at + 1] = Math.round(y * 255);
        data[at + 2] = Math.round(z * 255);
        data[at + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

const identity = (r: number, g: number, b: number): [number, number, number] => [
  r,
  g,
  b,
];

/**
 * A grade that is a modest perturbation of identity, as real LUTs are.
 *
 * Deliberately affine and non-saturating in each channel: a clamped ramp has a
 * kink that a 16-node grid can only approximate, and the resulting
 * interpolation error would swamp the thing these tests are actually about,
 * which is whether the *layout* was read correctly. It is also asymmetric
 * across the three channels, so reading it with the axes transposed lands
 * nowhere near the right answer.
 */
const warm = (r: number, g: number, b: number): [number, number, number] => [
  r * 0.9 + 0.05,
  g * 0.98,
  b * 0.8,
];

describe("candidateLayouts", () => {
  // The fact the content heuristic rests on: 512×512 is genuinely both, and
  // 1024×32 is only ever a strip.
  it("reads 512×512 as both a Hald and a strip", () => {
    const kinds = candidateLayouts(512, 512).map((l) => l.kind);
    expect(kinds).toContain("hald");
    expect(kinds).toContain("strip");
    expect(candidateLayouts(512, 512).every((l) => l.size === 64)).toBe(true);
  });

  it("reads 1024×32 as a strip only", () => {
    const layouts = candidateLayouts(1024, 32);
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toEqual({ kind: "strip", size: 32, cols: 32, rows: 1 });
  });

  it("reads 64×64 as both, for a 16³ cube", () => {
    expect(candidateLayouts(64, 64).map((l) => l.size)).toEqual([16, 16]);
  });

  it("offers nothing for dimensions that are not a LUT", () => {
    expect(candidateLayouts(1920, 1080)).toEqual([]);
    expect(candidateLayouts(500, 500)).toEqual([]);
    expect(candidateLayouts(0, 0)).toEqual([]);
  });
});

describe("parseImageLut", () => {
  it("reads a Hald CLUT", () => {
    const lut = parseImageLut(encode(16, "hald", warm));
    expect(lut.size).toBe(16);
    // The far red node: `warm` sends r=1 to 0.95 and leaves blue at 0.
    const at = nodeOffset(16, 15, 0, 0);
    expect(lut.data[at]).toBeCloseTo(0.95, 2);
    expect(lut.data[at + 2]).toBeCloseTo(0, 2);
  });

  it("reads a 32-across tile strip — the 1024×32 layout", () => {
    const image = encode(32, "strip", warm, 32);
    expect([image.width, image.height]).toEqual([1024, 32]);
    const lut = parseImageLut(image);
    expect(lut.size).toBe(32);
    const out = sampleLut(lut, 0.5, 0.5, 0.5);
    expect(out.r).toBeCloseTo(0.5, 2);
    expect(out.b).toBeCloseTo(0.4, 2);
  });

  // The ambiguity, settled. Both images are 64×64 and hold a 16³ cube; only
  // the layout differs, and the reader has nothing but the pixels to go on.
  it("picks the right reading of an ambiguous square image, both ways", () => {
    for (const layout of ["hald", "strip"] as const) {
      const lut = parseImageLut(encode(16, layout, warm, 4));
      for (const [r, g, b] of [
        [0.25, 0.5, 0.75],
        [0.9, 0.1, 0.4],
        [0, 1, 0],
      ]) {
        const out = sampleLut(lut, r, g, b);
        const [wr, wg, wb] = warm(r, g, b);
        // 8-bit source, so a node carries up to 1/510 of error.
        expect(out.r).toBeCloseTo(wr, 2);
        expect(out.g).toBeCloseTo(wg, 2);
        expect(out.b).toBeCloseTo(wb, 2);
      }
    }
  });

  it("reads an identity image as an identity LUT", () => {
    const lut = parseImageLut(encode(16, "hald", identity));
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const out = sampleLut(lut, v, v, v);
      expect(out.r).toBeCloseTo(v, 2);
    }
  });

  it("refuses an image whose dimensions are not a LUT", () => {
    const image: ImagePixels = {
      width: 1920,
      height: 1080,
      data: new Uint8ClampedArray(1920 * 1080 * 4),
    };
    expect(() => parseImageLut(image)).toThrow(LutParseError);
    expect(() => parseImageLut(image)).toThrow(/1920×1080/);
  });
});
