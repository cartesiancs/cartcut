import { afterEach, describe, expect, it } from "vitest";

import type { ImageElementType, MaskType } from "../../@types/timeline";
import { defaultMask } from "../mask/maskShape";
import { renderElement } from "./element";
import { resetLayers } from "./surface";
import { groupElement, imageElement, pixel, scene, type Rgba } from "./testing";

/**
 * These drive the **real** `renderElement` onto a real Skia surface installed
 * by `renderer/testing.ts` — the same isolation layer the app allocates, the
 * same `destination-in` composite, the same `ctx.filter` blur. Nothing is
 * mocked, and the expected values are geometric rather than sampled from a
 * previous run, so a change of shape shows up as a failure rather than as a
 * re-baselined snapshot.
 */

const SIZE = 40;
const CLIP_COLOR = "#4080c0";
const BACKGROUND = "#000000";

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

/** A mask covering the left half of the element, hard-edged. */
function leftHalf(over: Partial<MaskType> = {}): MaskType {
  return {
    ...defaultMask("rectangle"),
    location: { x: 25, y: 50 },
    size: { width: 50, height: 100 },
    ...over,
  };
}

function draw(
  over: Partial<ImageElementType>,
  options: {
    size?: number;
    isolated?: boolean;
    transform?: [number, number, number, number, number, number];
    elements?: Record<string, any>;
  } = {},
) {
  const size = options.size ?? SIZE;
  const { canvas, ctx } = scene(size, size, BACKGROUND);
  const element = imageElement({
    location: { x: 0, y: 0 },
    width: size,
    height: size,
    ...over,
  });
  if (options.transform) {
    ctx.setTransform(...options.transform);
  }
  const context =
    options.elements != null || options.isolated
      ? {
          elements: options.elements ?? { el: element },
          isolated: options.isolated,
        }
      : undefined;
  renderElement(ctx, "el", element, 0, false, fillBox(CLIP_COLOR), context);
  return canvas;
}

const CLIP: Rgba = { r: 0x40, g: 0x80, b: 0xc0, a: 255 };
const BACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };

function expectPixel(actual: Rgba, want: Rgba, slack = 1): void {
  for (const channel of ["r", "g", "b", "a"] as const) {
    expect(
      Math.abs(actual[channel] - want[channel]),
      `${channel}: got ${actual[channel]}, want ${want[channel]}`,
    ).toBeLessThanOrEqual(slack);
  }
}

afterEach(() => {
  resetLayers();
});

describe("a mask cuts the clip and nothing else", () => {
  it("keeps what is inside and erases what is outside", () => {
    const canvas = draw({ mask: leftHalf() });
    expectPixel(pixel(canvas, 5, 20), CLIP);
    expectPixel(pixel(canvas, 35, 20), BACK);
  });

  it("puts the boundary exactly where the geometry says", () => {
    const canvas = draw({ mask: leftHalf() });
    // The mask spans [0, 20). 19 is the last covered column, 21 the first
    // clear one; 20 itself is the edge pixel and is left to antialiasing.
    expectPixel(pixel(canvas, 19, 20), CLIP);
    expectPixel(pixel(canvas, 21, 20), BACK);
  });

  it("swaps the two halves when inverted", () => {
    const canvas = draw({ mask: leftHalf({ invert: true }) });
    expectPixel(pixel(canvas, 5, 20), BACK);
    expectPixel(pixel(canvas, 35, 20), CLIP);
  });

  it("leaves an unmasked clip untouched", () => {
    const canvas = draw({});
    expectPixel(pixel(canvas, 5, 20), CLIP);
    expectPixel(pixel(canvas, 35, 20), CLIP);
  });
});

describe("the shapes", () => {
  const covers = (mask: MaskType, x: number, y: number): boolean => {
    const p = pixel(draw({ mask }), x, y);
    return p.b > 100;
  };

  it("covers the centre and clears the corners, for every built-in shape", () => {
    for (const shape of ["rectangle", "star", "heart"] as const) {
      const mask = { ...defaultMask(shape), size: { width: 90, height: 90 } };
      expect(covers(mask, 20, 22), `${shape} centre`).toBe(true);
      expect(covers(mask, 1, 1), `${shape} corner`).toBe(false);
    }
  });

  // A star's re-entrant notches are the thing that would vanish if the path
  // were being filled as a convex hull, or wound the wrong way.
  it("clears a star's notches while keeping its points", () => {
    const mask = { ...defaultMask("star"), size: { width: 100, height: 100 } };
    // Straight up from the centre is a point; the far left edge at mid-height
    // falls between two arms.
    expect(covers(mask, 20, 3)).toBe(true);
    expect(covers(mask, 1, 20)).toBe(false);
  });

  // The pass-through contract: a pen mask that cannot enclose anything renders
  // as no mask at all, which is what the clip looks like between the first
  // click of a stroke and the third.
  it("renders a pen mask with too few nodes as no mask", () => {
    const twoNodes: MaskType = {
      ...defaultMask("pen"),
      path: [{ p: [-0.5, -0.5] }, { p: [0.5, 0.5] }],
    };
    const canvas = draw({ mask: twoNodes });
    expectPixel(pixel(canvas, 5, 20), CLIP);
    expectPixel(pixel(canvas, 35, 20), CLIP);
  });

  it("cuts to a drawn pen path", () => {
    const triangle: MaskType = {
      ...defaultMask("pen"),
      size: { width: 100, height: 100 },
      path: [{ p: [-0.5, 0.5] }, { p: [0.5, 0.5] }, { p: [0, -0.5] }],
    };
    const canvas = draw({ mask: triangle });
    // Inside near the base, outside at the top corners.
    expectPixel(pixel(canvas, 20, 35), CLIP);
    expectPixel(pixel(canvas, 2, 2), BACK);
    expectPixel(pixel(canvas, 37, 2), BACK);
  });
});

describe("feather", () => {
  /** Alpha of the clip's colour along a row, as a coverage proxy. */
  const rowCoverage = (mask: MaskType, y: number): number[] => {
    const canvas = draw({ mask });
    return Array.from({ length: SIZE }, (_u, x) => pixel(canvas, x, y).b);
  };

  it("is a hard edge at zero", () => {
    const row = rowCoverage(leftHalf({ feather: 0 }), 20);
    // At most one pixel of antialiasing between full and none.
    const partial = row.filter((v) => v > 10 && v < 0xc0 - 10).length;
    expect(partial).toBeLessThanOrEqual(1);
  });

  it("spreads the edge into a monotonic ramp", () => {
    const row = rowCoverage(leftHalf({ feather: 8 }), 20);
    const partial = row.filter((v) => v > 10 && v < 0xc0 - 10).length;
    expect(partial).toBeGreaterThan(4);

    // Monotonically non-increasing across the boundary: a feather is a blur of
    // the stencil, so coverage may only fall as it leaves the mask.
    for (let x = 12; x < 30; x++) {
      expect(row[x + 1]).toBeLessThanOrEqual(row[x] + 1);
    }
  });

  it("widens the ramp as the feather grows", () => {
    const rampWidth = (feather: number) =>
      rowCoverage(leftHalf({ feather }), 20).filter((v) => v > 10 && v < 0xc0 - 10)
        .length;
    expect(rampWidth(10)).toBeGreaterThan(rampWidth(4));
  });

  // A feather that reached `blur()` as a negative number would either throw or
  // be ignored, and the sampler is what keeps it from ever getting there.
  it("treats a negative feather as none", () => {
    const canvas = draw({ mask: leftHalf({ feather: -5 }) });
    expectPixel(pixel(canvas, 5, 20), CLIP);
    expectPixel(pixel(canvas, 35, 20), BACK);
  });
});

describe("round corners", () => {
  it("clears the corners of a full-size rectangle", () => {
    const square = { ...defaultMask("rectangle"), size: { width: 100, height: 100 } };
    expect(pixel(draw({ mask: square }), 1, 1).b).toBeGreaterThan(100);
    expect(
      pixel(draw({ mask: { ...square, roundness: 100 } }), 1, 1).b,
    ).toBeLessThan(60);
  });

  it("leaves the middle of each edge alone", () => {
    const round = {
      ...defaultMask("rectangle"),
      size: { width: 100, height: 100 },
      roundness: 100,
    };
    expect(pixel(draw({ mask: round }), 20, 1).b).toBeGreaterThan(100);
    expect(pixel(draw({ mask: round }), 1, 20).b).toBeGreaterThan(100);
  });
});

describe("the mask travels with the clip", () => {
  it("rotates with the element", () => {
    // A left-half mask on an element rotated a quarter turn covers the top
    // half instead: the mask lives in the element's own local space.
    const canvas = draw({ mask: leftHalf(), rotation: 90 });
    expectPixel(pixel(canvas, 20, 5), CLIP);
    expectPixel(pixel(canvas, 20, 35), BACK);
  });

  it("follows a group's transform", () => {
    const element = imageElement({
      location: { x: 0, y: 0 },
      width: SIZE,
      height: SIZE,
      parentId: "g",
      mask: leftHalf(),
    });
    const group = groupElement({
      location: { x: 0, y: 0 },
      width: SIZE,
      height: SIZE,
      rotation: 90,
    });
    const { canvas, ctx } = scene(SIZE, SIZE, BACKGROUND);
    renderElement(ctx, "el", element, 0, false, fillBox(CLIP_COLOR), {
      elements: { el: element, g: group },
    });
    expectPixel(pixel(canvas, 20, 5), CLIP);
    expectPixel(pixel(canvas, 20, 35), BACK);
  });

  /**
   * The one that would pass with the wrong matrix.
   *
   * Every other case here draws at identity, which is exactly the condition
   * under which a mask built from `worldMatrixOf` alone — project space, not
   * device space — is indistinguishable from a correct one. The preview draws
   * under `zoom × dpr`, so this is the case that catches it.
   */
  it("respects the destination's own transform", () => {
    const canvas = draw(
      { mask: leftHalf(), width: 20, height: 20 },
      { transform: [2, 0, 0, 2, 0, 0] },
    );
    // The element is 20x20 scaled by 2, so it fills the 40x40 frame and the
    // mask boundary lands at device x = 20, not at x = 10.
    expectPixel(pixel(canvas, 15, 20), CLIP);
    expectPixel(pixel(canvas, 25, 20), BACK);
  });

  it("respects a translated destination", () => {
    const canvas = draw(
      { mask: leftHalf(), width: 20, height: 20 },
      { transform: [1, 0, 0, 1, 10, 10] },
    );
    // Element occupies device [10, 30); its left half is [10, 20).
    expectPixel(pixel(canvas, 14, 15), CLIP);
    expectPixel(pixel(canvas, 25, 15), BACK);
  });
});

describe("composition with the rest of the pipeline", () => {
  // A mask is a property of the clip, like its grade and unlike its blend, so
  // it must survive the buffer a transition renders each half into.
  it("still applies inside a transition's isolated buffer", () => {
    const canvas = draw({ mask: leftHalf() }, { isolated: true });
    expectPixel(pixel(canvas, 5, 20), CLIP);
    expectPixel(pixel(canvas, 35, 20), BACK);
  });

  it("applies alongside a blend mode", () => {
    const { canvas, ctx } = scene(SIZE, SIZE, "#808080");
    const element = imageElement({
      location: { x: 0, y: 0 },
      width: SIZE,
      height: SIZE,
      blend: "multiply",
      mask: leftHalf(),
    });
    renderElement(ctx, "el", element, 0, false, fillBox("#808080"));
    // Multiplied where the mask keeps it, untouched background where it does not.
    expect(pixel(canvas, 5, 20).r).toBeLessThan(0x80);
    expectPixel(pixel(canvas, 35, 20), { r: 0x80, g: 0x80, b: 0x80, a: 255 });
  });

  it("applies alongside the element's own opacity", () => {
    const canvas = draw({ mask: leftHalf(), opacity: 50 });
    const inside = pixel(canvas, 5, 20);
    expect(inside.b).toBeGreaterThan(0x40);
    expect(inside.b).toBeLessThan(0xc0);
    expectPixel(pixel(canvas, 35, 20), BACK);
  });
});

describe("degenerate inputs draw something rather than nothing", () => {
  it("hides the clip when the mask is scaled to nothing", () => {
    const canvas = draw({
      mask: { ...defaultMask("rectangle"), size: { width: 0, height: 0 } },
    });
    expectPixel(pixel(canvas, 20, 20), BACK);
  });

  it("survives an element scaled to nothing", () => {
    const element = imageElement({
      location: { x: 0, y: 0 },
      width: SIZE,
      height: SIZE,
      mask: leftHalf(),
      animation: {
        ...imageElement().animation,
        scale: { isActivate: true, x: [], ax: [[0, 0]] },
      } as any,
    });
    const { canvas, ctx } = scene(SIZE, SIZE, BACKGROUND);
    expect(() =>
      renderElement(ctx, "el", element, 0, false, fillBox(CLIP_COLOR)),
    ).not.toThrow();
    expectPixel(pixel(canvas, 20, 20), BACK);
  });

  it("leaves no filter set on the layer for the next element", () => {
    const { canvas, ctx } = scene(SIZE, SIZE, BACKGROUND);
    const masked = imageElement({
      key: "a",
      location: { x: 0, y: 0 },
      width: SIZE,
      height: SIZE,
      mask: leftHalf({ feather: 12 }),
    });
    const blended = imageElement({
      key: "b",
      location: { x: 0, y: 0 },
      width: SIZE,
      height: SIZE,
      blend: "lighten",
    });
    renderElement(ctx, "a", masked, 0, false, fillBox(CLIP_COLOR));
    renderElement(ctx, "b", blended, 0, false, fillBox("#204060"));
    // The second clip is unmasked and unfeathered, and `lighten` over the black
    // background is its own colour. A leaked blur would pull transparency in
    // from beyond the canvas edge and dim the corner, so exactness is the test.
    expectPixel(pixel(canvas, 39, 39), { r: 0x20, g: 0x40, b: 0x60, a: 255 });
  });
});
