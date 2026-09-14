import { describe, it, expect } from "vitest";
import { renderShape } from "./shape";
import { renderElement } from "./element";
import { scene, pixel, points, keys, shapeElement } from "./testing";
import type { ShapeElementType, ShapeGeometry } from "../../@types/timeline";
import { shapePoints } from "../element/shapeElement";
import { normalizeShapeGeometry } from "../shape/shapeGeometry";
import { flattenOutline } from "../shape/shapeOutline";

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

/**
 * A shape generated from a recipe, rather than from a stored point list.
 *
 * Everything here goes through the **shipping** `renderShape`, onto the real
 * Skia surface `renderer/testing.ts` installs, and asserts on pixels. Nothing
 * is a mock: what is measured is the fill a user would see.
 */
describe("renderShape, from a recipe", () => {
  const RED = "#ff0000";

  const recipe = (
    kind: string,
    over: Record<string, unknown> = {},
    element: Partial<ShapeElementType> = {},
  ): ShapeElementType => {
    const geometry = normalizeShapeGeometry(kind as never, over) as ShapeGeometry;
    const width = (element.width as number) ?? 100;
    const height = (element.height as number) ?? 100;
    return shapeElement({
      width,
      height,
      oWidth: 100,
      oHeight: 100,
      option: { fillColor: RED },
      geometry,
      // What `shapeOps` would have written beside it. Supplied here so the
      // fixture is the pair the document actually holds rather than half of it.
      shape: flattenOutline(geometry, { width: 100, height: 100 }),
      ...element,
    } as never);
  };

  const draw = (element: ShapeElementType, w = 100, h = 100) => {
    const { canvas, ctx } = scene(w, h, "#000000");
    renderShape(ctx, "s", element, 0);
    return canvas;
  };

  const bytes = (canvas: ReturnType<typeof draw>, w = 100, h = 100) =>
    Array.from(canvas.getContext("2d").getImageData(0, 0, w, h).data);

  const filled = (canvas: ReturnType<typeof draw>, x: number, y: number) =>
    pixel(canvas, x, y).r > 200;

  const empty = (canvas: ReturnType<typeof draw>, x: number, y: number) =>
    pixel(canvas, x, y).r === 0;

  /**
   * The claim the whole feature rests on: **the recipe decides which branch
   * runs**, and a shape without one is drawn from its stored points exactly as
   * it always was.
   *
   * Asserted on one element with the field added and removed, so what is
   * measured is the branch rather than two fixtures that happen to agree. The
   * outline here is a quadrilateral no recipe would ever generate, which is
   * what makes "the stored points were used" observable at all.
   */
  it("draws the stored points when there is no recipe, and stops when there is", () => {
    const drawn = shapeElement({
      width: 100,
      height: 100,
      oWidth: 100,
      oHeight: 100,
      shape: [
        [10, 10],
        [90, 20],
        [70, 60],
        [20, 40],
      ],
      option: { fillColor: RED },
    });

    // The stored quadrilateral, and nothing else: a point inside it is filled
    // and the bottom of the box, which no part of it reaches, is not.
    expect(filled(draw(drawn), 45, 30)).toBe(true);
    expect(empty(draw(drawn), 50, 85)).toBe(true);

    // The same element with a recipe draws the recipe instead, and the corner
    // the quadrilateral never covered is now filled.
    const withRecipe = { ...drawn, geometry: { kind: "rectangle" } } as ShapeElementType;
    expect(filled(draw(withRecipe), 50, 85)).toBe(true);
    expect(bytes(draw(withRecipe))).not.toEqual(bytes(draw(drawn)));
  });

  /**
   * An axis-aligned rectangle rasterises identically whether its edges are
   * drawn as lines or as the degenerate cubics the recipe path uses, so this
   * one can be pinned to the byte. It is the strongest form of "a default
   * recipe is the shape it replaces".
   */
  it("draws a default rectangle exactly as the legacy point list does", () => {
    const legacy = shapeElement({
      width: 100,
      height: 100,
      oWidth: 100,
      oHeight: 100,
      shape: shapePoints("rectangle"),
      option: { fillColor: RED },
    });
    expect(bytes(draw(recipe("rectangle")))).toEqual(bytes(draw(legacy)));
  });

  /**
   * The triangle is the same shape but not the same bytes, and the reason is
   * worth stating rather than hiding behind a tolerance: every edge in the
   * recipe path is a cubic, including a straight one, and Skia antialiases a
   * degenerate cubic a hair differently from a line. Measured here so a real
   * geometric drift could not hide inside the allowance.
   */
  it("draws a default polygon as the legacy triangle, to within antialiasing", () => {
    const legacy = shapeElement({
      width: 100,
      height: 100,
      oWidth: 100,
      oHeight: 100,
      shape: shapePoints("triangle"),
      option: { fillColor: RED },
    });
    const a = bytes(draw(recipe("polygon")));
    const b = bytes(draw(legacy));

    let differing = 0;
    let worst = 0;
    for (let i = 0; i < a.length; i++) {
      const delta = Math.abs(a[i] - b[i]);
      if (delta > 0) {
        differing++;
        worst = Math.max(worst, delta);
      }
    }
    // A handful of channels on the two sloped edges, and nothing like a shifted
    // or reflected shape, which would run to thousands.
    expect(differing).toBeLessThan(400);
    expect(worst).toBeLessThan(40);

    // The interior and the four outside corners agree exactly, which is what
    // says the silhouette is the same one.
    expect(filled(draw(recipe("polygon")), 50, 60)).toBe(true);
    expect(empty(draw(recipe("polygon")), 4, 4)).toBe(true);
    expect(empty(draw(recipe("polygon")), 95, 4)).toBe(true);
  });

  /**
   * Four cubics rather than fifty straight facets.
   *
   * At a hundred pixels the two are not distinguishable by eye or by pixel: a
   * fiftieth of a turn falls about a tenth of a pixel short. The accuracy claim
   * is therefore measured where it can be, on the curve itself, in
   * `shape/shapeOutline.test.ts`. What is worth asserting here is that the
   * recipe draws an ellipse at all.
   */
  it("draws an ellipse that touches every edge and no corner", () => {
    const canvas = draw(recipe("ellipse"));
    expect(filled(canvas, 50, 50)).toBe(true);
    for (const [x, y] of [
      [50, 1],
      [98, 50],
      [50, 98],
      [1, 50],
    ]) {
      expect(filled(canvas, x, y), `edge at ${x},${y}`).toBe(true);
    }
    for (const [x, y] of [
      [4, 4],
      [95, 4],
      [95, 95],
      [4, 95],
    ]) {
      expect(empty(canvas, x, y), `corner at ${x},${y}`).toBe(true);
    }
  });

  describe("corner radius", () => {
    it("empties the corner and keeps the centre and the edges", () => {
      const canvas = draw(recipe("rectangle", { radius: 30 }));
      expect(empty(canvas, 2, 2)).toBe(true);
      expect(filled(canvas, 50, 50)).toBe(true);
      expect(filled(canvas, 50, 1)).toBe(true);
      expect(filled(canvas, 1, 50)).toBe(true);
    });

    it("does not turn the shape inside out past half the shorter side", () => {
      // `roundCorners` caps the trim at half each adjacent edge, so two corners
      // sharing a short edge cannot eat past the middle and cross into a bow
      // tie. A radius of ten times the clip is the way to find out.
      const canvas = draw(recipe("rectangle", { radius: 1000 }));
      expect(filled(canvas, 50, 50)).toBe(true);
      expect(filled(canvas, 50, 1)).toBe(true);
      expect(empty(canvas, 2, 2)).toBe(true);
    });

    it.each([
      [0, 2, 2],
      [1, 97, 2],
      [2, 97, 97],
      [3, 2, 97],
    ])("cuts only corner %i, clockwise from the top left", (index, x, y) => {
      const radius = [0, 0, 0, 0];
      radius[index] = 30;
      const canvas = draw(recipe("rectangle", { radius }));

      expect(empty(canvas, x, y), `corner ${index} should be cut`).toBe(true);
      for (const [ox, oy] of [
        [2, 2],
        [97, 2],
        [97, 97],
        [2, 97],
      ]) {
        if (ox === x && oy === y) {
          continue;
        }
        expect(filled(canvas, ox, oy), `corner at ${ox},${oy} should be square`).toBe(true);
      }
    });

    /**
     * The order `mask/place.ts` states, applied to a shape: scale to the drawn
     * size **first**, then round. Rounding in the authoring box instead would
     * stretch every corner into an ellipse along with the shape, so a corner on
     * a 400 by 50 clip would be eight times wider than it is tall.
     */
    it("keeps a corner circular on a stretched clip", () => {
      const canvas = draw(recipe("rectangle", {}, { width: 400, height: 50 }), 400, 50);
      const rounded = draw(
        recipe("rectangle", { radius: 20 }, { width: 400, height: 50 }),
        400,
        50,
      );
      expect(filled(canvas, 2, 2)).toBe(true);
      expect(empty(rounded, 2, 2)).toBe(true);
      // Twenty across and twenty down from the corner: both just past the arc,
      // which is only true if the arc is as tall as it is wide.
      expect(filled(rounded, 22, 1)).toBe(true);
      expect(filled(rounded, 1, 22)).toBe(true);
      // And a point well inside the arc on both axes is still cut.
      expect(empty(rounded, 4, 4)).toBe(true);
    });

    it("does nothing to an ellipse, which has no corners to cut", () => {
      expect(bytes(draw(recipe("ellipse", { radius: 30 })))).toEqual(
        bytes(draw(recipe("ellipse"))),
      );
    });
  });

  describe("polygon and star", () => {
    it.each([5, 6, 8])("puts a %i-gon's vertices on the box it fills", (count) => {
      const canvas = draw(recipe("polygon", { count }));
      // Whatever the count, the shape is fitted to the box, so the centre is
      // filled and all four corners of the box are outside it.
      expect(filled(canvas, 50, 50)).toBe(true);
      for (const [x, y] of [
        [1, 1],
        [98, 1],
        [98, 98],
        [1, 98],
      ]) {
        expect(empty(canvas, x, y), `${count}-gon at ${x},${y}`).toBe(true);
      }
    });

    it("draws a star with a point up and empty air between its points", () => {
      const canvas = draw(recipe("star"));
      expect(filled(canvas, 50, 4)).toBe(true);
      expect(filled(canvas, 50, 50)).toBe(true);
      // The point tapers rather than arriving square: the apex column fades
      // out over the first few rows, which is what a point is.
      expect(pixel(canvas, 50, 0).r).toBeLessThan(pixel(canvas, 50, 2).r);
      expect(pixel(canvas, 50, 2).r).toBeLessThan(pixel(canvas, 50, 4).r);
      // Between two points, near the box's corner: the notch reaches nowhere
      // near here.
      expect(empty(canvas, 6, 6)).toBe(true);
      expect(empty(canvas, 20, 20)).toBe(true);
    });

    it("makes a star spikier as its waist narrows", () => {
      const ink = (geometry: Record<string, unknown>) => {
        const canvas = draw(recipe("star", geometry));
        const data = canvas.getContext("2d").getImageData(0, 0, 100, 100).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 200) {
            count++;
          }
        }
        return count;
      };
      expect(ink({ innerRatio: 0.1 })).toBeLessThan(ink({ innerRatio: 0.9 }));
    });
  });

  describe("the ellipse's arc and hole", () => {
    it("cuts a hole through the middle", () => {
      const canvas = draw(recipe("ellipse", { hole: 0.5 }));
      expect(empty(canvas, 50, 50)).toBe(true);
      // The ring itself, between the hole's edge and the outer rim.
      expect(filled(canvas, 50, 6)).toBe(true);
      expect(filled(canvas, 6, 50)).toBe(true);
    });

    it("fills only the wedge an arc names", () => {
      // A quarter turn starting at 12 o'clock runs clockwise to 3 o'clock.
      const canvas = draw(recipe("ellipse", { arc: { start: 0, sweep: 90 } }));
      expect(filled(canvas, 70, 30)).toBe(true);
      expect(empty(canvas, 30, 30)).toBe(true);
      expect(empty(canvas, 70, 70)).toBe(true);
      expect(empty(canvas, 30, 70)).toBe(true);
    });

    it("moves the wedge when the start moves", () => {
      const canvas = draw(recipe("ellipse", { arc: { start: 180, sweep: 90 } }));
      // From 6 o'clock clockwise to 9 o'clock: the bottom left quadrant.
      expect(filled(canvas, 30, 70)).toBe(true);
      expect(empty(canvas, 70, 30)).toBe(true);
    });

    it("draws nothing at all for a sweep of zero", () => {
      const canvas = draw(recipe("ellipse", { arc: { start: 0, sweep: 0 } }));
      expect(empty(canvas, 50, 50)).toBe(true);
      expect(empty(canvas, 50, 2)).toBe(true);
    });
  });

  /**
   * Through `renderElement`, which is where the transform is applied, so this
   * is the one that says a generated outline survives the world matrix. A
   * rounded corner is a cubic precisely so that it maps through an affine
   * matrix exactly rather than approximately.
   */
  it("carries a rounded corner through a rotation", () => {
    const rounded = recipe("rectangle", { radius: 25 }, {
      location: { x: 50, y: 50 },
      rotation: 45,
    } as never);
    const square = recipe("rectangle", {}, {
      location: { x: 50, y: 50 },
      rotation: 45,
    } as never);

    const drawThrough = (element: ShapeElementType) => {
      const { canvas, ctx } = scene(200, 200, "#000000");
      renderElement(ctx, "s", element, 0, false, renderShape);
      return canvas;
    };

    // The clip's box is (50,50) to (150,150), so turned 45 degrees about its
    // centre the square's corner points straight down and reaches about
    // y = 170. The rounded one is cut back to about y = 158.
    expect(filled(drawThrough(square), 100, 165)).toBe(true);
    expect(empty(drawThrough(rounded), 100, 165)).toBe(true);
    // Both still cover their middle, so the rounding cut a corner rather than
    // moving or shrinking the whole shape.
    expect(filled(drawThrough(rounded), 100, 120)).toBe(true);
    expect(filled(drawThrough(square), 100, 120)).toBe(true);
  });
});
