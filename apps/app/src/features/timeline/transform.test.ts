import { describe, it, expect } from "vitest";
import {
  IDENTITY,
  applyPoint,
  applyVector,
  createMemo,
  inheritedOpacityOf,
  invert,
  localMatrixOf,
  localSampleAt,
  multiply,
  parentLocalToWorld,
  parentMatrixOf,
  rotationOf,
  scaleOf,
  worldBoundsOf,
  worldCornersOf,
  worldMatrixOf,
  worldToParentLocal,
  worldVectorToParentLocal,
  type Mat,
} from "./transform";
import { bakeTrack } from "../animation/keyframes";
import { groupElement, imageElement, keys } from "../renderer/testing";
import type { Timeline } from "../../@types/timeline";

function close(actual: number, expected: number, epsilon = 1e-9) {
  expect(Math.abs(actual - expected)).toBeLessThan(epsilon);
}

function matClose(actual: Mat, expected: Mat, epsilon = 1e-9) {
  for (const key of ["a", "b", "c", "d", "e", "f"] as const) {
    close(actual[key], expected[key], epsilon);
  }
}

/**
 * A canvas context that records nothing but its transform.
 *
 * This is the whole point of the suite: `applyElementTransform` used to *be* the
 * definition of an element's placement, as a sequence of translate/rotate/scale
 * calls. `localMatrixOf` now is. If the two ever disagree, drawing and
 * hit-testing disagree, and elements jump under the pointer — so the equality is
 * pinned here against a real replay of the old sequence rather than against a
 * hand-computed matrix that could be wrong in the same way twice.
 */
function recordingCtx() {
  let m: Mat = IDENTITY;
  return {
    get matrix() {
      return m;
    },
    translate(x: number, y: number) {
      m = multiply(m, { a: 1, b: 0, c: 0, d: 1, e: x, f: y });
    },
    rotate(radians: number) {
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      m = multiply(m, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
    },
    scale(sx: number, sy: number) {
      m = multiply(m, { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
    },
  };
}

/** The exact sequence `applyElementTransform` ran before this module existed. */
function legacyTransform(
  ctx: ReturnType<typeof recordingCtx>,
  opts: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotationDeg: number;
    scale: number;
  },
) {
  const cx = opts.width / 2;
  const cy = opts.height / 2;

  ctx.translate(opts.x, opts.y);

  ctx.translate(cx, cy);
  ctx.rotate((opts.rotationDeg * Math.PI) / 180);
  ctx.translate(-cx, -cy);

  ctx.translate(cx, cy);
  ctx.scale(opts.scale, opts.scale);
  ctx.translate(-cx, -cy);
}

describe("matrix algebra", () => {
  it("multiplies in apply-n-first order", () => {
    // Translate by (10, 0) then scale by 2 must land a point at 2*(p + 10),
    // not 2*p + 10. Getting this backwards is the classic silent transform bug.
    const t = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 0 };
    const s = { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 };
    expect(applyPoint(multiply(s, t), { x: 1, y: 0 })).toEqual({ x: 22, y: 0 });
  });

  it("is identity on both sides", () => {
    const m = { a: 2, b: 3, c: 4, d: 5, e: 6, f: 7 };
    expect(multiply(m, IDENTITY)).toEqual(m);
    expect(multiply(IDENTITY, m)).toEqual(m);
  });

  it("inverts back to identity", () => {
    const m = { a: 0.5, b: 1.2, c: -0.9, d: 2.1, e: 30, f: -12 };
    matClose(multiply(m, invert(m)), IDENTITY);
    matClose(multiply(invert(m), m), IDENTITY);
  });

  it("returns identity rather than throwing on a singular matrix", () => {
    // A scale track can reach 0. Hit-testing must stay total there.
    expect(invert({ a: 0, b: 0, c: 0, d: 0, e: 5, f: 5 })).toEqual(IDENTITY);
  });

  it("excludes translation from applyVector", () => {
    // A drag delta through `applyPoint` would pick up the translation and move
    // the element roughly twice as far as the pointer.
    const m = { a: 2, b: 0, c: 0, d: 2, e: 100, f: 100 };
    expect(applyVector(m, { x: 3, y: 4 })).toEqual({ x: 6, y: 8 });
    expect(applyPoint(m, { x: 3, y: 4 })).toEqual({ x: 106, y: 108 });
  });

  it("reports a positive scale even when mirrored", () => {
    close(scaleOf({ a: -3, b: 0, c: 0, d: 3, e: 0, f: 0 }), 3);
  });

  it("recovers the rotation angle", () => {
    const m = localMatrixOf(
      imageElement({ rotation: 30, width: 0, height: 0 }),
      0,
    );
    close(rotationOf(m), 30, 1e-9);
  });
});

describe("localMatrixOf equals the renderer's canvas call sequence", () => {
  const cases = [
    { name: "identity", rotationDeg: 0, scale: 1, x: 0, y: 0 },
    { name: "translation only", rotationDeg: 0, scale: 1, x: 37, y: -11 },
    { name: "rotation only", rotationDeg: 42, scale: 1, x: 0, y: 0 },
    { name: "scale only", rotationDeg: 0, scale: 2.5, x: 0, y: 0 },
    { name: "all three", rotationDeg: -73.5, scale: 0.4, x: 120, y: 45 },
    { name: "negative rotation past a turn", rotationDeg: -400, scale: 1.1, x: 5, y: 5 },
  ];

  for (const c of cases) {
    it(`matches for ${c.name}`, () => {
      const width = 160;
      const height = 90;
      const element = imageElement({
        width,
        height,
        location: { x: c.x, y: c.y },
        rotation: c.rotationDeg,
        animation: {
          ...imageElement().animation,
          scale: {
            isActivate: true,
            x: keys([0, c.scale * 10]),
            ax: bakeTrack(keys([0, c.scale * 10])),
          },
        },
      });

      const ctx = recordingCtx();
      legacyTransform(ctx, { ...c, width, height });

      matClose(localMatrixOf(element, 0), ctx.matrix, 1e-9);
    });
  }

  it("puts the element's top-left at its location when unrotated", () => {
    const element = imageElement({
      width: 40,
      height: 20,
      location: { x: 300, y: 200 },
    });
    const m = localMatrixOf(element, 0);
    expect(applyPoint(m, { x: 0, y: 0 })).toEqual({ x: 300, y: 200 });
    expect(applyPoint(m, { x: 40, y: 20 })).toEqual({ x: 340, y: 220 });
  });

  it("rotates about the element's own centre", () => {
    // 180° about the centre maps the top-left corner onto the bottom-right.
    const element = imageElement({
      width: 100,
      height: 60,
      location: { x: 0, y: 0 },
      rotation: 180,
    });
    const corner = applyPoint(localMatrixOf(element, 0), { x: 0, y: 0 });
    close(corner.x, 100, 1e-9);
    close(corner.y, 60, 1e-9);
  });

  it("scales about the element's own centre", () => {
    const scaled = keys([0, 20]); // 2x, since the track stores tenths
    const element = imageElement({
      width: 100,
      height: 100,
      location: { x: 0, y: 0 },
      animation: {
        ...imageElement().animation,
        scale: { isActivate: true, x: scaled, ax: bakeTrack(scaled) },
      },
    });
    // The centre is a fixed point of a centre-anchored scale.
    const centre = applyPoint(localMatrixOf(element, 0), { x: 50, y: 50 });
    close(centre.x, 50, 1e-9);
    close(centre.y, 50, 1e-9);
    // …and the box has doubled around it.
    const tl = applyPoint(localMatrixOf(element, 0), { x: 0, y: 0 });
    close(tl.x, -50, 1e-9);
  });
});

describe("localSampleAt", () => {
  it("uses static values when the track is off", () => {
    const element = imageElement({
      location: { x: 11, y: 22 },
      rotation: 33,
      opacity: 44,
    });
    expect(localSampleAt(element, 5000)).toEqual({
      x: 11,
      y: 22,
      rotationDeg: 33,
      scale: 1,
      opacity: 44,
    });
  });

  it("ignores a track whose isActivate is false even when it has keyframes", () => {
    // Turning animation off must actually stop the animation. This gate is the
    // one `applyElementTransform` had to grow after position animated whenever
    // a track merely existed.
    const list = keys([0, 500]);
    const element = imageElement({
      location: { x: 10, y: 0 },
      animation: {
        ...imageElement().animation,
        position: { isActivate: false, x: list, y: list, ax: bakeTrack(list), ay: bakeTrack(list) },
      },
    });
    expect(localSampleAt(element, 0).x).toBe(10);
  });

  it("holds the static value before the element starts", () => {
    const list = keys([0, 500]);
    const element = imageElement({
      startTime: 2000,
      location: { x: 10, y: 0 },
      animation: {
        ...imageElement().animation,
        position: { isActivate: true, x: list, y: list, ax: bakeTrack(list), ay: bakeTrack(list) },
      },
    });
    expect(localSampleAt(element, 1999).x).toBe(10);
    expect(localSampleAt(element, 2000).x).toBe(500);
  });

  it("holds the last baked sample after the track ends", () => {
    // The asymmetry with the pre-start case is pre-existing `sampleTrack`
    // behaviour, pinned here because a group's transform is now sampled well
    // outside its own span.
    const list = keys([0, 0], [1000, 900]);
    const element = imageElement({
      animation: {
        ...imageElement().animation,
        position: { isActivate: true, x: list, y: list, ax: bakeTrack(list), ay: bakeTrack(list) },
      },
    });
    expect(localSampleAt(element, 99999).x).toBe(900);
  });

  it("reads scale as tenths", () => {
    const list = keys([0, 25]);
    const element = imageElement({
      animation: {
        ...imageElement().animation,
        scale: { isActivate: true, x: list, ax: bakeTrack(list) },
      },
    });
    expect(localSampleAt(element, 0).scale).toBe(2.5);
  });

  it("treats a missing element as neutral", () => {
    expect(localSampleAt(undefined, 0)).toEqual({
      x: 0,
      y: 0,
      rotationDeg: 0,
      scale: 1,
      opacity: 100,
    });
  });
});

// --------------------------------------------------------------- the chain

/** A group at `(gx, gy)` holding one child at `(cx, cy)` in group space. */
function nested(over: {
  group?: Record<string, any>;
  child?: Record<string, any>;
} = {}): Timeline {
  return {
    g: groupElement({ location: { x: 0, y: 0 }, ...over.group }) as any,
    c: imageElement({
      parentId: "g",
      location: { x: 0, y: 0 },
      ...over.child,
    }) as any,
  };
}

describe("worldMatrixOf", () => {
  it("is the local matrix for a root element", () => {
    const elements = { c: imageElement({ location: { x: 5, y: 7 } }) };
    matClose(worldMatrixOf(elements as any, "c", 0), localMatrixOf(elements.c, 0));
  });

  it("is identity for an element that is not there", () => {
    expect(worldMatrixOf({} as any, "missing", 0)).toEqual(IDENTITY);
  });

  it("places a child in its parent's coordinate space", () => {
    const elements = nested({
      group: { location: { x: 100, y: 50 } },
      child: { location: { x: 10, y: 20 } },
    });
    const p = applyPoint(worldMatrixOf(elements, "c", 0), { x: 0, y: 0 });
    expect(p).toEqual({ x: 110, y: 70 });
  });

  it("rotates the child about the group's pivot, not the child's", () => {
    // Group is 200x200 so its pivot is (100, 100). A child whose top-left sits
    // at (100, 0) in group space is directly above the pivot; a quarter turn
    // must swing it to the pivot's left.
    const elements = nested({
      group: { location: { x: 0, y: 0 }, width: 200, height: 200, rotation: 90 },
      child: { location: { x: 100, y: 0 }, width: 0, height: 0 },
    });
    const p = applyPoint(worldMatrixOf(elements, "c", 0), { x: 0, y: 0 });
    close(p.x, 200, 1e-9);
    close(p.y, 100, 1e-9);
  });

  it("compounds scale down the chain", () => {
    const half = keys([0, 5]); // 0.5x
    const elements = nested({
      group: {
        location: { x: 0, y: 0 },
        width: 0,
        height: 0,
        animation: {
          ...groupElement().animation,
          scale: { isActivate: true, x: half, ax: bakeTrack(half) },
        },
      },
      child: { location: { x: 100, y: 100 }, width: 0, height: 0 },
    });
    const p = applyPoint(worldMatrixOf(elements, "c", 0), { x: 0, y: 0 });
    close(p.x, 50, 1e-9);
    close(p.y, 50, 1e-9);
  });

  it("follows three levels", () => {
    const elements: Timeline = {
      a: groupElement({ location: { x: 100, y: 0 }, width: 0, height: 0 }) as any,
      b: groupElement({
        parentId: "a",
        location: { x: 10, y: 0 },
        width: 0,
        height: 0,
      }) as any,
      c: imageElement({ parentId: "b", location: { x: 1, y: 0 } }) as any,
    };
    expect(applyPoint(worldMatrixOf(elements, "c", 0), { x: 0, y: 0 })).toEqual({
      x: 111,
      y: 0,
    });
  });

  it("moves the child when the parent's position track moves", () => {
    // The headline property: the child's own keyframes are untouched, yet it
    // travels with the group.
    const list = keys([0, 0], [1000, 400]);
    const elements = nested({
      group: {
        location: { x: 0, y: 0 },
        width: 0,
        height: 0,
        animation: {
          ...groupElement().animation,
          position: {
            isActivate: true,
            x: list,
            y: keys([0, 0], [1000, 0]),
            ax: bakeTrack(list),
            ay: bakeTrack(keys([0, 0], [1000, 0])),
          },
        },
      },
      child: { location: { x: 25, y: 25 } },
    });

    expect(applyPoint(worldMatrixOf(elements, "c", 0), { x: 0, y: 0 })).toEqual({
      x: 25,
      y: 25,
    });
    const late = applyPoint(worldMatrixOf(elements, "c", 1000), { x: 0, y: 0 });
    close(late.x, 425, 1e-6);
    close(late.y, 25, 1e-6);
  });

  it("ignores a parent that is not a group", () => {
    // Only groups may parent. A link to an ordinary clip is not a link.
    const elements: Timeline = {
      p: imageElement({ location: { x: 500, y: 500 } }) as any,
      c: imageElement({ parentId: "p", location: { x: 1, y: 2 } }) as any,
    };
    expect(applyPoint(worldMatrixOf(elements, "c", 0), { x: 0, y: 0 })).toEqual({
      x: 1,
      y: 2,
    });
  });

  it("ignores a parent that no longer exists", () => {
    const elements: Timeline = {
      c: imageElement({ parentId: "gone", location: { x: 3, y: 4 } }) as any,
    };
    expect(applyPoint(worldMatrixOf(elements, "c", 0), { x: 0, y: 0 })).toEqual({
      x: 3,
      y: 4,
    });
  });

  it("terminates on a cycle rather than hanging", () => {
    // An unrepaired document must not be able to lock the render loop.
    const elements: Timeline = {
      a: groupElement({ parentId: "b", location: { x: 1, y: 0 } }) as any,
      b: groupElement({ parentId: "a", location: { x: 2, y: 0 } }) as any,
    };
    expect(() => worldMatrixOf(elements, "a", 0)).not.toThrow();
  });
});

describe("the memo", () => {
  it("gives the same answer as an uncached resolve", () => {
    const elements: Timeline = {
      g: groupElement({ location: { x: 10, y: 20 }, rotation: 15 }) as any,
      a: imageElement({ parentId: "g", location: { x: 1, y: 2 } }) as any,
      b: imageElement({ parentId: "g", location: { x: 3, y: 4 } }) as any,
    };

    const memo = createMemo();
    // Resolve the group first so the siblings hit a warm cache.
    worldMatrixOf(elements, "g", 0, memo);
    matClose(
      worldMatrixOf(elements, "a", 0, memo),
      worldMatrixOf(elements, "a", 0),
    );
    matClose(
      worldMatrixOf(elements, "b", 0, memo),
      worldMatrixOf(elements, "b", 0),
    );
  });

  it("is still correct when a child is resolved before its parent", () => {
    const elements: Timeline = {
      g: groupElement({ location: { x: 100, y: 0 }, width: 0, height: 0 }) as any,
      a: imageElement({ parentId: "g", location: { x: 5, y: 0 } }) as any,
      b: imageElement({ parentId: "g", location: { x: 6, y: 0 } }) as any,
    };
    const memo = createMemo();
    expect(applyPoint(worldMatrixOf(elements, "a", 0, memo), { x: 0, y: 0 }).x).toBe(105);
    expect(applyPoint(worldMatrixOf(elements, "b", 0, memo), { x: 0, y: 0 }).x).toBe(106);
    expect(applyPoint(worldMatrixOf(elements, "g", 0, memo), { x: 0, y: 0 }).x).toBe(100);
  });
});

describe("parentMatrixOf", () => {
  it("is identity for a root element", () => {
    const elements = { c: imageElement({ location: { x: 9, y: 9 } }) };
    expect(parentMatrixOf(elements as any, "c", 0)).toEqual(IDENTITY);
  });

  it("excludes the element's own transform", () => {
    const elements = nested({
      group: { location: { x: 100, y: 50 } },
      child: { location: { x: 10, y: 20 } },
    });
    matClose(
      parentMatrixOf(elements, "c", 0),
      worldMatrixOf(elements, "g", 0),
    );
  });
});

describe("space conversions", () => {
  it("round-trips a point through the parent space", () => {
    const elements = nested({
      group: { location: { x: 31, y: -7 }, width: 80, height: 40, rotation: 27 },
      child: { location: { x: 3, y: 4 } },
    });
    const p = { x: 123.5, y: -44.25 };
    const back = parentLocalToWorld(
      elements,
      "c",
      0,
      worldToParentLocal(elements, "c", 0, p),
    );
    close(back.x, p.x, 1e-9);
    close(back.y, p.y, 1e-9);
  });

  it("round-trips a vector without picking up the translation", () => {
    const elements = nested({
      group: { location: { x: 500, y: 500 }, width: 80, height: 40, rotation: 33 },
    });
    const d = { x: 12, y: -5 };
    const local = worldVectorToParentLocal(elements, "c", 0, d);
    const back = applyVector(parentMatrixOf(elements, "c", 0), local);
    close(back.x, d.x, 1e-9);
    close(back.y, d.y, 1e-9);
  });

  it("halves a drag delta inside a group scaled to 2x", () => {
    // Dragging a child 100px on screen must write 50 into its local position,
    // or the element runs away from the pointer at twice the speed.
    const twice = keys([0, 20]);
    const elements = nested({
      group: {
        location: { x: 0, y: 0 },
        width: 0,
        height: 0,
        animation: {
          ...groupElement().animation,
          scale: { isActivate: true, x: twice, ax: bakeTrack(twice) },
        },
      },
    });
    const local = worldVectorToParentLocal(elements, "c", 0, { x: 100, y: 0 });
    close(local.x, 50, 1e-9);
    close(local.y, 0, 1e-9);
  });
});

describe("inheritedOpacityOf", () => {
  it("is 1 for a root element", () => {
    const elements = { c: imageElement({ opacity: 40 }) };
    expect(inheritedOpacityOf(elements as any, "c", 0)).toBe(1);
  });

  it("excludes the element's own opacity", () => {
    const elements = nested({ group: { opacity: 50 }, child: { opacity: 20 } });
    close(inheritedOpacityOf(elements, "c", 0), 0.5);
  });

  it("multiplies down a chain of groups", () => {
    const elements: Timeline = {
      a: groupElement({ opacity: 50 }) as any,
      b: groupElement({ parentId: "a", opacity: 50 }) as any,
      c: imageElement({ parentId: "b", opacity: 100 }) as any,
    };
    close(inheritedOpacityOf(elements, "c", 0), 0.25);
  });

  it("follows the group's animated opacity", () => {
    const list = keys([0, 100], [1000, 0]);
    const elements = nested({
      group: {
        animation: {
          ...groupElement().animation,
          opacity: { isActivate: true, x: list, ax: bakeTrack(list) },
        },
      },
    });
    close(inheritedOpacityOf(elements, "c", 0), 1, 1e-6);
    close(inheritedOpacityOf(elements, "c", 1000), 0, 1e-6);
  });

  it("clamps an out-of-range opacity into 0..1", () => {
    const elements = nested({ group: { opacity: 400 } });
    expect(inheritedOpacityOf(elements, "c", 0)).toBe(1);
  });
});

describe("world bounds", () => {
  it("gives the four corners in TL, TR, BR, BL order", () => {
    const elements = {
      c: imageElement({ width: 20, height: 10, location: { x: 5, y: 5 } }),
    };
    expect(worldCornersOf(elements as any, "c", 0)).toEqual([
      { x: 5, y: 5 },
      { x: 25, y: 5 },
      { x: 25, y: 15 },
      { x: 5, y: 15 },
    ]);
  });

  it("expands the axis-aligned box for a rotated element", () => {
    const elements = {
      c: imageElement({
        width: 100,
        height: 0,
        location: { x: 0, y: 0 },
        rotation: 90,
      }),
    };
    const b = worldBoundsOf(elements as any, "c", 0);
    close(b.w, 0, 1e-9);
    close(b.h, 100, 1e-9);
  });

  it("accounts for the parent chain", () => {
    const elements = nested({
      group: { location: { x: 1000, y: 0 }, width: 0, height: 0 },
      child: { location: { x: 0, y: 0 }, width: 10, height: 10 },
    });
    expect(worldBoundsOf(elements, "c", 0)).toEqual({
      x: 1000,
      y: 0,
      w: 10,
      h: 10,
    });
  });
});

describe("a group's width and height are its pivot", () => {
  /** The child's top-left on the canvas, for a group box of `w` x `h`. */
  function childAt(w: number, h: number, groupOver: Record<string, any> = {}) {
    const elements: Timeline = {
      g: groupElement({
        location: { x: 100, y: 100 },
        width: w,
        height: h,
        ...groupOver,
      }) as any,
      c: imageElement({
        parentId: "g",
        location: { x: 10, y: 20 },
        width: 30,
        height: 30,
      }) as any,
    };
    return applyPoint(worldMatrixOf(elements, "c", 0), { x: 0, y: 0 });
  }

  it("does not move the children when the group is unrotated and unscaled", () => {
    // The property that makes the frame safe to drag around. With R and S both
    // identity the matrix is `T(location)` and the pivot cancels out entirely,
    // so resizing the box is purely a change of where the pivot will be *if*
    // rotation or scale is applied later.
    const small = childAt(50, 50);
    const large = childAt(800, 600);
    expect(large).toEqual(small);
  });

  it("keeps the child put however extreme the box gets", () => {
    expect(childAt(0, 0)).toEqual(childAt(4000, 3000));
  });

  it("does move the children once the group is rotated", () => {
    // Honest and unavoidable: the pivot is part of the transform, so moving it
    // under a rotation swings what hangs off it. Pinned rather than hidden —
    // the alternative would be compensating `location`, which would drag the
    // box away from the pointer that is resizing it.
    const small = childAt(50, 50, { rotation: 90 });
    const large = childAt(400, 400, { rotation: 90 });
    expect(large).not.toEqual(small);
  });

  it("puts the pivot at the centre of the box", () => {
    // A 200x200 box at (100, 100) pivots about (200, 200) in canvas space. A
    // child sitting on that point is the one thing a rotation cannot move.
    const elements: Timeline = {
      g: groupElement({
        location: { x: 100, y: 100 },
        width: 200,
        height: 200,
        rotation: 37,
      }) as any,
      c: imageElement({
        parentId: "g",
        location: { x: 100, y: 100 },
        width: 0,
        height: 0,
      }) as any,
    };
    const p = applyPoint(worldMatrixOf(elements, "c", 0), { x: 0, y: 0 });
    close(p.x, 200, 1e-9);
    close(p.y, 200, 1e-9);
  });

  it("rotates a child about the resized box's new centre", () => {
    // Widening the frame moves the pivot, and the child swings to match — this
    // is what makes the frame worth adjusting.
    const wide: Timeline = {
      g: groupElement({
        location: { x: 0, y: 0 },
        width: 400,
        height: 0,
        rotation: 180,
      }) as any,
      c: imageElement({
        parentId: "g",
        location: { x: 0, y: 0 },
        width: 0,
        height: 0,
      }) as any,
    };
    // Pivot is (200, 0); a half turn sends the child from x=0 to x=400.
    const p = applyPoint(worldMatrixOf(wide, "c", 0), { x: 0, y: 0 });
    close(p.x, 400, 1e-9);
  });

  it("scales a child away from the box's centre", () => {
    const twice = keys([0, 20]);
    const elements: Timeline = {
      g: groupElement({
        location: { x: 0, y: 0 },
        width: 100,
        height: 100,
        animation: {
          ...groupElement().animation,
          scale: { isActivate: true, x: twice, ax: bakeTrack(twice) },
        },
      }) as any,
      c: imageElement({
        parentId: "g",
        location: { x: 50, y: 50 },
        width: 0,
        height: 0,
      }) as any,
    };
    // The child sits on the pivot (50, 50), so doubling leaves it alone.
    const p = applyPoint(worldMatrixOf(elements, "c", 0), { x: 0, y: 0 });
    close(p.x, 50, 1e-9);
    close(p.y, 50, 1e-9);
  });
});
