import { describe, it, expect } from "vitest";
import { renderShape } from "./shape";
import { scene, pixel, shapeElement } from "./testing";

/**
 * Element renderers receive a context already placed in the element's local
 * space by `renderElement`, so these draw at the origin and assert there.
 */
describe("renderShape", () => {
  it("fills the polygon with fillColor", () => {
    const el = shapeElement({
      width: 100,
      oWidth: 100,
      shape: [
        [10, 10],
        [90, 10],
        [90, 90],
        [10, 90],
      ],
      option: { fillColor: "#ff0000" },
    });
    const { canvas, ctx } = scene(100, 100, "#000000");
    renderShape(ctx, "s", el, 0);

    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 2, 2)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("scales authoring-space points down by authored size / drawn size", () => {
    // The same points authored at 200px square, rendered into a 100px box: the
    // shape halves, so (10,10)-(90,90) becomes (5,5)-(45,45). Both axes stated,
    // so this is deliberately the uniform case.
    const el = shapeElement({
      width: 100,
      height: 100,
      oWidth: 200,
      oHeight: 200,
      shape: [
        [10, 10],
        [90, 10],
        [90, 90],
        [10, 90],
      ],
    });
    const { canvas, ctx } = scene(100, 100, "#000000");
    renderShape(ctx, "s", el, 0);

    expect(pixel(canvas, 25, 25)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 70, 70)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  /**
   * The point of the feature: a stretched shape is stretched.
   *
   * The single `oWidth / width` divisor this replaces scaled both coordinates,
   * so `height` was never read — dragging a shape taller grew its selection box
   * and its hit area while the painted polygon stayed exactly where it was.
   */
  it("scales x and y independently", () => {
    // A 100x100 authored square drawn into a 200x50 box: twice as wide, half as
    // tall. The authored corner (100,100) lands at (200,50).
    const el = shapeElement({
      width: 200,
      height: 50,
      oWidth: 100,
      oHeight: 100,
      shape: [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ],
    });
    const { canvas, ctx } = scene(200, 100, "#000000");
    renderShape(ctx, "s", el, 0);

    expect(pixel(canvas, 190, 25)).toMatchObject({ r: 255, g: 0, b: 0 });
    // Below the squashed bottom edge, and past the stretched right one.
    expect(pixel(canvas, 100, 70)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  /**
   * A project saved before `oHeight` was written carries `oWidth` alone, and
   * drew with both coordinates scaled by it. Reading it with `sy = 1` would
   * change such a shape's proportions the moment it loaded, so the fallback is
   * the other axis rather than the identity.
   */
  it("falls back to the other axis when one authored size is missing", () => {
    const el = shapeElement({
      width: 200,
      height: 200,
      oWidth: 100,
      oHeight: undefined as any,
      shape: [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ],
    });
    const { canvas, ctx } = scene(200, 200, "#000000");
    renderShape(ctx, "s", el, 0);

    // Uniform 2x, exactly as it drew before `oHeight` was read at all.
    expect(pixel(canvas, 190, 190)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("draws at 1:1 rather than collapsing when no authored size is usable", () => {
    const el = shapeElement({
      width: 100,
      height: 100,
      oWidth: 0,
      oHeight: 0,
      shape: [
        [10, 10],
        [90, 10],
        [90, 90],
        [10, 90],
      ],
    });
    const { canvas, ctx } = scene(100, 100, "#000000");
    renderShape(ctx, "s", el, 0);

    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 2, 2)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("closes the path, so three points fill a triangle", () => {
    const el = shapeElement({
      width: 100,
      oWidth: 100,
      shape: [
        [10, 10],
        [90, 10],
        [50, 90],
      ],
    });
    const { canvas, ctx } = scene(100, 100, "#000000");
    renderShape(ctx, "s", el, 0);

    expect(pixel(canvas, 50, 40)).toMatchObject({ r: 255, g: 0, b: 0 });
    // outside the sloped edges
    expect(pixel(canvas, 12, 80)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("draws nothing for a shape with no points", () => {
    const { canvas, ctx } = scene(100, 100, "#000000");
    renderShape(ctx, "s", shapeElement({ shape: [] }), 0);
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 0, g: 0, b: 0 });
  });
});
