import { afterEach, describe, expect, it } from "vitest";
import type { ImageElementType } from "../../@types/timeline";
import { renderElement } from "./element";
import { resetLayers } from "./surface";
import { imageElement, pixel, scene, videoElement, type Rgba } from "./testing";

/**
 * Rounded corners on an image and a video, drawn through the real
 * `renderElement` onto a real Skia surface.
 *
 * Every claim is a pixel. Where a test could pass because nothing was drawn at
 * all, the same scene is drawn square as well and the two must disagree.
 */

const SIZE = 100;
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };
const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };

const flat = (
  ctx: CanvasRenderingContext2D,
  _id: string,
  element: { width: number; height: number },
) => {
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, element.width, element.height);
};

/** Four vertical stripes, so a flip or a crop changes the picture. */
const stripes = (
  ctx: CanvasRenderingContext2D,
  _id: string,
  element: { width: number; height: number },
) => {
  const w = element.width / 4;
  for (const [index, colour] of ["#ff0000", "#0000ff", "#00ff00", "#ffffff"].entries()) {
    ctx.fillStyle = colour;
    ctx.fillRect(index * w, 0, w, element.height);
  }
};

function draw(
  over: Partial<ImageElementType> & Record<string, unknown> = {},
  renderFunction: any = flat,
) {
  const { canvas, ctx } = scene(SIZE, SIZE, "#000000");
  const element = imageElement({
    location: { x: 0, y: 0 },
    width: SIZE,
    height: SIZE,
    ...over,
  } as any);
  renderElement(ctx, "el", element, 0, false, renderFunction);
  return canvas;
}

function bytes(canvas: ReturnType<typeof draw>): number[] {
  return Array.from(
    canvas.getContext("2d").getImageData(0, 0, SIZE, SIZE).data,
  );
}

afterEach(() => {
  resetLayers();
});

describe("a rounded clip", () => {
  it("shows the background at its corners and the picture inside", () => {
    const canvas = draw({ cornerRadius: 30 });

    for (const [x, y] of [
      [1, 1],
      [98, 1],
      [98, 98],
      [1, 98],
    ]) {
      expect(pixel(canvas, x, y), `${x},${y}`).toEqual(BLACK);
    }
    expect(pixel(canvas, 50, 50)).toEqual(RED);
    // The middle of each edge is untouched by a corner.
    expect(pixel(canvas, 50, 0)).toEqual(RED);
    expect(pixel(canvas, 0, 50)).toEqual(RED);
  });

  it("differs from the same clip drawn square", () => {
    // Without this the test above could pass against a renderer that drew
    // nothing in the corners for some other reason.
    expect(pixel(draw(), 1, 1)).toEqual(RED);
    expect(pixel(draw({ cornerRadius: 30 }), 1, 1)).toEqual(BLACK);
  });

  it("rounds a video the same way", () => {
    const { canvas, ctx } = scene(SIZE, SIZE, "#000000");
    renderElement(
      ctx,
      "v",
      videoElement({ cornerRadius: 30 } as any),
      0,
      false,
      flat as any,
    );
    expect(pixel(canvas, 1, 1)).toEqual(BLACK);
    expect(pixel(canvas, 50, 50)).toEqual(RED);
  });

  it("caps the radius at half the shorter side, which makes a pill", () => {
    const pill = (cornerRadius: number) =>
      draw({ width: 100, height: 40, location: { x: 0, y: 30 }, cornerRadius });

    // Half of 40 is 20, so a radius of 1000 is a radius of 20.
    expect(bytes(pill(1000))).toEqual(bytes(pill(20)));
    expect(bytes(pill(1000))).not.toEqual(bytes(pill(10)));

    const canvas = pill(1000);
    // The left end is a semicircle about (20, 50): its leftmost point is
    // picture and the box's corner beside it is not.
    expect(pixel(canvas, 1, 50)).toEqual(RED);
    expect(pixel(canvas, 3, 33)).toEqual(BLACK);
  });

  it("draws a zero radius exactly as no radius at all", () => {
    expect(bytes(draw({ cornerRadius: 0 }, stripes))).toEqual(
      bytes(draw({}, stripes)),
    );
  });

  it("draws a negative or junk radius square, and does not throw", () => {
    // Chromium's `roundRect` throws on a negative radius and Skia here does
    // not, so this is the only place the guard can be seen working.
    expect(bytes(draw({ cornerRadius: -20 }))).toEqual(bytes(draw()));
    expect(bytes(draw({ cornerRadius: "30" } as any))).toEqual(bytes(draw()));
    expect(bytes(draw({ cornerRadius: Number.NaN }))).toEqual(bytes(draw()));
  });

  it("rounds the box, not the cropped frame", () => {
    // A crop of a flat picture is the same flat picture, so the frame must be
    // identical with the crop and without it. An outline traced under the
    // crop's `scale(2, 1)` would put elliptical corners on the uncropped frame
    // and fail this at every corner.
    const crop = { x: 0.5, y: 0, width: 0.5, height: 1 };
    const cropped = draw({ cornerRadius: 30, crop } as any);

    expect(pixel(cropped, 1, 1)).toEqual(BLACK);
    expect(bytes(cropped)).toEqual(bytes(draw({ cornerRadius: 30 })));
  });

  it("keeps its corners on screen when the picture is mirrored", () => {
    const mirrored = draw({ cornerRadius: 30, flipH: true, flipV: true } as any);

    expect(pixel(mirrored, 1, 1)).toEqual(BLACK);
    expect(bytes(mirrored)).toEqual(bytes(draw({ cornerRadius: 30 })));
  });

  it("is drawn with the radius its keyframe track says", () => {
    const animated = {
      cornerRadius: 0,
      animation: {
        ...imageElement().animation,
        cornerRadius: { isActivate: true, x: [], ax: [[0, 30], [4000, 30]] },
      },
    } as any;
    expect(bytes(draw(animated))).toEqual(bytes(draw({ cornerRadius: 30 })));

    // Switched off, the curve is ignored and the static field answers.
    const off = {
      ...animated,
      animation: {
        ...animated.animation,
        cornerRadius: { ...animated.animation.cornerRadius, isActivate: false },
      },
    };
    expect(bytes(draw(off))).toEqual(bytes(draw()));
  });
});

describe("a rounded clip's border", () => {
  const INNER = {
    enable: true,
    width: 6,
    color: "#00ff00",
    opacity: 100,
    align: "inner",
  };

  it("follows the rounded corner rather than the box's", () => {
    const canvas = draw({ cornerRadius: 30, stroke: INNER } as any);

    // 27px from the corner's centre at 45 degrees is inside the 6px band
    // along the arc: (30 - 27 cos 45, 30 - 27 sin 45) is about (11, 11).
    expect(pixel(canvas, 11, 11)).toMatchObject({ r: 0, g: 255, b: 0 });
    // The box's own corner is outside the arc: no border, no picture.
    expect(pixel(canvas, 1, 1)).toEqual(BLACK);
    expect(pixel(canvas, 50, 50)).toEqual(RED);
  });

  it("casts its shadow from the rounded outline", () => {
    // Offset by half the clip and unblurred, so the shadow's bottom right
    // corner is clear of the picture and sharp enough to read.
    const { canvas, ctx } = scene(200, 200, "#000000");
    renderElement(
      ctx,
      "el",
      imageElement({
        location: { x: 0, y: 0 },
        width: SIZE,
        height: SIZE,
        cornerRadius: 30,
        shadow: {
          enable: true,
          offsetX: 50,
          offsetY: 50,
          blur: 0,
          color: "#0000ff",
          opacity: 100,
        },
      } as any),
      0,
      false,
      flat,
    );
    // The shadow spans (50, 50) to (150, 150) with the same 30px corners, so
    // (148, 148) is outside its rounded corner and (120, 120) is well inside.
    expect(pixel(canvas, 148, 148)).toEqual(BLACK);
    expect(pixel(canvas, 120, 120)).toMatchObject({ r: 0, g: 0, b: 255 });
  });
});
