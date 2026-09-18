import { afterEach, describe, expect, it } from "vitest";
import type { CropRect, ImageElementType, MaskType } from "../../@types/timeline";
import { defaultMask } from "../mask/maskShape";
import { renderElement } from "./element";
import { resetLayers } from "./surface";
import { imageElement, pixel, scene, type Rgba } from "./testing";

/**
 * A crop meeting every other thing that happens inside `renderElement`.
 *
 * Drives the **real** isolation layer, the real mask composite and the real
 * blend, on a real Skia surface. The interesting cases are the ones where two
 * operations could be applied in either order and only one order is right; a
 * suite that tested the crop on its own would pass under both.
 */

const SIZE = 40;
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };

const RED = "#ff0000";
const BLUE = "#0000ff";
const GREEN = "#00ff00";
const WHITE = "#ffffff";

const rgb = (hex: string): Rgba => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
  a: 255,
});

/** Four vertical stripes across the box: red, blue, green, white. */
const stripes = (
  ctx: CanvasRenderingContext2D,
  _id: string,
  element: { width: number; height: number },
) => {
  const w = element.width / 4;
  for (const [index, colour] of [RED, BLUE, GREEN, WHITE].entries()) {
    ctx.fillStyle = colour;
    ctx.fillRect(index * w, 0, w, element.height);
  }
};

const flat =
  (colour: string) =>
  (
    ctx: CanvasRenderingContext2D,
    _id: string,
    element: { width: number; height: number },
  ) => {
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, element.width, element.height);
  };

const rect = (x: number, y: number, width: number, height: number): CropRect => ({
  x,
  y,
  width,
  height,
});

function draw(
  over: Partial<ImageElementType> = {},
  renderFunction: any = stripes,
  background = "#000000",
) {
  const { canvas, ctx } = scene(SIZE, SIZE, background);
  const element = imageElement({
    location: { x: 0, y: 0 },
    width: SIZE,
    height: SIZE,
    ...over,
  });
  renderElement(ctx, "el", element, 0, false, renderFunction);
  return canvas;
}

/** The colour at the centre of each quarter of the box, left to right. */
function quarters(canvas: ReturnType<typeof draw>): Rgba[] {
  return [5, 15, 25, 35].map((x) => pixel(canvas, x, SIZE / 2));
}

afterEach(() => {
  resetLayers();
});

// --------------------------------------------------------------- crop x mirror

describe("crop and mirror", () => {
  it("draws the stripes as authored with neither set", () => {
    expect(quarters(draw())).toEqual([RED, BLUE, GREEN, WHITE].map(rgb));
  });

  it("flips the kept picture, not the frame under it", () => {
    // Keep the left half: red then blue, filling the box. A horizontal flip
    // must show blue then red. If the flip were applied after the crop map
    // instead of before it, the crop would land on the *flipped* frame and the
    // box would hold white then green.
    const canvas = draw({ crop: rect(0, 0, 0.5, 1), flipH: true } as any);
    expect(quarters(canvas)).toEqual([BLUE, BLUE, RED, RED].map(rgb));
  });

  it("agrees with the uncropped flip on the region they share", () => {
    // Flipped and uncropped, the stripes read white, green, blue, red. Keeping
    // the left half of the *source* keeps red and blue, which the flip then
    // puts on the right of the box: blue, red.
    expect(quarters(draw({ flipH: true }))).toEqual(
      [WHITE, GREEN, BLUE, RED].map(rgb),
    );
  });

  it("flips vertically without disturbing the crop's horizontal framing", () => {
    const canvas = draw({ crop: rect(0.5, 0, 0.5, 1), flipV: true } as any);
    expect(quarters(canvas)).toEqual([GREEN, GREEN, WHITE, WHITE].map(rgb));
  });

  it("is unchanged by a flip when the crop is centred, as symmetry demands", () => {
    const centred = rect(0.25, 0, 0.5, 1);
    const plain = quarters(draw({ crop: centred } as any));
    const flipped = quarters(draw({ crop: centred, flipH: true } as any));
    expect(plain).toEqual([BLUE, BLUE, GREEN, GREEN].map(rgb));
    expect(flipped).toEqual([...plain].reverse());
  });
});

// ----------------------------------------------------------------- crop x mask

/** A hard-edged mask over the left half of the element box. */
function leftHalfMask(over: Partial<MaskType> = {}): MaskType {
  return {
    ...defaultMask("rectangle"),
    location: { x: 25, y: 50 },
    size: { width: 50, height: 100 },
    feather: 0,
    ...over,
  };
}

describe("crop and mask", () => {
  it("cuts the cropped picture, and cuts it in box space", () => {
    // Crop keeps the right half (green, white); the mask keeps the left half of
    // the *box*, which is now the green stripe. The white half is cut away.
    const canvas = draw({
      crop: rect(0.5, 0, 0.5, 1),
      mask: leftHalfMask(),
    } as any);
    expect(pixel(canvas, 5, 20)).toEqual(rgb(GREEN));
    expect(pixel(canvas, 15, 20)).toEqual(rgb(GREEN));
    expect(pixel(canvas, 30, 20)).toEqual(BLACK);
  });

  it("leaves the mask where it was when the crop is removed", () => {
    const canvas = draw({ mask: leftHalfMask() } as any);
    expect(pixel(canvas, 5, 20)).toEqual(rgb(RED));
    expect(pixel(canvas, 15, 20)).toEqual(rgb(BLUE));
    expect(pixel(canvas, 30, 20)).toEqual(BLACK);
  });

  it("still cuts through the layer path rather than falling back", () => {
    // An inverted mask can only be honoured on the isolation layer, so this
    // also proves the crop did not force the degraded branch.
    const canvas = draw({
      crop: rect(0.5, 0, 0.5, 1),
      mask: leftHalfMask({ invert: true }),
    } as any);
    expect(pixel(canvas, 5, 20)).toEqual(BLACK);
    expect(pixel(canvas, 30, 20)).toEqual(rgb(WHITE));
  });
});

// ---------------------------------------------------------------- crop x blend

describe("crop and blend", () => {
  it("blends the cropped picture with what is under it", () => {
    // `multiply` against a white ground leaves the clip's own colour; the crop
    // decides which colour that is.
    const canvas = draw(
      { crop: rect(0.5, 0, 0.5, 1), blend: "multiply" } as any,
      stripes,
      "#ffffff",
    );
    expect(quarters(canvas)).toEqual([GREEN, GREEN, WHITE, WHITE].map(rgb));
  });

  it("blends only the kept region, leaving the rest of the ground alone", () => {
    // A clip half the size of the scene, cropped, blended: outside its box the
    // ground must be untouched.
    const { canvas, ctx } = scene(SIZE, SIZE, "#ffffff");
    renderElement(
      ctx,
      "el",
      imageElement({
        location: { x: 0, y: 0 },
        width: SIZE / 2,
        height: SIZE,
        crop: rect(0, 0, 0.25, 1),
        blend: "multiply",
      } as any),
      0,
      false,
      stripes as any,
    );
    expect(pixel(canvas, 5, 20)).toEqual(rgb(RED));
    expect(pixel(canvas, 30, 20)).toEqual(rgb(WHITE));
  });
});

// ----------------------------------------------------- crop x grade and adjust

describe("crop and the colour pipeline", () => {
  it("grades the cropped picture, on the isolation layer", () => {
    // Saturation at its floor turns the kept stripe grey. The crop chooses the
    // stripe; the adjustment must reach it rather than the discarded frame.
    const canvas = draw(
      { crop: rect(0, 0, 0.25, 1), adjust: { saturation: -100 } } as any,
    );
    const out = pixel(canvas, SIZE / 2, SIZE / 2);
    expect(out.r).toBe(out.g);
    expect(out.g).toBe(out.b);
    expect(out.r).toBeGreaterThan(0);
  });

  it("leaves an unadjusted crop on the untouched path", () => {
    const canvas = draw({ crop: rect(0, 0, 0.25, 1) } as any, flat(RED));
    expect(pixel(canvas, SIZE / 2, SIZE / 2)).toEqual(rgb(RED));
  });

  it("dims with opacity and crops independently of it", () => {
    const canvas = draw(
      { crop: rect(0.75, 0, 0.25, 1), opacity: 50 } as any,
      stripes,
      "#000000",
    );
    const out = pixel(canvas, SIZE / 2, SIZE / 2);
    // The white stripe at half opacity over black.
    expect(out.r).toBeGreaterThan(110);
    expect(out.r).toBeLessThan(145);
    expect(out.r).toBe(out.g);
    expect(out.g).toBe(out.b);
  });
});

// ------------------------------------------------------- the transform reaches

describe("the crop transform reaches the renderer", () => {
  it("is on the context by the time the per-type renderer is called", () => {
    // The WebGL filter pipeline and the GIF renderer both read the context's
    // transform rather than being handed a rect, so what matters is that the
    // transform is installed before the call. Captured from a stand-in.
    let seen: DOMMatrix | null = null;
    const { ctx } = scene(SIZE, SIZE, "#000000");
    renderElement(
      ctx,
      "el",
      imageElement({
        location: { x: 0, y: 0 },
        width: SIZE,
        height: SIZE,
        crop: rect(0.25, 0.5, 0.5, 0.25),
      } as any),
      0,
      false,
      ((c: CanvasRenderingContext2D) => {
        seen = c.getTransform();
      }) as any,
    );

    expect(seen).not.toBeNull();
    // scale(1/0.5, 1/0.25) then translate(-0.25*40, -0.5*40)
    expect(seen!.a).toBeCloseTo(2, 9);
    expect(seen!.d).toBeCloseTo(4, 9);
    expect(seen!.e).toBeCloseTo(-20, 9);
    expect(seen!.f).toBeCloseTo(-80, 9);
  });

  it("leaves the context alone for an uncropped clip", () => {
    let seen: DOMMatrix | null = null;
    const { ctx } = scene(SIZE, SIZE, "#000000");
    renderElement(
      ctx,
      "el",
      imageElement({ location: { x: 0, y: 0 }, width: SIZE, height: SIZE }),
      0,
      false,
      ((c: CanvasRenderingContext2D) => {
        seen = c.getTransform();
      }) as any,
    );
    expect(seen!.a).toBe(1);
    expect(seen!.d).toBe(1);
    expect(seen!.e).toBe(0);
    expect(seen!.f).toBe(0);
  });

  it("restores the context, so the outline is drawn in box space", () => {
    const { ctx } = scene(SIZE, SIZE, "#000000");
    const before = ctx.getTransform();
    renderElement(
      ctx,
      "el",
      imageElement({
        location: { x: 0, y: 0 },
        width: SIZE,
        height: SIZE,
        crop: rect(0.25, 0.25, 0.5, 0.5),
      } as any),
      0,
      true,
      stripes as any,
    );
    const after = ctx.getTransform();
    expect(after.a).toBe(before.a);
    expect(after.d).toBe(before.d);
    expect(after.e).toBe(before.e);
    expect(after.f).toBe(before.f);
  });
});
