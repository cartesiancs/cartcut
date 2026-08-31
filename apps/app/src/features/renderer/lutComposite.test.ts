import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ImageElementType, LutRef } from "../../@types/timeline";
import {
  type Lut3d,
  type LutData,
  identityLut3d,
  nodeOffset,
} from "../lut/lutData";
import { sampleLut } from "../lut/sample";
import { renderElement } from "./element";
import {
  resetLutApplier,
  setLutApplier,
  setLutResolver,
  type LutApplier,
} from "./lut/apply";
import { createCpuLutApplier } from "./lut/cpu";
import { resetLayers } from "./surface";
import { imageElement, pixel, scene, type Rgba } from "./testing";

/**
 * These run the **shipping** CPU applier through the **real** `renderElement`,
 * onto a real Skia surface installed by `renderer/testing.ts`. Nothing here is
 * a mock: the applier under test is the one a user without WebGL gets, and the
 * expected values come from `sampleLut`, which the GLSL is independently pinned
 * against in `lut/glsl.test.ts`. Between the two, a grade that is right here is
 * right on the GPU as well.
 */

const SIZE = 40;

/** A cube built by evaluating `f` at every node. */
function cubeFrom(
  size: number,
  f: (r: number, g: number, b: number) => [number, number, number],
): Lut3d {
  const lut = identityLut3d(size);
  const last = size - 1;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const at = nodeOffset(size, r, g, b);
        const [x, y, z] = f(r / last, g / last, b / last);
        lut.data[at] = x;
        lut.data[at + 1] = y;
        lut.data[at + 2] = z;
      }
    }
  }
  return lut;
}

/** Swaps red and blue. Affine, so grid size introduces no error at all. */
const SWAP = cubeFrom(2, (r, g, b) => [b, g, r]);
/** Inverts. Also affine. */
const INVERT = cubeFrom(2, (r, g, b) => [1 - r, 1 - g, 1 - b]);
/** Halves everything. */
const HALF = cubeFrom(2, (r, g, b) => [r / 2, g / 2, b / 2]);
const IDENTITY = identityLut3d(2);

const LUTS: Record<string, LutData> = {
  swap: SWAP,
  invert: INVERT,
  half: HALF,
  identity: IDENTITY,
};

const fillBox =
  (color: string) =>
  (
    ctx: CanvasRenderingContext2D,
    _id: string,
    element: { width: number; height: number },
  ) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, element.width, element.height);
  };

function graded(presetId: string, intensity = 100): LutRef {
  return { presetId, intensity };
}

function draw(
  over: Partial<ImageElementType>,
  color = "#4080c0",
  size = SIZE,
  background = "#000000",
) {
  const { canvas, ctx } = scene(size, size, background);
  const element = imageElement({
    location: { x: 0, y: 0 },
    width: size,
    height: size,
    ...over,
  });
  renderElement(ctx, "el", element, 0, false, fillBox(color));
  return canvas;
}

const centre = (over: Partial<ImageElementType>, color?: string): Rgba =>
  pixel(draw(over, color), size2(), size2());

const size2 = () => Math.floor(SIZE / 2);

/** What `sampleLut` says an 8-bit colour becomes, as 8-bit. */
function expected(lut: LutData, r: number, g: number, b: number, amount = 1) {
  const out = sampleLut(lut, r / 255, g / 255, b / 255);
  return {
    r: Math.round(r * (1 - amount) + out.r * 255 * amount),
    g: Math.round(g * (1 - amount) + out.g * 255 * amount),
    b: Math.round(b * (1 - amount) + out.b * 255 * amount),
  };
}

function expectRgb(actual: Rgba, want: { r: number; g: number; b: number }): void {
  // One step of slack: the canvas round-trips through premultiplied storage.
  expect(Math.abs(actual.r - want.r)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.g - want.g)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.b - want.b)).toBeLessThanOrEqual(1);
}

let restoreApplier: LutApplier | null = null;

beforeEach(() => {
  setLutResolver((presetId) => LUTS[presetId] ?? null);
  restoreApplier = setLutApplier(createCpuLutApplier());
});

afterEach(() => {
  setLutResolver(() => null);
  setLutApplier(restoreApplier);
  resetLutApplier();
  resetLayers();
});

describe("a graded clip", () => {
  it("becomes the colour sampleLut predicts", () => {
    // #4080c0 is 64, 128, 192. Swapping red and blue is a change no rounding
    // could produce by accident.
    expectRgb(centre({ lut: graded("swap") }), expected(SWAP, 64, 128, 192));
    expectRgb(centre({ lut: graded("invert") }), expected(INVERT, 64, 128, 192));
    expectRgb(centre({ lut: graded("half") }), expected(HALF, 64, 128, 192));
  });

  it("is unchanged by an identity LUT", () => {
    const out = centre({ lut: graded("identity") });
    expectRgb(out, { r: 64, g: 128, b: 192 });
  });

  it("grades every visual filetype the same way", () => {
    // The seam is in `renderElement`, above the per-filetype renderers, so
    // this is structural rather than five separate implementations — but it is
    // the promise the panel makes, so it is worth stating.
    for (const filetype of ["image", "video", "shape", "text", "gif"] as const) {
      const out = centre({
        filetype: filetype as ImageElementType["filetype"],
        lut: graded("swap"),
      });
      expectRgb(out, expected(SWAP, 64, 128, 192));
    }
  });
});

describe("intensity", () => {
  it("at 0 leaves the clip alone and costs no layer", () => {
    expectRgb(centre({ lut: graded("invert", 0) }), { r: 64, g: 128, b: 192 });
  });

  it("at 50 lands half way between graded and ungraded", () => {
    expectRgb(
      centre({ lut: graded("invert", 50) }),
      expected(INVERT, 64, 128, 192, 0.5),
    );
  });

  it("at 100 is the full grade", () => {
    expectRgb(
      centre({ lut: graded("invert", 100) }),
      expected(INVERT, 64, 128, 192, 1),
    );
  });

  it("moves monotonically between the two ends", () => {
    let previous = 255;
    for (const intensity of [0, 20, 40, 60, 80, 100]) {
      const out = centre({ lut: graded("half", intensity) });
      expect(out.r).toBeLessThanOrEqual(previous + 1);
      previous = out.r;
    }
  });
});

describe("what a grade does not disturb", () => {
  it("leaves an ungraded clip byte-identical to the pre-feature output", () => {
    const plain = centre({});
    expect(plain).toEqual({ r: 64, g: 128, b: 192, a: 255 });
  });

  it("renders a clip whose LUT is not installed exactly as an ungraded one", () => {
    // The missing-preset contract: a project naming a LUT the recipient does
    // not have opens and plays, ungraded, rather than failing.
    expect(centre({ lut: graded("not-installed") })).toEqual({
      r: 64,
      g: 128,
      b: 192,
      a: 255,
    });
  });

  it("keeps the clip's alpha", () => {
    const canvas = draw({ lut: graded("invert"), opacity: 50 });
    const out = pixel(canvas, size2(), size2());
    // Half-opacity over black: the graded colour, at half strength against the
    // background. What matters is that the *hue* is the graded one — a LUT
    // applied to premultiplied colour would grade a darker input and land
    // somewhere else entirely.
    const full = expected(INVERT, 64, 128, 192);
    expectRgb(out, {
      r: Math.round(full.r / 2),
      g: Math.round(full.g / 2),
      b: Math.round(full.b / 2),
    });
  });

  it("grades the colour the clip is, not the colour opacity made it", () => {
    // The premultiplication trap, stated as a difference. At 50% opacity a
    // white clip is stored as mid-grey; grading that grey through `half` would
    // give ~64, while grading the straight white gives 128 and then halves to
    // 64 on compositing... so the two agree on white. Red is where they part:
    // `swap` on straight (255,0,0) is (0,0,255), and on premultiplied
    // (128,0,0) it would be (0,0,128) — which, composited, is a *quarter*
    // blue rather than a half.
    const canvas = draw({ lut: graded("swap"), opacity: 50 }, "#ff0000");
    const out = pixel(canvas, size2(), size2());
    expect(out.b).toBeGreaterThan(100);
    expect(out.b).toBeLessThan(155);
    expect(out.r).toBeLessThan(4);
  });
});

describe("a grade and a blend together", () => {
  it("grades first, then blends — the order every NLE uses", () => {
    // `multiply` of the graded clip against a white backdrop returns the
    // graded colour unchanged, which isolates the ordering: had the blend run
    // first, the clip would have multiplied ungraded and then been graded.
    const canvas = draw(
      { lut: graded("swap"), blend: "multiply" },
      "#4080c0",
      SIZE,
      "#ffffff",
    );
    expectRgb(pixel(canvas, size2(), size2()), expected(SWAP, 64, 128, 192));
  });

  it("uses one layer for both rather than fighting over it", () => {
    // `surface.ts` hands out one layer per destination canvas. A grade and a
    // blend on the same clip must therefore share it; if the grade asked for a
    // second the first would be cleared out from under the blend.
    const canvas = draw(
      { lut: graded("invert"), blend: "screen" },
      "#202020",
      SIZE,
      "#000000",
    );
    // screen against black is the source, so this is just the graded colour.
    expectRgb(pixel(canvas, size2(), size2()), expected(INVERT, 32, 32, 32));
  });
});

describe("the applier contract", () => {
  it("falls back to drawing ungraded when no applier can be made", () => {
    setLutApplier({
      apply: () => false,
      dispose: () => undefined,
    });
    expect(centre({ lut: graded("invert") })).toEqual({
      r: 64,
      g: 128,
      b: 192,
      a: 255,
    });
  });

  it("hands the applier the resolved LUT and the intensity as a fraction", () => {
    const seen: Array<{ key: string; amount: number; size: number }> = [];
    setLutApplier({
      apply: (_surface, key, lut, amount) => {
        seen.push({ key, amount, size: lut.size });
        return false;
      },
      dispose: () => undefined,
    });
    centre({ lut: graded("swap", 40) });
    expect(seen).toEqual([{ key: "swap", amount: 0.4, size: 2 }]);
  });

  it("is not called at all for a clip with no LUT", () => {
    let calls = 0;
    setLutApplier({
      apply: () => {
        calls++;
        return false;
      },
      dispose: () => undefined,
    });
    centre({});
    centre({ lut: graded("not-installed") });
    centre({ lut: graded("swap", 0) });
    expect(calls).toBe(0);
  });
});
