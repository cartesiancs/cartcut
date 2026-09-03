import { describe, expect, it } from "vitest";

import {
  rippleAt,
  RIPPLE_MS,
  simplifyStroke,
  strokeAlphaAt,
  strokeCubics,
  STROKE_FADE_MS,
  STROKE_HOLD_MS,
  strokePrefix,
  visibleStrokes,
  type Stroke,
  type StrokePoint,
} from "./strokeRender";

function line(fromMs: number, count: number): StrokePoint[] {
  return Array.from({ length: count }, (_, index) => ({
    t: fromMs + index * 50,
    x: index * 10,
    y: 100,
  }));
}

const STROKE: Stroke = {
  id: "s1",
  color: "#ff2d55",
  width: 6,
  points: line(1000, 5),
};

/** The stroke's last point, so the fade times are readable in the tests. */
const LAST_T = 1000 + 4 * 50;

describe("strokeAlphaAt", () => {
  it("is invisible before it was started", () => {
    expect(strokeAlphaAt(STROKE, 999)).toBe(0);
  });

  it("is fully visible while it is being drawn", () => {
    expect(strokeAlphaAt(STROKE, 1000)).toBe(1);
    expect(strokeAlphaAt(STROKE, LAST_T)).toBe(1);
  });

  it("stays up for the hold, then fades", () => {
    expect(strokeAlphaAt(STROKE, LAST_T + STROKE_HOLD_MS)).toBe(1);
    expect(
      strokeAlphaAt(STROKE, LAST_T + STROKE_HOLD_MS + STROKE_FADE_MS / 2),
    ).toBeCloseTo(0.5, 6);
  });

  // A hard cut draws the eye to the disappearance, which is where the attention
  // should least be by then.
  it("reaches nothing rather than jumping to it", () => {
    expect(
      strokeAlphaAt(STROKE, LAST_T + STROKE_HOLD_MS + STROKE_FADE_MS),
    ).toBe(0);
    expect(strokeAlphaAt(STROKE, 1e9)).toBe(0);
  });

  it("is invisible when there is nothing to draw", () => {
    expect(strokeAlphaAt({ ...STROKE, points: [] }, 1000)).toBe(0);
    expect(strokeAlphaAt(STROKE, Number.NaN)).toBe(0);
  });
});

describe("strokePrefix", () => {
  // The line arrives as it was made — which is the only reason to draw on a
  // recording at all.
  it("gives only the part that had been drawn by then", () => {
    expect(strokePrefix(STROKE, 1100)).toHaveLength(3);
    expect(strokePrefix(STROKE, 1e9)).toHaveLength(5);
    expect(strokePrefix(STROKE, 0)).toHaveLength(0);
  });

  it("keeps a single point, so a tap leaves a dot", () => {
    expect(strokePrefix(STROKE, 1000)).toHaveLength(1);
  });
});

describe("visibleStrokes", () => {
  const strokes: Stroke[] = [
    STROKE,
    { ...STROKE, id: "s2", points: line(9000, 5) },
  ];

  it("skips what has not started and what has finished fading", () => {
    const visible = visibleStrokes(strokes, 1100);

    expect(visible).toHaveLength(1);
    expect(visible[0].stroke.id).toBe("s1");
    expect(visible[0].points).toHaveLength(3);
    expect(visible[0].alpha).toBe(1);
  });

  it("shows nothing at a moment neither stroke covers", () => {
    expect(visibleStrokes(strokes, 8000)).toHaveLength(0);
  });
});

describe("rippleAt", () => {
  const click = { t: 500, x: 100, y: 200 };

  it("is nothing before and after its life", () => {
    expect(rippleAt(click, 499)).toBeNull();
    expect(rippleAt(click, 500 + RIPPLE_MS)).toBeNull();
  });

  it("grows while it fades", () => {
    const early = rippleAt(click, 550)!;
    const late = rippleAt(click, 900)!;

    expect(late.radius).toBeGreaterThan(early.radius);
    expect(late.alpha).toBeLessThan(early.alpha);
  });

  it("starts from nothing at full opacity", () => {
    const first = rippleAt(click, 500)!;
    expect(first.radius).toBe(0);
    expect(first.alpha).toBe(1);
  });
});

describe("simplifyStroke", () => {
  it("collapses a straight run to its endpoints", () => {
    const straight: StrokePoint[] = Array.from({ length: 50 }, (_, index) => ({
      t: index,
      x: index,
      y: 0,
    }));

    expect(simplifyStroke(straight)).toHaveLength(2);
  });

  it("keeps the endpoints exactly where the pointer was", () => {
    const points = line(0, 20);
    const simplified = simplifyStroke(points);

    expect(simplified[0]).toEqual(points[0]);
    expect(simplified[simplified.length - 1]).toEqual(
      points[points.length - 1],
    );
  });

  // Distance to the *segment*, not to the infinite line through the endpoints:
  // otherwise a stroke that doubles back gets eaten whole.
  it("keeps the fold in a stroke that doubles back on itself", () => {
    const out: StrokePoint[] = Array.from({ length: 20 }, (_, index) => ({
      t: index,
      x: index * 10,
      y: 0,
    }));
    const back: StrokePoint[] = Array.from({ length: 20 }, (_, index) => ({
      t: 20 + index,
      x: 190 - index * 10,
      y: 1,
    }));

    const simplified = simplifyStroke(out.concat(back));

    expect(simplified.length).toBeGreaterThan(2);
    expect(Math.max(...simplified.map((point) => point.x))).toBe(190);
  });

  it("passes a stroke too short to simplify straight through", () => {
    const two = line(0, 2);
    expect(simplifyStroke(two)).toEqual(two);
    expect(simplifyStroke([])).toEqual([]);
  });

  it("returns each point once", () => {
    const zigzag: StrokePoint[] = Array.from({ length: 40 }, (_, index) => ({
      t: index,
      x: index * 5,
      y: index % 2 === 0 ? 0 : 40,
    }));

    const simplified = simplifyStroke(zigzag, 0.5);
    const times = simplified.map((point) => point.t);

    expect(new Set(times).size).toBe(times.length);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("strokeCubics", () => {
  it("gives one cubic per gap between points", () => {
    expect(strokeCubics(line(0, 5))).toHaveLength(4);
    expect(strokeCubics(line(0, 1))).toHaveLength(0);
    expect(strokeCubics([])).toHaveLength(0);
  });

  it("interpolates through every point it was given", () => {
    const points = line(0, 5);
    const cubics = strokeCubics(points);

    cubics.forEach((cubic, index) => {
      expect(cubic.from).toEqual({ x: points[index].x, y: points[index].y });
      expect(cubic.to).toEqual({
        x: points[index + 1].x,
        y: points[index + 1].y,
      });
    });
  });

  it("keeps a straight run straight", () => {
    for (const cubic of strokeCubics(line(0, 6))) {
      expect(cubic.c1.y).toBeCloseTo(100, 9);
      expect(cubic.c2.y).toBeCloseTo(100, 9);
    }
  });

  // Duplicated terminal points give the curve zero curvature at the ends rather
  // than an invented flick past the last place the pointer was.
  it("does not overshoot at the ends", () => {
    const points = line(0, 4);
    const cubics = strokeCubics(points);
    const last = cubics[cubics.length - 1];

    expect(last.c2.x).toBeLessThanOrEqual(last.to.x);
    expect(cubics[0].c1.x).toBeGreaterThanOrEqual(cubics[0].from.x);
  });
});
