import { describe, it, expect } from "vitest";
import { renderShape } from "./shape";
import { renderElement } from "./element";
import { scene, pixel, points, keys, shapeElement } from "./testing";
import type { ShapeElementType } from "../../@types/timeline";

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

/**
 * A shape carries the same four-track `animation` block as an image, and gets
 * its position, scale and rotation from `localMatrixOf` like every other
 * element — `renderShape` itself never sees them. So these go through
 * `renderElement`, which is where the transform is applied, rather than calling
 * the renderer directly as the suite above does.
 *
 * It carried `opacity` alone until this was implemented, and the gate was
 * `animatableProperties`. Nothing in the draw path changed to allow it, which
 * is exactly what makes it worth pinning: the capability is now a property of
 * the type, and a regression there would be silent everywhere else.
 */
describe("an animated shape, through renderElement", () => {
  /** A 40px red square at the origin of its own space. */
  const square = (over: Partial<ShapeElementType> = {}) =>
    shapeElement({
      width: 40,
      height: 40,
      oWidth: 40,
      oHeight: 40,
      location: { x: 0, y: 0 },
      shape: [
        [0, 0],
        [40, 0],
        [40, 40],
        [0, 40],
      ],
      option: { fillColor: "#ff0000" },
      ...over,
    });

  const draw = (el: ShapeElementType, cursor: number) => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    renderElement(ctx, "s", el, cursor, false, renderShape);
    return canvas;
  };

  const isRed = (canvas: ReturnType<typeof draw>, x: number, y: number) =>
    pixel(canvas, x, y).r > 200;

  it("moves along its position track", () => {
    // (0,0) at t=0 travelling to (100,100) at t=1000. `sampleBaked` snaps to the
    // nearest baked sample rather than interpolating, so the endpoints are what
    // this asserts on — the midpoint would pin the bake rate, not the feature.
    const el = square({
      animation: {
        ...(square().animation as any),
        position: {
          isActivate: true,
          x: keys([0, 0], [1000, 100]),
          y: keys([0, 0], [1000, 100]),
          ax: points([0, 0], [1000, 100]),
          ay: points([0, 0], [1000, 100]),
        },
      } as any,
    });

    expect(isRed(draw(el, 0), 20, 20)).toBe(true);
    expect(isRed(draw(el, 0), 120, 120)).toBe(false);

    expect(isRed(draw(el, 1000), 120, 120)).toBe(true);
    expect(isRed(draw(el, 1000), 20, 20)).toBe(false);
  });

  it("spins about its centre on its rotation track", () => {
    // 45° about the centre of a 40px square at (80,80): the corners swing out to
    // the diagonal, so the point just past the flat right edge becomes covered
    // and the original corner does not.
    const el = square({
      location: { x: 80, y: 80 },
      rotation: 0,
      animation: {
        ...(square().animation as any),
        rotation: {
          isActivate: true,
          x: keys([0, 0], [1000, 45]),
          ax: points([0, 0], [1000, 45]),
        },
      } as any,
    });

    // Unrotated: the corner is filled, and nothing sits beyond the right edge.
    expect(isRed(draw(el, 0), 82, 82)).toBe(true);
    expect(isRed(draw(el, 0), 124, 100)).toBe(false);

    // Rotated 45°: the corner has swung away and the diagonal reaches further.
    expect(isRed(draw(el, 1000), 82, 82)).toBe(false);
    expect(isRed(draw(el, 1000), 124, 100)).toBe(true);
  });

  it("falls back to the static field while a track is inactive", () => {
    // The whole reason old shapes keep rendering correctly: `track()` returns
    // the static value unless `isActivate` is set, so keyframes that exist but
    // are switched off move nothing.
    const el = square({
      location: { x: 0, y: 0 },
      animation: {
        ...(square().animation as any),
        position: {
          isActivate: false,
          x: keys([0, 100]),
          y: keys([0, 100]),
          ax: points([0, 100]),
          ay: points([0, 100]),
        },
      } as any,
    });

    expect(isRed(draw(el, 0), 20, 20)).toBe(true);
    expect(isRed(draw(el, 0), 120, 120)).toBe(false);
  });
});
