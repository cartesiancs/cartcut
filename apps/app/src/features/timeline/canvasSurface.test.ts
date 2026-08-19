import { describe, it, expect } from "vitest";
import {
  applySurface,
  surfaceSpec,
  type SizableCanvas,
  type TransformableContext,
} from "./canvasSurface";
import {
  RULER_OFFSET,
  TRACK_PITCH,
  hitTest,
  layoutTimeline,
  rowTop,
} from "./layout";
import { SCHEMA_VERSION, createTrack, normalizeDocument } from "./tracks";
import { imageElement } from "../renderer/testing";

/** A stand-in for a canvas, so this can run under vitest's `node` environment. */
function fakeCanvas(): SizableCanvas & { style: { width: string; height: string } } {
  return { width: 0, height: 0, style: { width: "", height: "" } };
}

function fakeContext(): TransformableContext & { calls: number[][] } {
  const calls: number[][] = [];
  return {
    calls,
    setTransform(a, b, c, d, e, f) {
      calls.push([a, b, c, d, e, f]);
    },
  };
}

describe("surfaceSpec", () => {
  it("gives all four numbers for a 2x display", () => {
    expect(surfaceSpec(800, 400, 2)).toEqual({
      attrWidth: 1600,
      attrHeight: 800,
      styleWidth: "800px",
      styleHeight: "400px",
      transform: [2, 0, 0, 2, 0, 0],
    });
  });

  // The bug this module exists for: `style.height` was never written, so the
  // used CSS height fell back to the attribute and the vertical mapping was off
  // by exactly `dpr`.
  it.each([1, 1.25, 1.5, 2, 3])(
    "keeps the CSS box at the layout size at dpr %s",
    (dpr) => {
      const spec = surfaceSpec(800, 400, dpr);
      expect(parseFloat(spec.styleHeight)).toBe(400);
      expect(parseFloat(spec.styleWidth)).toBe(800);
      expect(spec.attrHeight).toBe(Math.round(400 * dpr));
      expect(spec.attrWidth).toBe(Math.round(800 * dpr));
    },
  );

  it("scales both axes by the same factor", () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const spec = surfaceSpec(800, 400, dpr);
      expect(spec.attrWidth / parseFloat(spec.styleWidth)).toBeCloseTo(
        spec.attrHeight / parseFloat(spec.styleHeight),
      );
    }
  });

  it.each([0, -1, NaN, Infinity, -Infinity, undefined as any, null as any])(
    "falls back to 1 for a nonsense dpr of %s",
    (dpr) => {
      const spec = surfaceSpec(800, 400, dpr);
      expect(spec.transform).toEqual([1, 0, 0, 1, 0, 0]);
      expect(spec.attrWidth).toBe(800);
      expect(spec.attrHeight).toBe(400);
    },
  );

  it("never asks for a zero-sized backing store", () => {
    // `element-timeline` measures 0 high before the split pane lays out, and a
    // 0x0 canvas throws in some engines.
    const spec = surfaceSpec(0, 0, 2);
    expect(spec.attrWidth).toBe(1);
    expect(spec.attrHeight).toBe(1);
    expect(spec.styleWidth).toBe("0px");
    expect(spec.styleHeight).toBe("0px");
  });

  it("treats a negative or non-finite size as zero", () => {
    for (const bad of [-100, NaN, Infinity]) {
      expect(surfaceSpec(bad, bad, 1).styleWidth).toBe("0px");
    }
  });

  it("rounds the backing store to whole pixels on a fractional dpr", () => {
    const spec = surfaceSpec(801, 401, 1.5);
    expect(Number.isInteger(spec.attrWidth)).toBe(true);
    expect(Number.isInteger(spec.attrHeight)).toBe(true);
  });
});

describe("applySurface", () => {
  it("writes all four numbers and the transform", () => {
    const canvas = fakeCanvas();
    const ctx = fakeContext();

    applySurface(canvas, ctx, surfaceSpec(800, 400, 2));

    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(800);
    expect(canvas.style.width).toBe("800px");
    expect(canvas.style.height).toBe("400px");
    expect(ctx.calls).toEqual([[2, 0, 0, 2, 0, 0]]);
  });

  it("sets the transform after the attributes", () => {
    // Assigning `width`/`height` resets the 2D context, transform included, so
    // the order is not cosmetic.
    const ctx = fakeContext();
    const canvas: SizableCanvas = {
      width: 0,
      height: 0,
      style: { width: "", height: "" },
    };
    const order: string[] = [];
    const tracked = {
      style: canvas.style,
      set width(v: number) {
        order.push("width");
      },
      set height(v: number) {
        order.push("height");
      },
      get width() {
        return 0;
      },
      get height() {
        return 0;
      },
    };
    applySurface(tracked as any, {
      setTransform: () => order.push("setTransform"),
    }, surfaceSpec(800, 400, 2));

    expect(order.indexOf("setTransform")).toBeGreaterThan(order.indexOf("width"));
    expect(order.indexOf("setTransform")).toBeGreaterThan(order.indexOf("height"));
  });
});

/**
 * The bug expressed as the user saw it: a click one pixel into row 1 must
 * select row 1, on every display.
 */
describe("hit-testing under a correctly sized surface", () => {
  const doc = normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0), createTrack("v2", "video", 1)],
    elements: {
      a: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }),
      b: imageElement({ trackId: "v2", startTime: 0, duration: 4000 }),
    },
  });

  it.each([1, 1.25, 1.5, 2, 3])(
    "maps offsetY into the right row at dpr %s",
    (dpr) => {
      const cssW = 1000;
      const cssH = 500;
      const spec = surfaceSpec(cssW, cssH, dpr);

      // Layout works in CSS px, and with `style.height` set the element's box
      // is exactly `cssH` CSS px tall — so an `offsetY` in CSS px indexes
      // straight into the layout with no dpr term anywhere.
      expect(parseFloat(spec.styleHeight)).toBe(cssH);

      const layout = layoutTimeline({
        doc,
        range: 0.9,
        hScroll: 0,
        vScroll: 0,
        viewportW: cssW,
        viewportH: cssH,
      });

      const intoRow1 = rowTop(1, 0, RULER_OFFSET) + 1;
      expect(hitTest(layout, 10, intoRow1)).toMatchObject({
        kind: "clip",
        elementId: "b",
      });

      const intoRow0 = rowTop(0, 0, RULER_OFFSET) + 1;
      expect(hitTest(layout, 10, intoRow0)).toMatchObject({
        kind: "clip",
        elementId: "a",
      });
    },
  );

  it("would have selected the wrong row under the old three-number sizing", () => {
    // Documents the regression rather than the fix. With the CSS box left at
    // `height * dpr`, content laid out at logical y appeared at CSS `y * dpr`,
    // so a user aiming at row 1 pressed at CSS `rowTop(1) * dpr` — while
    // `hitTest` compared that number against the *logical* row bands. The error
    // is `rowTop(n) * (dpr - 1)` and grows with the row index, so it is not
    // absorbed by the 40px row height.
    const layout = layoutTimeline({
      doc,
      range: 0.9,
      hScroll: 0,
      vScroll: 0,
      viewportW: 1000,
      viewportH: 500,
    });

    // Correct sizing: the press lands where it was aimed.
    const aimedAtRow1 = rowTop(1, 0, RULER_OFFSET) + 1;
    expect(hitTest(layout, 10, aimedAtRow1)).toMatchObject({ elementId: "b" });

    // Broken sizing at dpr 2: the same intent arrives doubled, and misses.
    const asItArrived = aimedAtRow1 * 2;
    expect(asItArrived).toBeGreaterThanOrEqual(
      rowTop(1, 0, RULER_OFFSET) + TRACK_PITCH,
    );
    expect(hitTest(layout, 10, asItArrived)).not.toMatchObject({
      elementId: "b",
    });
  });
});
