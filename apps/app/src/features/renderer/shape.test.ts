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

  it("scales authoring-space points down by oWidth / width", () => {
    // The same points authored at 200px wide, rendered into a 100px box: the
    // shape halves, so (10,10)-(90,90) becomes (5,5)-(45,45).
    const el = shapeElement({
      width: 100,
      oWidth: 200,
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
