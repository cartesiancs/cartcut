import { describe, it, expect, vi } from "vitest";
import { renderElement } from "./element";
import {
  scene,
  pixel,
  points,
  imageElement,
  shapeElement,
  inactiveAnimation,
} from "./testing";
import type { ImageElementType } from "../../@types/timeline";

/**
 * `renderElement` owns the whole transform stack — position, rotation, scale,
 * opacity — and hands each element renderer a context already placed in the
 * element's own local space, where the element occupies (0, 0, width, height).
 * These tests assert on that: a plain fill of the local box, checked in canvas
 * coordinates.
 */
const fillLocalBox =
  (color: string) =>
  (
    ctx: CanvasRenderingContext2D,
    _id: string,
    element: ImageElementType,
  ): void => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, element.width, element.height);
  };

const red = fillLocalBox("#ff0000");

function draw(
  element: ImageElementType,
  cursor: number,
  size = 300,
  outline = false,
) {
  const { canvas, ctx } = scene(size, size, "#000000");
  renderElement(ctx, "el", element, cursor, outline, red);
  return { canvas, ctx };
}

describe("renderElement", () => {
  it("places an unanimated element at its location, at its own size", () => {
    const el = imageElement({
      location: { x: 50, y: 50 },
      width: 100,
      height: 100,
    });
    const { canvas } = draw(el, 0);

    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 51, 51)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 149, 149)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 40, 40)).toMatchObject({ r: 0, g: 0, b: 0 });
    expect(pixel(canvas, 160, 160)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("follows the position track", () => {
    const el = imageElement({
      location: { x: 0, y: 0 },
      width: 50,
      height: 50,
      animation: {
        ...inactiveAnimation(),
        position: {
          isActivate: true,
          x: [],
          y: [],
          ax: points([0, 0], [1000, 200]),
          ay: points([0, 0], [1000, 100]),
        },
      },
    });

    const start = draw(el, 0);
    expect(pixel(start.canvas, 25, 25)).toMatchObject({ r: 255, g: 0, b: 0 });

    const later = draw(el, 1000);
    expect(pixel(later.canvas, 225, 125)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(later.canvas, 25, 25)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  /**
   * The `size` track replaces the element's box on the way to its renderer,
   * rather than multiplying the matrix the way `scale` does.
   *
   * That is the whole contract of the property: a clip animated to 200x50 is
   * drawn by exactly the code that draws one typed as 200x50 in the sidebar,
   * so preview, export, mask and hit test cannot form separate opinions about
   * how big it is. `fillLocalBox` above reads `element.width`/`height` off the
   * element it is handed, which is precisely the substitution being asserted.
   */
  describe("the size track", () => {
    const sized = () =>
      imageElement({
        location: { x: 0, y: 0 },
        width: 100,
        height: 100,
        animation: {
          ...inactiveAnimation(),
          size: {
            isActivate: true,
            x: [],
            y: [],
            ax: points([0, 100], [1000, 200]),
            ay: points([0, 100], [1000, 50]),
          },
        },
      });

    it("draws the sampled box, per axis", () => {
      const start = draw(sized(), 0);
      expect(pixel(start.canvas, 99, 99)).toMatchObject({ r: 255, g: 0, b: 0 });
      expect(pixel(start.canvas, 101, 101)).toMatchObject({ r: 0, g: 0, b: 0 });

      // 200 wide, 50 tall: the two axes move independently, which is what
      // makes this a size rather than a second scale.
      const later = draw(sized(), 1000);
      expect(pixel(later.canvas, 199, 49)).toMatchObject({ r: 255, g: 0, b: 0 });
      expect(pixel(later.canvas, 199, 60)).toMatchObject({ r: 0, g: 0, b: 0 });
      expect(pixel(later.canvas, 210, 49)).toMatchObject({ r: 0, g: 0, b: 0 });
    });

    it("rotates about the centre of the box it is drawing", () => {
      // A half-turn is the cleanest witness: it maps the top-left corner onto
      // the bottom-right one, so the box lands back on itself only if the
      // pivot moved with the size. Pivoting on the stored 100x100 centre
      // would fling the 200x50 box up and to the left instead.
      const el = { ...sized(), rotation: 180 };
      const { canvas } = draw(el, 1000);

      expect(pixel(canvas, 5, 5)).toMatchObject({ r: 255, g: 0, b: 0 });
      expect(pixel(canvas, 195, 45)).toMatchObject({ r: 255, g: 0, b: 0 });
      expect(pixel(canvas, 210, 45)).toMatchObject({ r: 0, g: 0, b: 0 });
    });

    it("hands the renderer the element itself when the track is off", () => {
      // Identity, not just equality. Every frame of every project that has
      // never used the property goes through this branch, so it must allocate
      // nothing — and a renderer that caches on the element object must keep
      // seeing the same one.
      const el = imageElement({ width: 100, height: 100 });
      const seen: unknown[] = [];
      const { ctx } = scene(300, 300, "#000000");
      renderElement(ctx, "el", el, 0, false, (_c, _id, passed) => {
        seen.push(passed);
      });
      expect(seen).toEqual([el]);
      expect(seen[0]).toBe(el);
    });

    it("leaves the stored box alone", () => {
      // The substitution is a value handed to the renderer for one frame, not
      // an edit. A sampled size that wrote back would be a document change on
      // every repaint — and `withCheckpoint` would have nothing to say about
      // it, since the renderer never goes near the store.
      const el = sized();
      draw(el, 1000);
      expect(el.width).toBe(100);
      expect(el.height).toBe(100);
    });
  });

  it("rotates about the element's own centre, not its corner", () => {
    // A wide, short bar rotated a quarter turn becomes tall and narrow while
    // its centre stays put.
    const el = imageElement({
      location: { x: 100, y: 140 },
      width: 100,
      height: 20,
      rotation: 90,
    });
    const { canvas } = draw(el, 0);

    const centreX = 150;
    const centreY = 150;
    expect(pixel(canvas, centreX, centreY)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, centreX, centreY - 40)).toMatchObject({ r: 255, g: 0 });
    expect(pixel(canvas, centreX, centreY + 40)).toMatchObject({ r: 255, g: 0 });
    expect(pixel(canvas, centreX - 40, centreY)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("reads the scale track as tenths and scales about the centre", () => {
    const el = imageElement({
      location: { x: 100, y: 100 },
      width: 100,
      height: 100,
      animation: {
        ...inactiveAnimation(),
        // 20 => 2x
        scale: { isActivate: true, x: [], ax: points([0, 20]) },
      },
    });
    const { canvas } = draw(el, 0);

    // Centre unmoved at (150, 150); the box grows around it from 100..200 to
    // 50..250.
    expect(pixel(canvas, 150, 150)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 55, 55)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 245, 245)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 45, 45)).toMatchObject({ r: 0, g: 0, b: 0 });
    expect(pixel(canvas, 255, 255)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("ignores an inactive position track, as rotation, scale and opacity do", () => {
    // Position used to be the one property that animated whenever a track
    // merely existed, so switching it off left the element moving anyway. It is
    // now gated on `isActivate` like the other three — which the timeline's
    // keyframe lane depends on, since it draws diamonds only for live tracks
    // and would otherwise show a clip moving with nothing to explain it.
    const el = imageElement({
      location: { x: 0, y: 0 },
      width: 50,
      height: 50,
      animation: {
        ...inactiveAnimation(),
        position: {
          isActivate: false,
          x: [],
          y: [],
          ax: points([0, 200]),
          ay: points([0, 100]),
        },
      },
    });

    const { canvas } = draw(el, 0);
    // At its static location, not at the baked (200, 100).
    expect(pixel(canvas, 25, 25)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 225, 125)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("leaves an inactive scale track at 1x even with keyframes baked in", () => {
    const el = imageElement({
      location: { x: 100, y: 100 },
      width: 100,
      height: 100,
      animation: {
        ...inactiveAnimation(),
        scale: { isActivate: false, x: [], ax: points([0, 40]) },
      },
    });
    const { canvas } = draw(el, 0);
    expect(pixel(canvas, 150, 150)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 60, 60)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("applies the static opacity", () => {
    const el = imageElement({ opacity: 50, width: 100, height: 100 });
    const { canvas } = draw(el, 0);
    const p = pixel(canvas, 50, 50);
    expect(p.r).toBeGreaterThan(100);
    expect(p.r).toBeLessThan(160);
  });

  it("applies the opacity track", () => {
    const el = imageElement({
      opacity: 100,
      width: 100,
      height: 100,
      animation: {
        ...inactiveAnimation(),
        opacity: {
          isActivate: true,
          x: [],
          ax: points([0, 100], [1000, 20]),
        },
      },
    });

    expect(pixel(draw(el, 0).canvas, 50, 50).r).toBeGreaterThan(240);

    const faded = pixel(draw(el, 1000).canvas, 50, 50);
    expect(faded.r).toBeGreaterThan(30);
    expect(faded.r).toBeLessThan(80);
  });

  it("multiplies into the existing globalAlpha rather than replacing it", () => {
    // Compositing has to nest: an element at 50% inside a context already at
    // 50% should land at 25%, not back at 50%.
    const el = imageElement({ opacity: 50, width: 100, height: 100 });

    const { canvas, ctx } = scene(300, 300, "#000000");
    ctx.globalAlpha = 0.5;
    renderElement(ctx, "el", el, 0, false, red);

    const p = pixel(canvas, 50, 50);
    expect(p.r).toBeGreaterThan(40);
    expect(p.r).toBeLessThan(90);
  });

  it("restores the context so one element cannot disturb the next", () => {
    const spun = imageElement({
      location: { x: 0, y: 0 },
      width: 40,
      height: 40,
      rotation: 33,
      opacity: 40,
    });
    const plain = imageElement({
      location: { x: 100, y: 100 },
      width: 100,
      height: 100,
    });

    const { canvas, ctx } = scene(300, 300, "#000000");
    renderElement(ctx, "spun", spun, 0, false, red);
    renderElement(ctx, "plain", plain, 0, false, fillLocalBox("#00ff00"));

    // the second element lands square and fully opaque
    expect(pixel(canvas, 150, 150)).toMatchObject({ r: 0, g: 255, b: 0 });
    expect(pixel(canvas, 199, 199)).toMatchObject({ r: 0, g: 255, b: 0 });
    expect(pixel(canvas, 150, 90)).toMatchObject({ r: 0, g: 0, b: 0 });
    expect(ctx.globalAlpha).toBe(1);
  });

  it("falls back to static values while the cursor precedes the element", () => {
    const el = imageElement({
      startTime: 5000,
      location: { x: 10, y: 10 },
      width: 50,
      height: 50,
      animation: {
        ...inactiveAnimation(),
        position: {
          isActivate: true,
          x: [],
          y: [],
          ax: points([0, 200]),
          ay: points([0, 200]),
        },
      },
    });
    const { canvas } = draw(el, 0);
    expect(pixel(canvas, 30, 30)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 225, 225)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("draws the selection outline only when asked", () => {
    const el = imageElement({
      location: { x: 100, y: 100 },
      width: 100,
      height: 100,
    });

    const plain = draw(el, 0, 300, false);
    // the rotation grip sits 50px above the box
    expect(pixel(plain.canvas, 150, 50)).toMatchObject({ r: 0, g: 0, b: 0 });

    const selected = draw(el, 0, 300, true);
    expect(pixel(selected.canvas, 150, 50)).toMatchObject({
      r: 255,
      g: 255,
      b: 255,
    });
  });

  it("keeps the outline fully opaque over a faded element", () => {
    const el = imageElement({
      location: { x: 100, y: 100 },
      width: 100,
      height: 100,
      opacity: 10,
    });
    const { canvas } = draw(el, 0, 300, true);
    expect(pixel(canvas, 150, 50)).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  it("passes the element and cursor straight through to the renderer", () => {
    const el = shapeElement();
    const renderFunction = vi.fn();
    const { ctx } = scene(100, 100);

    renderElement(ctx, "shape-1", el, 1234, false, renderFunction);

    expect(renderFunction).toHaveBeenCalledTimes(1);
    expect(renderFunction.mock.calls[0][1]).toBe("shape-1");
    expect(renderFunction.mock.calls[0][2]).toBe(el);
    expect(renderFunction.mock.calls[0][3]).toBe(1234);
  });

  it("handles a shape, which carries only an opacity track", () => {
    const el = shapeElement({
      location: { x: 100, y: 100 },
      opacity: 100,
      animation: {
        opacity: { isActivate: true, x: [], ax: points([0, 100], [1000, 20]) },
      },
    });

    const { canvas: bright } = scene(300, 300, "#000000");
    const brightCtx = bright.getContext("2d") as unknown as CanvasRenderingContext2D;
    renderElement(brightCtx, "s", el, 0, false, red);
    expect(pixel(bright, 150, 150).r).toBeGreaterThan(240);

    const { canvas: faint } = scene(300, 300, "#000000");
    const faintCtx = faint.getContext("2d") as unknown as CanvasRenderingContext2D;
    renderElement(faintCtx, "s", el, 1000, false, red);
    expect(pixel(faint, 150, 150).r).toBeLessThan(80);
  });
});
