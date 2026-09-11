import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ColorAdjustments,
  ImageElementType,
  LutRef,
} from "../../@types/timeline";
import { clearToneLutCache } from "../adjust/bake";
import { fadePixel } from "../adjust/finishMath";
import { toneStep } from "../adjust/tone";
import { type Lut3d, type LutData, identityLut3d, nodeOffset } from "../lut/lutData";
import { sampleLut } from "../lut/sample";
import {
  resetFinishApplier,
  setFinishApplier,
  type FinishApplier,
} from "./adjust/apply";
import { createCpuFinishApplier } from "./adjust/cpu";
import { renderElement } from "./element";
import {
  resetLutApplier,
  setLutApplier,
  setLutResolver,
  type LutApplier,
} from "./lut/apply";
import { createCpuLutApplier } from "./lut/cpu";
import { resetLayers, setSurfaceFactory, type SurfaceFactory } from "./surface";
import { imageElement, pixel, scene, type Rgba } from "./testing";

/**
 * The shipping CPU appliers — tone through the LUT applier, finish through its
 * own — driven through the real `renderElement` onto real Skia surfaces, the
 * arrangement `lutComposite.test.ts` uses. Expected values come from
 * `toneStep` and `finishMath`, which is what the baked table and the GLSL are
 * each pinned against.
 */

const SIZE = 40;
const MID = SIZE / 2;

function cubeFrom(
  size: number,
  f: (r: number, g: number, b: number) => [number, number, number],
): Lut3d {
  const lut = identityLut3d(size);
  const last = size - 1;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const at = nodeOffset(size, r, g, b);
        const [x, y, z] = f(r / last, g / last, b / last);
        lut.data[at] = x;
        lut.data[at + 1] = y;
        lut.data[at + 2] = z;
      }
  return lut;
}

const SWAP = cubeFrom(2, (r, g, b) => [b, g, r]);
const INVERT = cubeFrom(2, (r, g, b) => [1 - r, 1 - g, 1 - b]);
const LUTS: Record<string, LutData> = { swap: SWAP, invert: INVERT };

const fillBox =
  (color: string) =>
  (ctx: CanvasRenderingContext2D, _id: string, element: { width: number; height: number }) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, element.width, element.height);
  };

/** Two flat halves, dark on the left and light on the right — an edge to sharpen. */
const edgeBox = (ctx: CanvasRenderingContext2D, _id: string, element: { width: number; height: number }) => {
  ctx.fillStyle = "#646464";
  ctx.fillRect(0, 0, element.width / 2, element.height);
  ctx.fillStyle = "#b4b4b4";
  ctx.fillRect(element.width / 2, 0, element.width / 2, element.height);
};

function draw(
  over: Partial<ImageElementType> & { adjust?: ColorAdjustments },
  options: {
    color?: string;
    size?: number;
    background?: string;
    cursor?: number;
    render?: Parameters<typeof renderElement>[5];
    scale?: number;
  } = {},
) {
  const size = options.size ?? SIZE;
  const scale = options.scale ?? 1;
  const { canvas, ctx } = scene(size * scale, size * scale, options.background ?? "#000000");
  ctx.scale(scale, scale);
  const element = imageElement({
    location: { x: 0, y: 0 },
    width: size,
    height: size,
    ...over,
  } as Partial<ImageElementType>);
  renderElement(
    ctx,
    "el",
    element,
    options.cursor ?? 0,
    false,
    options.render ?? fillBox(options.color ?? "#4080c0"),
  );
  return canvas;
}

const at = (over: Parameters<typeof draw>[0], x = MID, y = MID, options = {}) =>
  pixel(draw(over, options), x, y);

function tone(values: ColorAdjustments, r: number, g: number, b: number) {
  const out = toneStep(values)([r / 255, g / 255, b / 255]);
  return { r: Math.round(out[0] * 255), g: Math.round(out[1] * 255), b: Math.round(out[2] * 255) };
}

function lut(table: LutData, c: { r: number; g: number; b: number }) {
  const out = sampleLut(table, c.r / 255, c.g / 255, c.b / 255);
  return { r: Math.round(out.r * 255), g: Math.round(out.g * 255), b: Math.round(out.b * 255) };
}

function close(actual: Rgba, want: { r: number; g: number; b: number }, slack = 2): void {
  // Two steps: one for the baked table (held to one by `bake.test.ts`), one
  // for the canvas's premultiplied round trip.
  expect(Math.abs(actual.r - want.r), `r ${actual.r} vs ${want.r}`).toBeLessThanOrEqual(slack);
  expect(Math.abs(actual.g - want.g), `g ${actual.g} vs ${want.g}`).toBeLessThanOrEqual(slack);
  expect(Math.abs(actual.b - want.b), `b ${actual.b} vs ${want.b}`).toBeLessThanOrEqual(slack);
}

let restoreLut: LutApplier | null = null;
let restoreFinish: FinishApplier | null = null;

beforeEach(() => {
  setLutResolver((presetId) => LUTS[presetId] ?? null);
  restoreLut = setLutApplier(createCpuLutApplier());
  restoreFinish = setFinishApplier(createCpuFinishApplier());
});

afterEach(() => {
  setLutResolver(() => null);
  setLutApplier(restoreLut);
  setFinishApplier(restoreFinish);
  resetLutApplier();
  resetFinishApplier();
  resetLayers();
  clearToneLutCache();
});

describe("an unadjusted clip", () => {
  it("is byte-identical to the pre-feature output", () => {
    const plain = { r: 64, g: 128, b: 192, a: 255 };
    expect(at({})).toEqual(plain);
    expect(at({ adjust: {} })).toEqual(plain);
    expect(at({ adjust: { exposure: 0, sharpen: 0, vignette: 0 } })).toEqual(plain);
  });

  it("costs no layer", () => {
    let layers = 0;
    const counting: SurfaceFactory = (w, h) => {
      layers++;
      return previous(w, h);
    };
    const previous = setSurfaceFactory(counting);
    try {
      at({});
      at({ adjust: { contrast: 0 } });
      expect(layers).toBe(0);
      at({ adjust: { contrast: 10 } });
      expect(layers).toBeGreaterThan(0);
    } finally {
      setSurfaceFactory(previous);
    }
  });

  it("never reaches either applier", () => {
    let tone = 0;
    let finish = 0;
    setLutApplier({ apply: () => (tone++, false), dispose: () => undefined });
    setFinishApplier({ apply: () => (finish++, false), dispose: () => undefined });
    at({});
    at({ adjust: { exposure: 0 } });
    expect(tone).toBe(0);
    expect(finish).toBe(0);
  });
});

describe("the tone controls", () => {
  const cases: ColorAdjustments[] = [
    { exposure: 50 },
    { exposure: -60 },
    { temperature: 70 },
    { tint: -40 },
    { saturation: -100 },
    { saturation: 60 },
    { contrast: 80 },
    { highlights: -50, shadows: 50 },
    { whites: 40, blacks: -40 },
    { brilliance: 70 },
    { temperature: 30, exposure: 20, contrast: 20, saturation: 20 },
  ];

  for (const values of cases) {
    it(`${JSON.stringify(values)} lands where toneStep says`, () => {
      close(at({ adjust: values }), tone(values, 64, 128, 192));
    });
  }

  it("adjust every visual filetype alike", () => {
    for (const filetype of ["image", "video", "shape", "text", "gif"] as const) {
      close(
        at({ filetype: filetype as ImageElementType["filetype"], adjust: { exposure: 40 } }),
        tone({ exposure: 40 }, 64, 128, 192),
      );
    }
  });

  it("run before the clip's LUT — correct the shot, then apply the look", () => {
    const values: ColorAdjustments = { temperature: 80 };
    const out = at({ adjust: values, lut: { presetId: "swap", intensity: 100 } as LutRef });
    const toneThenLut = lut(SWAP, tone(values, 64, 128, 192));
    const lutThenTone = tone(values, 192, 128, 64);
    // The two orders must be far enough apart for the check to mean anything.
    expect(Math.abs(toneThenLut.r - lutThenTone.r)).toBeGreaterThan(8);
    close(out, toneThenLut);
  });

  it("grade the colour the clip is, not the colour opacity made it", () => {
    const values: ColorAdjustments = { exposure: 60 };
    const out = at({ adjust: values, opacity: 50 });
    const full = tone(values, 64, 128, 192);
    close(out, { r: Math.round(full.r / 2), g: Math.round(full.g / 2), b: Math.round(full.b / 2) });
  });
});

describe("the finish", () => {
  it("fade lands where fadePixel says", () => {
    const out = at({ adjust: { fade: 100 } });
    const f = fadePixel([64 / 255, 128 / 255, 192 / 255], 1);
    close(out, { r: Math.round(f[0] * 255), g: Math.round(f[1] * 255), b: Math.round(f[2] * 255) }, 1);
  });

  it("runs after the clip's LUT, so fade lifts the graded blacks", () => {
    // Black through `invert` is white; fade after that pulls white down. Fade
    // before would lift black, which `invert` then pushes down from white.
    const out = at(
      { adjust: { fade: 100 }, lut: { presetId: "invert", intensity: 100 } as LutRef },
      MID,
      MID,
      { color: "#000000" },
    );
    const lutThenFade = Math.round(fadePixel([1, 1, 1], 1)[0] * 255);
    const fadeThenLut = Math.round((1 - fadePixel([0, 0, 0], 1)[0]) * 255);
    expect(Math.abs(lutThenFade - fadeThenLut)).toBeGreaterThan(8);
    expect(Math.abs(out.r - lutThenFade)).toBeLessThanOrEqual(1);
  });

  it("leaves a flat colour alone under sharpen and clarity", () => {
    close(at({ adjust: { sharpen: 100, clarity: 100 } }), { r: 64, g: 128, b: 192 }, 1);
  });

  it("sharpen steepens an edge and leaves the flat parts alone", () => {
    const plain = draw({}, { render: edgeBox });
    const sharp = draw({ adjust: { sharpen: 100 } }, { render: edgeBox });
    // Either side of the edge at x = 20.
    expect(pixel(sharp, 19, MID).r).toBeLessThan(pixel(plain, 19, MID).r - 10);
    expect(pixel(sharp, 20, MID).r).toBeGreaterThan(pixel(plain, 20, MID).r + 10);
    // Well away from it, nothing moves.
    expect(pixel(sharp, 5, MID)).toEqual(pixel(plain, 5, MID));
    expect(pixel(sharp, 35, MID)).toEqual(pixel(plain, 35, MID));
  });

  it("clarity adds contrast across an edge", () => {
    const plain = draw({}, { render: edgeBox, size: 80 });
    const clear = draw({ adjust: { clarity: 100 } }, { render: edgeBox, size: 80 });
    expect(pixel(clear, 38, 40).r).toBeLessThan(pixel(plain, 38, 40).r);
    expect(pixel(clear, 41, 40).r).toBeGreaterThan(pixel(plain, 41, 40).r);
  });

  it("does not sharpen a dark halo onto the clip's own border", () => {
    // A light clip on a transparent layer: the blur is alpha-weighted, so the
    // transparent surroundings are not an edge to the clip.
    const plain = draw(
      { location: { x: 10, y: 10 }, width: 20, height: 20 },
      { color: "#b4b4b4" },
    );
    const sharp = draw(
      { location: { x: 10, y: 10 }, width: 20, height: 20, adjust: { sharpen: 100, clarity: 100 } },
      { color: "#b4b4b4" },
    );
    expect(pixel(sharp, 10, 20)).toEqual(pixel(plain, 10, 20));
    expect(pixel(sharp, 29, 20)).toEqual(pixel(plain, 29, 20));
  });

  it("vignette darkens the clip's corners and leaves its centre", () => {
    const out = draw({ adjust: { vignette: 100 } }, { color: "#808080" });
    expect(pixel(out, MID, MID).r).toBe(128);
    expect(pixel(out, 1, 1).r).toBeLessThan(64);
  });

  it("negative vignette lightens instead", () => {
    const out = draw({ adjust: { vignette: -100 } }, { color: "#808080" });
    expect(pixel(out, 1, 1).r).toBeGreaterThan(200);
  });

  it("vignette follows the clip's box, not the frame", () => {
    const out = draw(
      { location: { x: 10, y: 10 }, width: 20, height: 20, adjust: { vignette: 100 } },
      { color: "#808080" },
    );
    expect(pixel(out, 20, 20).r).toBe(128);
    expect(pixel(out, 10, 10).r).toBeLessThan(64);
    // Outside the clip the layer is empty, and the frame shows through untouched.
    expect(pixel(out, 2, 2)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });

  it("vignette turns with a rotated clip", () => {
    // A wide box, turned a quarter: its corners are no longer at the frame's.
    const out = draw(
      {
        location: { x: 0, y: 10 },
        width: 40,
        height: 20,
        rotation: 90,
        adjust: { vignette: 100 },
      },
      { color: "#808080" },
    );
    // The rotated box is 20 wide and 40 tall, centred on (20, 20).
    expect(pixel(out, 20, 20).r).toBe(128);
    expect(pixel(out, 11, 1).r).toBeLessThan(80);
  });

  it("looks the same at any zoom — distances are the clip's, not the layer's", () => {
    const values: ColorAdjustments = { vignette: 80, fade: 50 };
    const one = draw({ adjust: values }, { color: "#808080" });
    const two = draw({ adjust: values }, { color: "#808080", scale: 2 });
    for (const [x, y] of [
      [20, 20],
      [3, 3],
      [10, 30],
      [36, 5],
    ]) {
      const a = pixel(one, x, y);
      const b = pixel(two, 2 * x + 1, 2 * y + 1);
      expect(Math.abs(a.r - b.r), `(${x}, ${y})`).toBeLessThanOrEqual(3);
    }
  });

  it("grain is the same on the same frame and different on the next", () => {
    const values: ColorAdjustments = { particles: 100 };
    const signature = (cursor: number) => {
      const canvas = draw({ adjust: values }, { color: "#808080", cursor });
      return Array.from({ length: 20 }, (_, i) => pixel(canvas, i * 2, 17).r).join(",");
    };
    expect(signature(1000)).toBe(signature(1000));
    expect(signature(1000)).not.toBe(signature(1033));
  });

  it("grain moves pixels but not the picture's average", () => {
    const canvas = draw({ adjust: { particles: 100 } }, { color: "#808080" });
    let sum = 0;
    let moved = 0;
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const v = pixel(canvas, x, y).r;
        sum += v;
        if (v !== 128) moved++;
      }
    expect(moved).toBeGreaterThan(SIZE * SIZE * 0.5);
    expect(Math.abs(sum / (SIZE * SIZE) - 128)).toBeLessThan(3);
  });
});

describe("the two halves together", () => {
  it("apply tone even when the finish applier cannot run", () => {
    setFinishApplier({ apply: () => false, dispose: () => undefined });
    close(at({ adjust: { exposure: 50, fade: 80 } }), tone({ exposure: 50 }, 64, 128, 192));
  });

  it("do not bake a table for a clip whose only adjustment is a finish", () => {
    const seen: string[] = [];
    setLutApplier({
      apply: (_surface, key) => {
        seen.push(key);
        return false;
      },
      dispose: () => undefined,
    });
    at({ adjust: { sharpen: 40, vignette: 20 } });
    expect(seen).toEqual([]);
  });

  it("hand the LUT applier the tone table under an adjust: key, at full strength", () => {
    const seen: Array<{ key: string; amount: number; size: number }> = [];
    setLutApplier({
      apply: (_surface, key, table, amount) => {
        seen.push({ key, amount, size: table.size });
        return false;
      },
      dispose: () => undefined,
    });
    at({ adjust: { exposure: 25 } });
    expect(seen).toHaveLength(1);
    expect(seen[0].key).toMatch(/^adjust:/);
    expect(seen[0].amount).toBe(1);
    expect(seen[0].size).toBe(33);
  });

  it("stay on inside a transition, where the blend is suspended", () => {
    const element = imageElement({
      location: { x: 0, y: 0 },
      width: SIZE,
      height: SIZE,
      adjust: { exposure: 50 },
    } as Partial<ImageElementType>);
    const { canvas, ctx } = scene(SIZE, SIZE, "#000000");
    renderElement(ctx, "el", element, 0, false, fillBox("#4080c0"), {
      elements: { el: element },
      isolated: true,
    });
    close(pixel(canvas, MID, MID), tone({ exposure: 50 }, 64, 128, 192));
  });

  it("compose with a blend — adjust first, then meet the scene", () => {
    // `multiply` over white returns the source unchanged, isolating the order.
    const out = at({ adjust: { exposure: 50 }, blend: "multiply" }, MID, MID, {
      background: "#ffffff",
    });
    close(out, tone({ exposure: 50 }, 64, 128, 192));
  });
});
