import { describe, expect, it } from "vitest";

import type { MaskNode } from "../../@types/timeline";
import { applyPoint, multiply, type Mat } from "../timeline/transform";
import {
  boundsOf,
  isCorner,
  isStraight,
  rotateMat,
  scaleMat,
  segmentsOf,
  transformNodes,
  translateMat,
} from "./geometry";
import { maskNodesInElementSpace, maskStaticSample } from "./place";
import { roundCorners } from "./round";
import { templateNodes } from "./templates";
import { defaultMask } from "./maskShape";

const corner = (x: number, y: number): MaskNode => ({ p: [x, y] });

/** A unit square as four corners, clockwise from the top left. */
const SQUARE: MaskNode[] = [
  corner(-0.5, -0.5),
  corner(0.5, -0.5),
  corner(0.5, 0.5),
  corner(-0.5, 0.5),
];

function near(a: number, b: number, tolerance = 1e-9): boolean {
  return Math.abs(a - b) <= tolerance;
}

describe("segmentsOf", () => {
  it("closes the path: one segment per node, the last wrapping to the first", () => {
    const segments = segmentsOf(SQUARE);
    expect(segments).toHaveLength(4);
    expect(segments[3].to).toEqual({ x: -0.5, y: -0.5 });
  });

  // A straight edge is the cubic whose control points sit on its endpoints.
  // Everything downstream leans on that: it is why an affine matrix maps the
  // whole path without a case analysis.
  it("gives a handle-less edge control points on its endpoints", () => {
    const [first] = segmentsOf(SQUARE);
    expect(first.c1).toEqual(first.from);
    expect(first.c2).toEqual(first.to);
  });

  it("reads handles as offsets from their anchor, not as absolute points", () => {
    const nodes: MaskNode[] = [
      { p: [0, 0], ce: [1, 0] },
      { p: [10, 0], cs: [-2, 0] },
    ];
    const [first] = segmentsOf(nodes);
    expect(first.c1).toEqual({ x: 1, y: 0 });
    expect(first.c2).toEqual({ x: 8, y: 0 });
  });

  // A lone node has no edge. Emitting a self-segment would put a stray
  // `bezierCurveTo` in front of `closePath` and paint a dot on the frame.
  it("yields nothing for fewer than two nodes", () => {
    expect(segmentsOf([])).toEqual([]);
    expect(segmentsOf([corner(0, 0)])).toEqual([]);
  });
});

describe("isCorner / isStraight", () => {
  it("calls a node with neither handle a corner", () => {
    expect(isCorner(corner(0, 0))).toBe(true);
    expect(isCorner({ p: [0, 0], cs: [1, 0] })).toBe(false);
    expect(isCorner({ p: [0, 0], ce: [1, 0] })).toBe(false);
    // A zero-length handle is still a handle: it is what makes the heart's tip
    // a cusp rather than something round-corners may touch.
    expect(isCorner({ p: [0, 0], ce: [0, 0] })).toBe(false);
  });

  // A node can be a cusp — curved on one side, straight on the other — so the
  // question has to be asked per edge, not per node.
  it("asks about the two handles that face along the edge, and no others", () => {
    const a: MaskNode = { p: [0, 0], cs: [-1, 0] };
    const b: MaskNode = { p: [1, 0], ce: [1, 0] };
    expect(isStraight(a, b)).toBe(true);
    expect(isStraight({ ...a, ce: [1, 0] }, b)).toBe(false);
    expect(isStraight(a, { ...b, cs: [-1, 0] })).toBe(false);
  });
});

describe("boundsOf", () => {
  it("measures a straight-edged path exactly", () => {
    expect(boundsOf(SQUARE)).toEqual({ minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 });
  });

  // The control hull is a bound but a loose one. Normalising a template against
  // the hull would leave the real curve overflowing the box it claims to fill.
  it("follows the curve past its control points, not the hull", () => {
    // A single cubic bulging out to the right, with both control points at 1.
    const nodes: MaskNode[] = [
      { p: [0, 0], ce: [1, 0] },
      { p: [0, 1], cs: [1, 0] },
    ];
    const bounds = boundsOf(nodes)!;
    expect(bounds.maxX).toBeLessThan(1);
    expect(bounds.maxX).toBeGreaterThan(0.7);
  });

  it("answers null for nothing and a point for one node", () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([corner(3, 4)])).toEqual({ minX: 3, minY: 4, maxX: 3, maxY: 4 });
  });
});

describe("transformNodes", () => {
  // The whole reason the path is cubic all the way down: an affine matrix maps
  // a cubic's four control points to the transformed cubic's four control
  // points, exactly. If this drifted, a rotated mask would be an approximation.
  it("maps every control point exactly, for any affine matrix", () => {
    const m: Mat = multiply(
      multiply(translateMat(17, -4), rotateMat(37)),
      scaleMat(2.5, 0.4),
    );
    const nodes: MaskNode[] = [
      { p: [1, 2], cs: [-0.5, 0.25], ce: [0.5, -0.25] },
      { p: [4, 6], cs: [0.1, 0.2], ce: [0.3, 0.4] },
    ];

    const moved = transformNodes(nodes, m);
    const expectedSegments = segmentsOf(nodes).map((s) => ({
      from: applyPoint(m, s.from),
      c1: applyPoint(m, s.c1),
      c2: applyPoint(m, s.c2),
      to: applyPoint(m, s.to),
    }));

    segmentsOf(moved).forEach((segment, index) => {
      const expected = expectedSegments[index];
      for (const key of ["from", "c1", "c2", "to"] as const) {
        expect(near(segment[key].x, expected[key].x)).toBe(true);
        expect(near(segment[key].y, expected[key].y)).toBe(true);
      }
    });
  });

  // A handle is an offset. Sending it through `applyPoint` would add the
  // translation twice and bow every curve toward the mask's own position — the
  // classic way a parented drag runs away from the mouse, in path form.
  it("sends handles through the linear part only, never the translation", () => {
    const nodes: MaskNode[] = [{ p: [0, 0], ce: [1, 0] }, { p: [5, 0] }];
    const moved = transformNodes(nodes, translateMat(100, 100));
    expect(moved[0].p).toEqual([100, 100]);
    expect(moved[0].ce).toEqual([1, 0]);
  });

  it("leaves an absent handle absent, so a corner survives any transform", () => {
    const moved = transformNodes(SQUARE, multiply(rotateMat(30), scaleMat(3, 7)));
    expect(moved.every(isCorner)).toBe(true);
  });
});

describe("templateNodes", () => {
  it.each(["rectangle", "star", "heart"] as const)(
    "normalises %s onto the unit square",
    (shape) => {
      const bounds = boundsOf(templateNodes(shape))!;
      expect(near(bounds.minX, -0.5, 1e-9)).toBe(true);
      expect(near(bounds.maxX, 0.5, 1e-9)).toBe(true);
      expect(near(bounds.minY, -0.5, 1e-9)).toBe(true);
      expect(near(bounds.maxY, 0.5, 1e-9)).toBe(true);
    },
  );

  it("gives the star ten alternating vertices, all of them corners", () => {
    const star = templateNodes("star");
    expect(star).toHaveLength(10);
    expect(star.every(isCorner)).toBe(true);
  });

  // This is what makes "a heart never rounds" a consequence of one rule rather
  // than a special case named after the shape.
  it("gives every heart node a handle, so none of them is a corner", () => {
    const heart = templateNodes("heart");
    expect(heart.length).toBeGreaterThan(0);
    expect(heart.some(isCorner)).toBe(false);
  });

  it("returns a fresh copy, so a caller cannot rewrite the shape for everyone", () => {
    const a = templateNodes("rectangle");
    a[0].p[0] = 99;
    expect(templateNodes("rectangle")[0].p[0]).toBe(-0.5);
  });

  // Substituting a rectangle would put a shape on screen the user never drew
  // and could not see the source of. `isMaskActive` has already made this a
  // pass-through; this is the second line of the same contract.
  it("gives a pen shape its own path, and nothing at all without one", () => {
    expect(templateNodes("pen")).toEqual([]);
    expect(templateNodes("pen", SQUARE)).toEqual(SQUARE);
  });
});

describe("roundCorners", () => {
  it("declines by identity when there is nothing to do", () => {
    expect(roundCorners(SQUARE, 0)).toBe(SQUARE);
    expect(roundCorners(SQUARE, -1)).toBe(SQUARE);
    expect(roundCorners(SQUARE, NaN)).toBe(SQUARE);
    expect(roundCorners(SQUARE.slice(0, 2), 0.1)).toHaveLength(2);
  });

  it("replaces each corner with two tangent nodes carrying one handle each", () => {
    const rounded = roundCorners(SQUARE, 0.1);
    expect(rounded).toHaveLength(8);
    // Traversal order is previous -> corner -> next, so the node on the
    // incoming edge carries the outgoing handle and vice versa.
    expect(rounded[0].ce).toBeDefined();
    expect(rounded[0].cs).toBeUndefined();
    expect(rounded[1].cs).toBeDefined();
    expect(rounded[1].ce).toBeUndefined();
  });

  it("leaves a heart untouched, because it has no corners", () => {
    const heart = templateNodes("heart");
    expect(roundCorners(heart, 0.25)).toBe(heart);
  });

  it("is idempotent: a rounded corner is no longer a corner", () => {
    const once = roundCorners(SQUARE, 0.1);
    expect(roundCorners(once, 0.1)).toBe(once);
  });

  // Two corners sharing a short edge must not each eat past its middle, or the
  // path crosses itself and fills as a bow tie.
  it("caps the trim at half of each adjacent edge", () => {
    const rounded = roundCorners(SQUARE, 10_000);
    const bounds = boundsOf(rounded)!;
    expect(near(bounds.minX, -0.5, 1e-9)).toBe(true);
    expect(near(bounds.maxX, 0.5, 1e-9)).toBe(true);
    // Every tangent point lands exactly at an edge midpoint, never beyond it.
    for (const node of rounded) {
      expect(Math.abs(node.p[0])).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(Math.abs(node.p[1])).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it("rounds the star's sharp points less than its wide notches", () => {
    const star = templateNodes("star");
    const rounded = roundCorners(star, 10_000);
    expect(rounded).toHaveLength(20);
    // The trim is capped by the shorter adjacent edge, which is the same for
    // both, so what differs is the handle length — an acute point keeps a
    // tighter arc than an obtuse notch.
    const handleAt = (index: number) => Math.hypot(...(rounded[index].ce ?? [0, 0]));
    expect(handleAt(0)).toBeLessThan(handleAt(2));
  });

  // The user was making this distinction with the mouse at the time: a click is
  // a corner, a drag is a curve.
  it("rounds only the clicked vertices of a mixed path", () => {
    const mixed: MaskNode[] = [
      corner(0, 0),
      { p: [10, 0], cs: [-2, 0], ce: [2, 0] },
      corner(10, 10),
      corner(0, 10),
    ];
    const rounded = roundCorners(mixed, 1);
    // The smooth node survives untouched; its two straight-edged neighbours
    // are not eligible either, because the edges beside it are curved.
    expect(rounded.filter((n) => n.p[0] === 10 && n.p[1] === 0)).toHaveLength(1);
    expect(rounded.length).toBeGreaterThan(mixed.length);
  });

  it("leaves a collinear vertex alone — there is no corner there to round", () => {
    const collinear: MaskNode[] = [corner(0, 0), corner(5, 0), corner(10, 0), corner(5, 8)];
    const rounded = roundCorners(collinear, 1);
    expect(rounded.some((n) => n.p[0] === 5 && n.p[1] === 0)).toBe(true);
  });

  it("produces no NaN for any corner angle", () => {
    for (let degrees = 1; degrees < 360; degrees += 7) {
      const theta = (degrees * Math.PI) / 180;
      const wedge: MaskNode[] = [
        corner(0, 0),
        corner(10, 0),
        corner(10 * Math.cos(theta), 10 * Math.sin(theta)),
      ];
      for (const node of roundCorners(wedge, 2)) {
        expect(Number.isFinite(node.p[0])).toBe(true);
        expect(Number.isFinite(node.p[1])).toBe(true);
        expect(Number.isFinite(node.cs?.[0] ?? 0)).toBe(true);
        expect(Number.isFinite(node.ce?.[0] ?? 0)).toBe(true);
      }
    }
  });
});

describe("maskNodesInElementSpace", () => {
  const box = { width: 400, height: 200 };

  it("puts a full-size centred rectangle exactly on the element box", () => {
    const mask = { ...defaultMask("rectangle"), size: { width: 100, height: 100 } };
    const bounds = boundsOf(
      maskNodesInElementSpace(mask, maskStaticSample(mask), box),
    )!;
    expect(near(bounds.minX, 0, 1e-9)).toBe(true);
    expect(near(bounds.minY, 0, 1e-9)).toBe(true);
    expect(near(bounds.maxX, 400, 1e-9)).toBe(true);
    expect(near(bounds.maxY, 200, 1e-9)).toBe(true);
  });

  it("reads location and size as percentages of the element box", () => {
    const mask = {
      ...defaultMask("rectangle"),
      location: { x: 25, y: 50 },
      size: { width: 50, height: 100 },
    };
    const bounds = boundsOf(
      maskNodesInElementSpace(mask, maskStaticSample(mask), box),
    )!;
    expect(near(bounds.minX, 0, 1e-9)).toBe(true);
    expect(near(bounds.maxX, 200, 1e-9)).toBe(true);
    expect(near(bounds.minY, 0, 1e-9)).toBe(true);
    expect(near(bounds.maxY, 200, 1e-9)).toBe(true);
  });

  // A location outside the box is a wipe, and animating one off the edge is how
  // a reveal is built — so it must place, not clamp.
  it("places a mask past the edge of the element", () => {
    const mask = { ...defaultMask("rectangle"), location: { x: -50, y: 50 } };
    const bounds = boundsOf(
      maskNodesInElementSpace(mask, maskStaticSample(mask), box),
    )!;
    expect(bounds.maxX).toBeLessThan(0);
  });

  // Rotating in the unit square first would shear a non-square mask. Scaling
  // to pixels first and rotating after keeps it a rectangle.
  it("rotates a non-square mask without shearing it", () => {
    const mask = {
      ...defaultMask("rectangle"),
      size: { width: 100, height: 20 },
      rotation: 30,
    };
    const nodes = maskNodesInElementSpace(mask, maskStaticSample(mask), box);
    const [a, b, c] = nodes.map((n) => n.p);
    const ab = { x: b[0] - a[0], y: b[1] - a[1] };
    const bc = { x: c[0] - b[0], y: c[1] - b[1] };
    // Adjacent edges of a rectangle stay perpendicular through a rotation.
    expect(near(ab.x * bc.x + ab.y * bc.y, 0, 1e-9)).toBe(true);
  });

  // Rounding in pixels rather than in the unit square is what makes a corner
  // circular on screen whatever the mask's aspect.
  it("gives a wide, short mask corners as tall as they are wide", () => {
    const mask = {
      ...defaultMask("rectangle"),
      size: { width: 100, height: 25 },
      roundness: 100,
    };
    const nodes = maskNodesInElementSpace(mask, maskStaticSample(mask), box);
    const bounds = boundsOf(nodes)!;
    // The mask box is 400 x 50 — eight to one. Under unit-square rounding the
    // corner would come out eight times wider than it is tall; here the two
    // tangent points sit the same distance from the corner along their own
    // edges, which is a circular arc.
    const first = nodes[0]; // on the left edge, below the top-left corner
    const second = nodes[1]; // on the top edge, right of it
    const down = Math.abs(first.p[1] - bounds.minY);
    const across = Math.abs(second.p[0] - bounds.minX);
    expect(down).toBeGreaterThan(0);
    expect(near(down, across, 1e-6)).toBe(true);
  });

  it("has nothing to place for a pen mask with no path", () => {
    const mask = { ...defaultMask("pen") };
    expect(maskNodesInElementSpace(mask, maskStaticSample(mask), box)).toEqual([]);
  });

  it("scales a drawn pen path by the element box like any other shape", () => {
    const mask = {
      ...defaultMask("pen"),
      size: { width: 100, height: 100 },
      path: SQUARE,
    };
    const bounds = boundsOf(
      maskNodesInElementSpace(mask, maskStaticSample(mask), box),
    )!;
    expect(near(bounds.maxX - bounds.minX, 400, 1e-9)).toBe(true);
    expect(near(bounds.maxY - bounds.minY, 200, 1e-9)).toBe(true);
  });

  it("survives an element box of zero without producing NaN", () => {
    const mask = defaultMask("rectangle");
    const nodes = maskNodesInElementSpace(mask, maskStaticSample(mask), {
      width: 0,
      height: 0,
    });
    for (const node of nodes) {
      expect(Number.isFinite(node.p[0])).toBe(true);
      expect(Number.isFinite(node.p[1])).toBe(true);
    }
  });
});
