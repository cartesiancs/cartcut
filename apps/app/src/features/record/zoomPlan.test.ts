import { describe, expect, it } from "vitest";

import {
  clampCenter,
  findDwells,
  planZoom,
  sampleZoom,
  smoothstep,
  visibleRectFor,
  zoomScaleFor,
  type CursorSample,
} from "./zoomPlan";

const FRAME = { width: 1000, height: 1000 };

/** A cursor parked at one place for `durationMs`, sampled every 100ms. */
function still(
  x: number,
  y: number,
  fromMs: number,
  durationMs: number,
): CursorSample[] {
  const samples: CursorSample[] = [];
  for (let t = fromMs; t <= fromMs + durationMs; t += 100) {
    samples.push({ t, x, y });
  }
  return samples;
}

/** A cursor travelling in a straight line, sampled every 100ms. */
function sweep(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromMs: number,
  durationMs: number,
): CursorSample[] {
  const samples: CursorSample[] = [];
  for (let t = 0; t <= durationMs; t += 100) {
    const p = t / durationMs;
    samples.push({
      t: fromMs + t,
      x: from.x + (to.x - from.x) * p,
      y: from.y + (to.y - from.y) * p,
    });
  }
  return samples;
}

describe("smoothstep", () => {
  it("pins both ends and is symmetric about the middle", () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 12);
  });

  it("clamps outside the unit interval", () => {
    expect(smoothstep(-3)).toBe(0);
    expect(smoothstep(4)).toBe(1);
  });

  // Zero velocity at both ends is the whole reason for it — a linear ramp makes
  // the zoom snap into and out of motion.
  it("barely moves at the very start", () => {
    expect(smoothstep(0.02)).toBeLessThan(0.01);
  });
});

describe("clampCenter", () => {
  // Without this a zoom onto a corner shows whatever the canvas was cleared to.
  it("keeps the viewport inside the frame", () => {
    const { cx, cy } = clampCenter(0, 0, 2, FRAME);
    expect(cx).toBe(250);
    expect(cy).toBe(250);
  });

  it("leaves a centre that already fits alone", () => {
    expect(clampCenter(500, 500, 2, FRAME)).toEqual({ cx: 500, cy: 500 });
  });

  it("pins the centre when there is no room to move at all", () => {
    expect(clampCenter(0, 0, 1, FRAME)).toEqual({ cx: 500, cy: 500 });
  });
});

describe("visibleRectFor", () => {
  it("is the whole frame at 1×", () => {
    expect(visibleRectFor({ scale: 1, cx: 500, cy: 500 }, FRAME)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 1000,
    });
  });

  it("halves both axes at 2× and stays inside the frame", () => {
    const rect = visibleRectFor({ scale: 2, cx: 0, cy: 900 }, FRAME);

    expect(rect.width).toBe(500);
    expect(rect.height).toBe(500);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y + rect.height).toBeLessThanOrEqual(1000);
  });
});

describe("findDwells", () => {
  it("finds a cursor that stopped", () => {
    const dwells = findDwells(still(200, 200, 0, 3000), FRAME);

    expect(dwells).toHaveLength(1);
    expect(dwells[0]).toMatchObject({ start: 0, end: 3000, cx: 200, cy: 200 });
  });

  it("finds nothing in a cursor that never stopped", () => {
    expect(findDwells(sweep({ x: 0, y: 0 }, { x: 1000, y: 1000 }, 0, 3000), FRAME))
      .toHaveLength(0);
  });

  // A pause of a few hundred milliseconds is somebody thinking, not somebody
  // settling on a thing to look at.
  it("ignores a pause shorter than the minimum", () => {
    expect(findDwells(still(200, 200, 0, 400), FRAME)).toHaveLength(0);
  });

  // Centroid rather than "within radius of the first sample": otherwise a slow
  // drift walks the run across the screen a pixel at a time and the whole
  // journey reads as one dwell.
  it("does not let a slow drift pass as a dwell", () => {
    const drift = sweep({ x: 100, y: 100 }, { x: 900, y: 100 }, 0, 20_000);
    const dwells = findDwells(drift, FRAME);

    for (const dwell of dwells) {
      expect(dwell.end - dwell.start).toBeLessThan(6000);
    }
  });

  it("separates two dwells with a move between them", () => {
    const samples = [
      ...still(200, 200, 0, 2000),
      ...sweep({ x: 200, y: 200 }, { x: 800, y: 800 }, 2100, 600),
      ...still(800, 800, 2800, 2000),
    ];

    const dwells = findDwells(samples, FRAME);

    expect(dwells).toHaveLength(2);
    expect(dwells[0].cx).toBeCloseTo(200, 0);
    expect(dwells[1].cx).toBeCloseTo(800, 0);
  });

  it("survives unordered and unreadable samples", () => {
    const samples = [
      { t: 1000, x: 200, y: 200 },
      { t: Number.NaN, x: 200, y: 200 },
      { t: 0, x: 200, y: 200 },
      { t: 2000, x: Number.NaN, y: 200 },
      { t: 3000, x: 200, y: 200 },
    ];

    expect(() => findDwells(samples, FRAME)).not.toThrow();
    expect(findDwells(samples, FRAME)).toHaveLength(1);
  });
});

describe("planZoom", () => {
  const samples = still(200, 200, 0, 3000);

  it("plans nothing when the auto-zoom is off", () => {
    expect(planZoom(samples, FRAME, "off", 4000)).toEqual([]);
  });

  it("plans nothing from an empty track", () => {
    expect(planZoom([], FRAME, "subtle", 4000)).toEqual([]);
  });

  // The reason the composite pass runs after the take rather than during it:
  // the zoom has to be moving before the cursor arrives.
  it("starts the zoom before the cursor settles", () => {
    const [segment] = planZoom(still(200, 200, 2000, 3000), FRAME, "subtle", 8000);

    expect(segment.inStart).toBe(1500);
    expect(segment.inStart).toBeLessThan(2000);
  });

  it("clamps the lookahead at the start of the recording", () => {
    const [segment] = planZoom(samples, FRAME, "subtle", 4000);
    expect(segment.inStart).toBe(0);
  });

  it("keeps the four instants in order and inside the recording", () => {
    for (const segment of planZoom(samples, FRAME, "strong", 4000)) {
      expect(segment.inStart).toBeLessThanOrEqual(segment.inEnd);
      expect(segment.inEnd).toBeLessThanOrEqual(segment.outStart);
      expect(segment.outStart).toBeLessThanOrEqual(segment.outEnd);
      expect(segment.outEnd).toBeLessThanOrEqual(4000);
    }
  });

  it("pushes harder on strong than on subtle", () => {
    const subtle = planZoom(samples, FRAME, "subtle", 4000);
    const strong = planZoom(samples, FRAME, "strong", 4000);
    expect(strong[0].scale).toBeGreaterThan(subtle[0].scale);
    expect(subtle[0].scale).toBe(zoomScaleFor("subtle"));
  });

  it("clamps the centre so the zoomed frame stays on screen", () => {
    const corner = planZoom(still(10, 10, 0, 3000), FRAME, "subtle", 4000);
    const half = 1000 / (2 * zoomScaleFor("subtle"));
    expect(corner[0].cx).toBeCloseTo(half, 6);
    expect(corner[0].cy).toBeCloseTo(half, 6);
  });

  // A move that zooms in and straight back out reads as a glitch, not emphasis.
  it("drops a dwell too short to hold at full zoom", () => {
    expect(planZoom(still(200, 200, 0, 1000), FRAME, "subtle", 4000)).toEqual(
      [],
    );
  });

  it("never overlaps two moves", () => {
    const path = [
      ...still(200, 200, 0, 3000),
      ...sweep({ x: 200, y: 200 }, { x: 800, y: 800 }, 3100, 300),
      ...still(800, 800, 3400, 3000),
      ...sweep({ x: 800, y: 800 }, { x: 200, y: 700 }, 6500, 300),
      ...still(200, 700, 6800, 4000),
    ];

    const segments = planZoom(path, FRAME, "strong", 12_000);
    expect(segments.length).toBeGreaterThan(1);

    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index].inStart).toBeGreaterThanOrEqual(
        segments[index - 1].outEnd,
      );
    }
  });
});

describe("sampleZoom", () => {
  const segments = planZoom(still(200, 200, 2000, 4000), FRAME, "subtle", 9000);

  it("is the identity view outside every move", () => {
    expect(sampleZoom(segments, 0, FRAME)).toEqual({
      scale: 1,
      cx: 500,
      cy: 500,
    });
    expect(sampleZoom(segments, 8999, FRAME)).toEqual({
      scale: 1,
      cx: 500,
      cy: 500,
    });
  });

  it("is the identity view when there is no plan at all", () => {
    expect(sampleZoom([], 1234, FRAME)).toEqual({
      scale: 1,
      cx: 500,
      cy: 500,
    });
  });

  it("holds at full scale between the two eases", () => {
    const [segment] = segments;
    const middle = (segment.inEnd + segment.outStart) / 2;
    const view = sampleZoom(segments, middle, FRAME);

    expect(view.scale).toBeCloseTo(segment.scale, 12);
    expect(view.cx).toBeCloseTo(segment.cx, 12);
  });

  // Scale and centre ride the same eased parameter, so a zoom is one gesture
  // rather than a push and a pan that happen to overlap.
  it("moves the centre and the scale together", () => {
    const [segment] = segments;
    const quarter =
      segment.inStart + (segment.inEnd - segment.inStart) * 0.25;
    const view = sampleZoom(segments, quarter, FRAME);

    const scaleProgress = (view.scale - 1) / (segment.scale - 1);
    const centreProgress = (view.cx - 500) / (segment.cx - 500);

    expect(centreProgress).toBeCloseTo(scaleProgress, 9);
  });

  // The property the "clamp once, then travel" comment in `sampleZoom` rests
  // on: lerping a centre clamped at the segment's full scale cannot leave the
  // frame at any lower scale on the way there.
  it("never shows anything outside the frame, at any point in the ease", () => {
    for (let t = 0; t <= 9000; t += 13) {
      const rect = visibleRectFor(sampleZoom(segments, t, FRAME), FRAME);

      expect(rect.x).toBeGreaterThanOrEqual(-1e-9);
      expect(rect.y).toBeGreaterThanOrEqual(-1e-9);
      expect(rect.x + rect.width).toBeLessThanOrEqual(FRAME.width + 1e-9);
      expect(rect.y + rect.height).toBeLessThanOrEqual(FRAME.height + 1e-9);
    }
  });

  it("never returns a scale outside [1, segment.scale]", () => {
    const [segment] = segments;
    for (let t = 0; t <= 9000; t += 37) {
      const view = sampleZoom(segments, t, FRAME);
      expect(view.scale).toBeGreaterThanOrEqual(1);
      expect(view.scale).toBeLessThanOrEqual(segment.scale + 1e-12);
    }
  });

  it("answers the identity view for an unreadable instant", () => {
    expect(sampleZoom(segments, Number.NaN, FRAME).scale).toBe(1);
  });
});
