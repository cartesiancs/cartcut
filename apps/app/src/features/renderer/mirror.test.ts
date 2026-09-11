import { afterEach, describe, expect, it } from "vitest";
import type { ImageElementType, MaskType } from "../../@types/timeline";
import { defaultMask } from "../mask/maskShape";
import { renderElement } from "./element";
import { resetLayers } from "./surface";
import { imageElement, inkBounds, pixel, scene, type Rgba } from "./testing";

/**
 * A mirror through the real `renderElement`, asserted on pixels.
 *
 * The renderer below paints a picture that is different in every quadrant, so
 * a flip on the wrong axis — or a flip about the wrong point, which pushes the
 * picture out of its box — is a wrong colour at a known pixel.
 */

const SIZE = 40;
const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };
const BLUE: Rgba = { r: 0, g: 0, b: 255, a: 255 };
const GREEN: Rgba = { r: 0, g: 255, b: 0, a: 255 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };

/** Top-left red, top-right blue, bottom-left green, bottom-right white. */
const quadrants = (
  ctx: CanvasRenderingContext2D,
  _id: string,
  element: { width: number; height: number },
) => {
  const w = element.width / 2;
  const h = element.height / 2;
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(w, 0, w, h);
  ctx.fillStyle = "#00ff00";
  ctx.fillRect(0, h, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(w, h, w, h);
};

function draw(over: Partial<ImageElementType> = {}, size = SIZE) {
  const { canvas, ctx } = scene(size, size, "#000000");
  const element = imageElement({
    location: { x: 0, y: 0 },
    width: size,
    height: size,
    ...over,
  });
  renderElement(ctx, "el", element, 0, false, quadrants);
  return canvas;
}

/** The colour at the centre of each quadrant: TL, TR, BL, BR. */
function corners(canvas: ReturnType<typeof draw>): Rgba[] {
  return [
    pixel(canvas, 10, 10),
    pixel(canvas, 30, 10),
    pixel(canvas, 10, 30),
    pixel(canvas, 30, 30),
  ];
}

afterEach(() => {
  resetLayers();
});

describe("mirroring a clip's picture", () => {
  it("draws the picture as authored when nothing is set", () => {
    expect(corners(draw())).toEqual([RED, BLUE, GREEN, WHITE]);
  });

  it("flipH swaps left and right", () => {
    expect(corners(draw({ flipH: true }))).toEqual([BLUE, RED, WHITE, GREEN]);
  });

  it("flipV swaps top and bottom", () => {
    expect(corners(draw({ flipV: true }))).toEqual([GREEN, WHITE, RED, BLUE]);
  });

  it("both is a half turn", () => {
    expect(corners(draw({ flipH: true, flipV: true }))).toEqual([
      WHITE,
      GREEN,
      BLUE,
      RED,
    ]);
  });

  it("turns over inside the box rather than moving it", () => {
    // A 20x20 clip at (10, 10) of a 40x40 frame. A flip about the wrong point
    // would push the picture out of its box and leave ink somewhere else.
    const placed = { location: { x: 10, y: 10 }, width: 20, height: 20 };
    const plain = inkBounds(draw(placed));
    const flipped = inkBounds(draw({ ...placed, flipH: true, flipV: true }));
    expect(flipped).toEqual(plain);
  });

  it("flips on the isolation layer too, when the clip is blended", () => {
    // `lighten` against black is the clip itself, so the colours survive while
    // the draw goes through the layer path rather than the direct one.
    const canvas = draw({ flipH: true, blend: "lighten" });
    expect(corners(canvas)).toEqual([BLUE, RED, WHITE, GREEN]);
  });

  it("leaves a mask where it was drawn and turns the picture beneath it", () => {
    // The mask keeps the left half. Mirrored, the left half now shows what was
    // on the right — blue over white — and the right half is still cut away.
    const leftHalf: MaskType = {
      ...defaultMask("rectangle"),
      location: { x: 25, y: 50 },
      size: { width: 50, height: 100 },
    };
    const canvas = draw({ flipH: true, mask: leftHalf });
    expect(corners(canvas)).toEqual([BLUE, BLACK, WHITE, BLACK]);
  });
});
