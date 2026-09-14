import { describe, it, expect } from "vitest";

import type { PathNode, ShapeGeometry } from "../../@types/timeline";
import { shapePoints } from "../element/shapeElement";
import { isCorner, segmentsOf } from "../mask/geometry";
import { templateNodes } from "../mask/templates";
import { normalizeShapeGeometry } from "./shapeGeometry";
import {
  ELLIPSE_FLATTEN_SEGMENTS,
  MAX_SHAPE_COUNT,
  MIN_SHAPE_COUNT,
  countOf,
  flattenOutline,
  innerRatioOf,
  outlineBounds,
  outlineInBox,
  radiusAtOf,
  shapeOutlineNodes,
  starInnerRatioFor,
} from "./shapeOutline";

const BOX = { width: 100, height: 100 };

const g = (kind: string, over: Record<string, unknown> = {}): ShapeGeometry =>
  normalizeShapeGeometry(kind as never, over);

/** Point order is a winding decision, not an identity one: compare as sets. */
const asSet = (points: number[][]): string[] =>
  points.map((p) => `${p[0].toFixed(9)},${p[1].toFixed(9)}`).sort();

/**
 * The signed area of a subpath's anchors, shoelace.
 *
 * In the y-down space everything here is authored in, **clockwise is
 * positive**. Every shape in the app must come out positive except a hole,
 * which is the whole mechanism by which the default nonzero fill rule puts a
 * hole there rather than a second filled disc.
 */
function signedArea(nodes: readonly PathNode[]): number {
  let sum = 0;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i].p;
    const b = nodes[(i + 1) % nodes.length].p;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Every node's coordinate and handle, for a blanket finiteness check. */
function everyNumber(nodes: readonly PathNode[]): number[] {
  return nodes.flatMap((node) => [
    node.p[0],
    node.p[1],
    ...(node.cs ?? []),
    ...(node.ce ?? []),
  ]);
}

describe("the generated outline fits its box", () => {
  /**
   * The invariant `mask/templates.ts` states, applied to every recipe rather
   * than to three constants: 100 by 100 is the element box whichever shape is
   * in it. Without it, switching from polygon to star would shrink the shape by
   * however much empty room a star's circumscribed circle happens to leave.
   */
  it.each([
    ["rectangle", g("rectangle")],
    ["rounded rectangle", g("rectangle", { radius: 20 })],
    ["triangle", g("polygon", { count: 3 })],
    ["pentagon", g("polygon", { count: 5 })],
    ["60-gon", g("polygon", { count: 60 })],
    ["star", g("star")],
    ["spiky star", g("star", { count: 8, innerRatio: 0.1 })],
    ["fat star", g("star", { count: 8, innerRatio: 0.95 })],
    ["ellipse", g("ellipse")],
    ["donut", g("ellipse", { hole: 0.6 })],
  ])("fills the unit square: %s", (_label, geometry) => {
    const bounds = outlineBounds(geometry)!;
    expect(bounds.minX).toBeCloseTo(-0.5, 9);
    expect(bounds.maxX).toBeCloseTo(0.5, 9);
    expect(bounds.minY).toBeCloseTo(-0.5, 9);
    expect(bounds.maxY).toBeCloseTo(0.5, 9);
  });

  /**
   * An arc is carved inside the ellipse's frame rather than refitted to its own
   * extent. Refitting would resize the shape every time the sweep slider moved,
   * which is not what a sweep slider is for.
   */
  it("does not resize an ellipse when its sweep changes", () => {
    const quarter = outlineBounds(g("ellipse", { arc: { start: 0, sweep: 90 } }))!;
    expect(quarter.minY).toBeCloseTo(-0.5, 9);
    expect(quarter.maxX).toBeCloseTo(0.5, 9);
    // The wedge runs from 12 to 3 o'clock, so it reaches the centre and no
    // further on the other two sides: proof it was not stretched to fill.
    expect(quarter.minX).toBeCloseTo(0, 9);
    expect(quarter.maxY).toBeCloseTo(0, 9);
  });
});

describe("node counts and corners", () => {
  it.each([
    ["rectangle", g("rectangle"), 4],
    ["triangle", g("polygon", { count: 3 }), 3],
    ["heptagon", g("polygon", { count: 7 }), 7],
    ["5-point star", g("star", { count: 5 }), 10],
    ["12-point star", g("star", { count: 12 }), 24],
    ["ellipse", g("ellipse"), 4],
  ])("%s has %i nodes", (_label, geometry, count) => {
    expect(shapeOutlineNodes(geometry)[0]).toHaveLength(count as number);
  });

  /**
   * The one fact rounding is decided by. A rectangle, a polygon and a star are
   * all corners, so `roundCorners` softens them with no shape name appearing in
   * it; an ellipse carries a handle on every node, so rounding an ellipse
   * correctly does nothing at all rather than being special-cased away.
   */
  it.each([
    ["rectangle", g("rectangle")],
    ["polygon", g("polygon", { count: 6 })],
    ["star", g("star")],
  ])("%s is all corners", (_label, geometry) => {
    expect(shapeOutlineNodes(geometry)[0].every(isCorner)).toBe(true);
  });

  it("an ellipse has no corners", () => {
    expect(shapeOutlineNodes(g("ellipse"))[0].some(isCorner)).toBe(false);
  });

  /**
   * A pie has exactly one corner: the centre.
   *
   * The two ends of the arc carry one handle each, so they are cusps. That is
   * also the only answer rounding could use, because `roundCorners` needs a
   * straight edge on **both** sides of a node and the junction between a line
   * and a curve has no wedge to cut off.
   */
  it("a pie has one corner, at the centre", () => {
    const nodes = shapeOutlineNodes(g("ellipse", { arc: { start: 0, sweep: 90 } }))[0];
    const corners = nodes.filter(isCorner);
    expect(corners).toHaveLength(1);
    expect(corners[0].p).toEqual([0, 0]);
  });

  it("a donut is two subpaths and a plain ellipse is one", () => {
    expect(shapeOutlineNodes(g("ellipse"))).toHaveLength(1);
    expect(shapeOutlineNodes(g("ellipse", { hole: 0.5 }))).toHaveLength(2);
  });
});

describe("winding", () => {
  /**
   * Clockwise is a contract rather than a coincidence of each kind, because two
   * things rest on it: a hole is the subpath wound the other way, and a
   * per-corner radius is addressed by index, so "the top left corner" is only
   * answerable if every generator starts in the same place and turns the same
   * way.
   */
  it.each([
    ["rectangle", g("rectangle")],
    ["triangle", g("polygon", { count: 3 })],
    ["pentagon", g("polygon", { count: 5 })],
    ["star", g("star")],
    ["ellipse", g("ellipse")],
    ["pie", g("ellipse", { arc: { start: 30, sweep: 200 } })],
  ])("%s is wound clockwise", (_label, geometry) => {
    expect(signedArea(shapeOutlineNodes(geometry)[0])).toBeGreaterThan(0);
  });

  it("a donut's inner ring runs the other way", () => {
    const [outer, inner] = shapeOutlineNodes(g("ellipse", { hole: 0.5 }));
    expect(signedArea(outer)).toBeGreaterThan(0);
    expect(signedArea(inner)).toBeLessThan(0);
  });
});

describe("the star's default waist", () => {
  /**
   * `cos(2π/n) / cos(π/n)` is the ratio at which a star's two edges are
   * collinear across its point. At five it is `1/φ²`, the constant
   * `mask/templates.ts` names, and pinning the identity is what stops the two
   * stars in this codebase drifting apart.
   */
  it("is 1/phi^2 at five points", () => {
    expect(starInnerRatioFor(5)).toBeCloseTo(1 / ((1 + Math.sqrt(5)) / 2) ** 2, 12);
  });

  it("matches the mask's own star, node for node", () => {
    const mine = shapeOutlineNodes(g("star"))[0];
    const theirs = templateNodes("star");
    expect(mine).toHaveLength(theirs.length);
    mine.forEach((node, index) => {
      expect(node.p[0]).toBeCloseTo(theirs[index].p[0], 12);
      expect(node.p[1]).toBeCloseTo(theirs[index].p[1], 12);
    });
  });

  /**
   * Below five there is no `{n/2}` star polygon, so the collinear formula gives
   * zero or a negative and there is no ratio to find. Half is the only sensible
   * answer, and it has to be a positive one or the shape turns inside out.
   */
  it.each([3, 4])("falls back to a half at %i points", (count) => {
    expect(starInnerRatioFor(count)).toBe(0.5);
  });

  it("a star left alone carries no innerRatio key, whatever its count", () => {
    for (let count = MIN_SHAPE_COUNT; count <= MAX_SHAPE_COUNT; count++) {
      expect(g("star", { count }).innerRatio).toBeUndefined();
    }
  });
});

describe("the ellipse is a real ellipse", () => {
  /**
   * Four cubics with kappa handles, not a fifty-sided approximation.
   *
   * The bound is the classic one: the arc-to-cubic error is about 2.7e-4 of the
   * radius. Measured against the legacy fifty-gon in the same sweep, which is
   * out by about forty times as much, so this also shows the measurement can
   * tell the two apart rather than passing on anything round.
   */
  it("is within 3e-4 of a true circle, where a 50-gon is not", () => {
    const segments = segmentsOf(shapeOutlineNodes(g("ellipse"))[0]);
    let worst = 0;
    for (const segment of segments) {
      for (let i = 0; i <= 250; i++) {
        const t = i / 250;
        const x = cubicAt(segment.from.x, segment.c1.x, segment.c2.x, segment.to.x, t);
        const y = cubicAt(segment.from.y, segment.c1.y, segment.c2.y, segment.to.y, t);
        worst = Math.max(worst, Math.abs(Math.hypot(x, y) - 0.5));
      }
    }
    expect(worst).toBeLessThan(3e-4);

    // The legacy flattening, measured the same way: the chord midpoint of a
    // fiftieth of a turn falls this far short of the circle.
    const legacyError = 0.5 * (1 - Math.cos(Math.PI / ELLIPSE_FLATTEN_SEGMENTS));
    expect(legacyError).toBeGreaterThan(worst * 5);
  });
});

describe("flattenOutline, the mirror `shape` holds", () => {
  /**
   * The reason the three legacy kinds could be turned parametric at all: the
   * mirror of each is the very point list `shapePoints` has always produced, so
   * a project written before recipes existed and one written after hold the
   * same numbers for the same shape.
   *
   * Compared as sets for the polygons, because the generators wind clockwise
   * and `shapePoints` does not. That difference is invisible to `fill()`, and
   * the pixel proof is in `renderer/shape.test.ts`.
   */
  it("gives the legacy rectangle's points", () => {
    expect(asSet(flattenOutline(g("rectangle"), BOX))).toEqual(
      asSet(shapePoints("rectangle")),
    );
  });

  it("gives the legacy triangle's points", () => {
    expect(asSet(flattenOutline(g("polygon", { count: 3 }), BOX))).toEqual(
      asSet(shapePoints("triangle")),
    );
  });

  /**
   * The ellipse is exact rather than merely equal as a set, down to the
   * floating-point association: a closed ring has no start, so the flatten runs
   * from 3 o'clock with the legacy loop's own arithmetic. Written any other way
   * the two agree to about 1e-13 and no further, and a circle that gained a
   * recipe would stop being byte-identical to the one in every saved project.
   */
  it("gives the legacy ellipse's points exactly", () => {
    expect(flattenOutline(g("ellipse"), BOX)).toEqual(shapePoints("ellipse"));
  });

  it("leaves the rounding out", () => {
    // The point of leaving it out: dragging the radius slider must not rewrite
    // the point list once a frame, and the overlay marks the corners the shape
    // actually turns at rather than the tangent points of its arcs.
    expect(flattenOutline(g("rectangle", { radius: 30 }), BOX)).toEqual(
      flattenOutline(g("rectangle"), BOX),
    );
  });

  it("leaves the hole out, because it is the outer boundary", () => {
    expect(flattenOutline(g("ellipse", { hole: 0.7 }), BOX)).toEqual(
      flattenOutline(g("ellipse"), BOX),
    );
  });

  it("scales linearly with the box, which is what lets the mirror be authored", () => {
    // The mirror is built against `oWidth`/`oHeight` and then multiplied by
    // `shapeDrawScale` at draw time. That only lands in the right place if the
    // mapping is linear in the box.
    const small = flattenOutline(g("polygon", { count: 5 }), { width: 10, height: 20 });
    const large = flattenOutline(g("polygon", { count: 5 }), { width: 30, height: 60 });
    small.forEach((point, index) => {
      expect(large[index][0]).toBeCloseTo(point[0] * 3, 9);
      expect(large[index][1]).toBeCloseTo(point[1] * 3, 9);
    });
  });

  it("closes a wedge through the centre", () => {
    const points = flattenOutline(g("ellipse", { arc: { start: 0, sweep: 90 } }), BOX);
    expect(points[points.length - 1]).toEqual([50, 50]);
  });
});

describe("resolving a recipe's numbers", () => {
  it("defaults the count per kind", () => {
    expect(countOf(g("polygon"))).toBe(3);
    expect(countOf(g("star"))).toBe(5);
  });

  it("clamps a count that is out of range rather than answering NaN", () => {
    expect(countOf({ kind: "polygon", count: 1 } as ShapeGeometry)).toBe(MIN_SHAPE_COUNT);
    expect(countOf({ kind: "polygon", count: 900 } as ShapeGeometry)).toBe(MAX_SHAPE_COUNT);
    expect(countOf({ kind: "polygon", count: NaN } as ShapeGeometry)).toBe(3);
  });

  it("clamps a waist read from a hand-edited file", () => {
    expect(innerRatioOf({ kind: "star", innerRatio: 5 } as ShapeGeometry)).toBe(1);
    expect(innerRatioOf({ kind: "star", innerRatio: -2 } as ShapeGeometry)).toBe(0);
  });

  /**
   * Only a rectangle tells its four corners apart, because only a rectangle has
   * four to tell apart. Everything else takes the first, so "one radius" and
   * "four radii on a polygon" mean the same thing rather than one of them
   * silently meaning nothing.
   */
  it("addresses a rectangle's corners by index and nothing else's", () => {
    const rect = radiusAtOf(g("rectangle", { radius: [1, 2, 3, 4] }), 4);
    expect([0, 1, 2, 3].map(rect)).toEqual([1, 2, 3, 4]);

    const poly = radiusAtOf(
      { kind: "polygon", radius: [1, 2, 3, 4] } as ShapeGeometry,
      5,
    );
    expect([0, 1, 2, 3, 4].map(poly)).toEqual([1, 1, 1, 1, 1]);
  });
});

describe("nothing produces a NaN", () => {
  /**
   * The whole parameter space, because every one of these numbers can arrive
   * from a hand-edited project as well as from a slider, and one NaN anywhere
   * in a node list puts the entire path off-canvas rather than drawing it
   * slightly wrong.
   */
  it("over every count", () => {
    for (let count = MIN_SHAPE_COUNT; count <= MAX_SHAPE_COUNT; count++) {
      for (const geometry of [g("polygon", { count }), g("star", { count })]) {
        const numbers = shapeOutlineNodes(geometry).flatMap(everyNumber);
        expect(numbers.every(Number.isFinite), `count ${count}`).toBe(true);
      }
    }
  });

  it("over every waist", () => {
    for (let i = 0; i <= 100; i++) {
      const numbers = shapeOutlineNodes(
        g("star", { count: 7, innerRatio: i / 100 }),
      ).flatMap(everyNumber);
      expect(numbers.every(Number.isFinite), `ratio ${i / 100}`).toBe(true);
    }
  });

  it("over every arc and hole", () => {
    for (let sweep = 1; sweep <= 360; sweep += 7) {
      for (const hole of [0, 0.3, 1]) {
        const numbers = shapeOutlineNodes(
          g("ellipse", { arc: { start: 137, sweep }, hole }),
        ).flatMap(everyNumber);
        expect(numbers.every(Number.isFinite), `sweep ${sweep} hole ${hole}`).toBe(true);
      }
    }
  });

  it("draws nothing rather than a sliver for a sweep of zero", () => {
    expect(shapeOutlineNodes(g("ellipse", { arc: { start: 0, sweep: 0 } }))).toEqual([]);
    expect(flattenOutline(g("ellipse", { arc: { start: 0, sweep: 0 } }), BOX)).toEqual([]);
  });
});

describe("outlineInBox", () => {
  it("puts the box's top left at the origin", () => {
    const nodes = outlineInBox(g("rectangle"), BOX)[0];
    expect(nodes.map((n) => n.p)).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
  });

  /**
   * A fresh list every call. The rule `mask/templates.ts#templateNodes` states:
   * a shared node list is one a caller that mutated in place could use to
   * rewrite the shape for every clip in the project.
   */
  it("hands out a fresh list every call", () => {
    const first = outlineInBox(g("star"), BOX);
    const second = outlineInBox(g("star"), BOX);
    expect(first).not.toBe(second);
    expect(first[0][0]).not.toBe(second[0][0]);
    expect(first).toEqual(second);
  });
});
