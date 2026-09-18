import { afterEach, describe, expect, it } from "vitest";
import type { CropRect, ImageElementType } from "../../@types/timeline";
import { FULL_CROP } from "../timeline/cropOps";
import { renderElement } from "./element";
import { resetLayers } from "./surface";
import { imageElement, inkBounds, pixel, scene, type Rgba } from "./testing";

/**
 * A crop through the real `renderElement`, asserted on pixels.
 *
 * The renderer below paints a four-by-four grid of distinct colours, so a crop
 * that keeps the wrong cells, keeps the right ones at the wrong scale, or leaks
 * a neighbour past the clip is a wrong colour at a known pixel. A plain
 * quadrant pattern would not catch an off-by-one in the translate, because
 * every wrong answer would still be one of four colours.
 */

const SIZE = 80;
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };

/** Distinct, widely separated colours so a blend or a bleed is obvious. */
const CELLS = [
  ["#ff0000", "#00ff00", "#0000ff", "#ffff00"],
  ["#ff00ff", "#00ffff", "#ffffff", "#808080"],
  ["#800000", "#008000", "#000080", "#808000"],
  ["#c04000", "#40c000", "#0040c0", "#c000c0"],
];

const rgb = (hex: string): Rgba => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
  a: 255,
});

/** A 4x4 grid filling the element's box, one flat colour per cell. */
const grid = (
  ctx: CanvasRenderingContext2D,
  _id: string,
  element: { width: number; height: number },
) => {
  const w = element.width / 4;
  const h = element.height / 4;
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      ctx.fillStyle = CELLS[row][column];
      // Exactly the cell, with no overdraw. An earlier version painted half a
      // pixel past each edge to avoid seams, and the outermost cells then bled
      // one pixel outside the element's box, which the crop's clip trimmed,
      // making `inkBounds` differ for a reason that had nothing to do with the
      // crop. Every assertion below samples cell centres, so seams do not
      // matter and a fixture that stays inside its box does.
      ctx.fillRect(column * w, row * h, w, h);
    }
  }
};

const rect = (x: number, y: number, width: number, height: number): CropRect => ({
  x,
  y,
  width,
  height,
});

function draw(over: Partial<ImageElementType> = {}, size = SIZE) {
  const { canvas, ctx } = scene(size, size, "#000000");
  const element = imageElement({
    location: { x: 0, y: 0 },
    width: size,
    height: size,
    ...over,
  });
  renderElement(ctx, "el", element, 0, false, grid as any);
  return canvas;
}

afterEach(() => {
  resetLayers();
});

describe("an uncropped clip", () => {
  it("draws byte-identically with no crop key and with the whole frame", () => {
    const without = draw();
    const whole = draw({ crop: FULL_CROP } as any);
    expect(
      Buffer.compare(
        Buffer.from(without.getContext("2d").getImageData(0, 0, SIZE, SIZE).data),
        Buffer.from(whole.getContext("2d").getImageData(0, 0, SIZE, SIZE).data),
      ),
    ).toBe(0);
  });

  it("puts each of the sixteen cells where the renderer authored it", () => {
    const canvas = draw();
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        expect(
          pixel(canvas, column * 20 + 10, row * 20 + 10),
          `${row},${column}`,
        ).toEqual(rgb(CELLS[row][column]));
      }
    }
  });
});

describe("a crop fills the box with the kept region", () => {
  it.each([
    ["top left", rect(0, 0, 0.25, 0.25), CELLS[0][0]],
    ["top right", rect(0.75, 0, 0.25, 0.25), CELLS[0][3]],
    ["bottom left", rect(0, 0.75, 0.25, 0.25), CELLS[3][0]],
    ["bottom right", rect(0.75, 0.75, 0.25, 0.25), CELLS[3][3]],
    ["a middle cell", rect(0.5, 0.25, 0.25, 0.25), CELLS[1][2]],
  ])("keeps only the %s cell", (_name, crop, colour) => {
    const canvas = draw({ crop } as any);
    // Every corner of the box, and its centre, is now that one colour.
    for (const [x, y] of [
      [4, 4],
      [SIZE - 5, 4],
      [4, SIZE - 5],
      [SIZE - 5, SIZE - 5],
      [SIZE / 2, SIZE / 2],
    ]) {
      expect(pixel(canvas, x, y), `${x},${y}`).toEqual(rgb(colour));
    }
  });

  it("keeps a half-frame crop at the right scale, not just the right colours", () => {
    // The left half of the frame is columns 0 and 1, so after the crop the box
    // holds a 2x4 grid: each cell is now half the box wide.
    const canvas = draw({ crop: rect(0, 0, 0.5, 1) } as any);
    for (let row = 0; row < 4; row++) {
      expect(pixel(canvas, 20, row * 20 + 10), `row ${row} left`).toEqual(
        rgb(CELLS[row][0]),
      );
      expect(pixel(canvas, 60, row * 20 + 10), `row ${row} right`).toEqual(
        rgb(CELLS[row][1]),
      );
    }
  });

  it("keeps a crop that straddles a cell boundary", () => {
    // x from 0.375 to 0.625 is the right half of column 1 and the left half of
    // column 2, so the box is split down the middle between those two colours.
    const canvas = draw({ crop: rect(0.375, 0.25, 0.25, 0.25) } as any);
    expect(pixel(canvas, 20, 40)).toEqual(rgb(CELLS[1][1]));
    expect(pixel(canvas, 60, 40)).toEqual(rgb(CELLS[1][2]));
  });
});

describe("the clip region", () => {
  it("draws nothing outside the box, however far the source is scaled up", () => {
    const canvas = draw(
      { crop: rect(0.4, 0.4, 0.02, 0.02), width: 20, height: 20 } as any,
      SIZE,
    );
    // The source is magnified fifty times; without the clip it would cover the
    // whole scene rather than the clip's 20x20 box.
    expect(pixel(canvas, 25, 10)).toEqual(BLACK);
    expect(pixel(canvas, 10, 25)).toEqual(BLACK);
    expect(pixel(canvas, 60, 60)).toEqual(BLACK);
    expect(pixel(canvas, 10, 10)).not.toEqual(BLACK);
  });

  it("leaves the box exactly where it was: a crop moves no chrome", () => {
    const before = inkBounds(draw({ width: 40, height: 40 }));
    const after = inkBounds(
      draw({ width: 40, height: 40, crop: rect(0.25, 0.25, 0.5, 0.5) } as any),
    );
    expect(after.minX).toBe(before.minX);
    expect(after.minY).toBe(before.minY);
    expect(after.maxX).toBe(before.maxX);
    expect(after.maxY).toBe(before.maxY);
  });
});

describe("edges and degenerate rects", () => {
  it.each([
    ["left", rect(0, 0.25, 0.1, 0.5)],
    ["right", rect(0.9, 0.25, 0.1, 0.5)],
    ["top", rect(0.25, 0, 0.5, 0.1)],
    ["bottom", rect(0.25, 0.9, 0.5, 0.1)],
  ])("fills the box for a crop flush against the %s edge", (_name, crop) => {
    const canvas = draw({ crop } as any);
    expect(pixel(canvas, 2, 2)).not.toEqual(BLACK);
    expect(pixel(canvas, SIZE - 3, SIZE - 3)).not.toEqual(BLACK);
  });

  it("survives a rect at the floor without drawing a blank frame", () => {
    const canvas = draw({ crop: rect(0, 0, 0.01, 0.01) } as any);
    expect(pixel(canvas, SIZE / 2, SIZE / 2)).toEqual(rgb(CELLS[0][0]));
  });

  it("reads an unusable stored rect as uncropped rather than throwing", () => {
    for (const crop of [
      { x: NaN, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 0, height: 0 },
      "nonsense",
      [],
    ]) {
      expect(() => draw({ crop } as any)).not.toThrow();
    }
    const canvas = draw({ crop: "nonsense" } as any);
    expect(pixel(canvas, 10, 10)).toEqual(rgb(CELLS[0][0]));
    expect(pixel(canvas, 70, 70)).toEqual(rgb(CELLS[3][3]));
  });
});
