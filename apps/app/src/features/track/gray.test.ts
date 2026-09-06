import { describe, expect, it } from "vitest";
import {
  buildPyramid,
  downsample,
  pyramidLevelsFor,
  sampleBilinear,
  toGray,
  type GrayImage,
} from "./gray";
import { makeTexture } from "./testFixtures";

describe("toGray", () => {
  it("weights the channels by Rec. 601", () => {
    const image = toGray({
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
      width: 2,
      height: 1,
    });

    expect(image.data[0]).toBeCloseTo(0.299 * 255, 5);
    expect(image.data[1]).toBeCloseTo(0.587 * 255, 5);
  });

  it("carries the size through", () => {
    const image = toGray({
      data: new Uint8ClampedArray(4 * 3 * 2),
      width: 3,
      height: 2,
    });

    expect(image.width).toBe(3);
    expect(image.height).toBe(2);
    expect(image.data).toHaveLength(6);
  });
});

describe("sampleBilinear", () => {
  const image: GrayImage = {
    data: Float32Array.from([0, 100, 200, 300]),
    width: 2,
    height: 2,
  };

  it("returns the pixel on integer coordinates", () => {
    expect(sampleBilinear(image, 0, 0)).toBe(0);
    expect(sampleBilinear(image, 1, 1)).toBe(300);
  });

  it("interpolates between them", () => {
    expect(sampleBilinear(image, 0.5, 0)).toBeCloseTo(50, 5);
    expect(sampleBilinear(image, 0.5, 0.5)).toBeCloseTo(150, 5);
  });

  it("clamps outside the frame rather than wrapping", () => {
    // Wrapping would make the far edge a plausible match for something leaving
    // the near one, which is the one mistake that turns a lost track into a
    // confident wrong one.
    expect(sampleBilinear(image, -5, -5)).toBe(0);
    expect(sampleBilinear(image, 99, 99)).toBe(300);
  });
});

describe("downsample", () => {
  it("halves each side", () => {
    const half = downsample(makeTexture(64, 48));

    expect(half.width).toBe(32);
    expect(half.height).toBe(24);
  });

  it("leaves a flat picture flat", () => {
    const flat: GrayImage = {
      data: new Float32Array(16 * 16).fill(77),
      width: 16,
      height: 16,
    };

    const half = downsample(flat);

    for (const value of half.data) {
      expect(value).toBeCloseTo(77, 4);
    }
  });

  it("low-passes: the half-size picture varies less than a raw decimation", () => {
    // The reason for the blur. A decimated checkerboard aliases into a picture
    // with *more* contrast than the original; a filtered one has less.
    const size = 32;
    const checker: GrayImage = {
      data: new Float32Array(size * size),
      width: size,
      height: size,
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        checker.data[y * size + x] = (x + y) % 2 === 0 ? 0 : 255;
      }
    }

    const half = downsample(checker);

    let min = Infinity;
    let max = -Infinity;
    for (const value of half.data) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    expect(max - min).toBeLessThan(60);
  });
});

describe("pyramidLevelsFor", () => {
  it("stops before a level is smaller than the correlation window", () => {
    expect(pyramidLevelsFor(64, 64)).toBe(2);
    expect(pyramidLevelsFor(32, 32)).toBe(1);
    expect(pyramidLevelsFor(1920, 1080)).toBe(4);
  });

  it("never goes past the ceiling it is given", () => {
    expect(pyramidLevelsFor(1920, 1080, 2)).toBe(2);
  });
});

describe("buildPyramid", () => {
  it("puts the original at level 0 and halves from there", () => {
    const source = makeTexture(128, 96);
    const pyramid = buildPyramid(source, 3);

    expect(pyramid).toHaveLength(3);
    expect(pyramid[0]).toBe(source);
    expect(pyramid[1].width).toBe(64);
    expect(pyramid[2].width).toBe(32);
  });
});
