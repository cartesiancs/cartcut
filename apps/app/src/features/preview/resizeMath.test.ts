import { describe, it, expect } from "vitest";
import {
  constrainsAspect,
  resizedDocument,
  resizedRect,
  resizeSnap,
  SNAP_PADDING,
  type StretchZone,
} from "./resizeMath";
import type { Rect } from "./dragMath";
import {
  applyPoint,
  applyVector,
  IDENTITY,
  localMatrixOf,
  type Mat,
} from "../timeline/transform";

const ZONES: StretchZone[] = [
  "stretchE",
  "stretchW",
  "stretchN",
  "stretchS",
  "stretchNW",
  "stretchNE",
  "stretchSW",
  "stretchSE",
];

/**
 * Where each grip's anchor sits, as a fraction of the box: the corner or edge
 * diagonally opposite the one being dragged.
 *
 * Stated here independently of the implementation's own sign table, so the
 * tests assert what the behaviour should be rather than what it happens to do.
 */
const ANCHOR: Record<StretchZone, { u: number; v: number }> = {
  stretchE: { u: 0, v: 0.5 }, // west edge
  stretchW: { u: 1, v: 0.5 }, // east edge
  stretchN: { u: 0.5, v: 1 }, // south edge
  stretchS: { u: 0.5, v: 0 }, // north edge
  stretchNW: { u: 1, v: 1 }, // SE corner
  stretchNE: { u: 0, v: 1 }, // SW corner
  stretchSW: { u: 1, v: 0 }, // NE corner
  stretchSE: { u: 0, v: 0 }, // NW corner
};

const resize = (
  origin: Rect,
  zone: StretchZone,
  localDx: number,
  localDy: number,
  constrain = false,
  minSize = 10,
) => resizedRect({ origin, zone, localDx, localDy, constrain, minSize });

describe("resizedRect — free", () => {
  const origin: Rect = { x: 100, y: 100, w: 200, h: 100 };

  it("anchors the opposite edge and leaves the undriven axis alone", () => {
    expect(resize(origin, "stretchW", -50, 999)).toEqual({
      x: 50,
      y: 100,
      w: 250,
      h: 100,
    });
    expect(resize(origin, "stretchE", 50, 999)).toEqual({
      x: 100,
      y: 100,
      w: 250,
      h: 100,
    });
    expect(resize(origin, "stretchN", 999, -30)).toEqual({
      x: 100,
      y: 70,
      w: 200,
      h: 130,
    });
    expect(resize(origin, "stretchS", 999, 30)).toEqual({
      x: 100,
      y: 100,
      w: 200,
      h: 130,
    });
  });

  it("moves both axes from a corner and pins the opposite one", () => {
    const next = resize(origin, "stretchNE", 40, -20)!;
    expect(next).toEqual({ x: 100, y: 80, w: 240, h: 120 });
    // The SW corner of the original box, unmoved.
    expect(next.x).toBe(origin.x);
    expect(next.y + next.h).toBe(origin.y + origin.h);
  });

  /**
   * Each axis hits the floor on its own, which is what lets a shape be
   * flattened against one side without the whole drag freezing.
   */
  it("clamps one axis at the floor while the other keeps going", () => {
    expect(resize(origin, "stretchSE", -1000, 50)).toEqual({
      x: 100,
      y: 100,
      w: 10,
      h: 150,
    });
  });

  /**
   * Clamped, not declined. Declining returned the side's original length, so a
   * drag past the floor described a box at *full* size and only the caller
   * discarding the result kept the element pinned at the minimum.
   */
  it("pins the box at the floor, with the anchor still correct", () => {
    expect(resize(origin, "stretchSE", -1000, -1000)).toEqual({
      x: 100,
      y: 100,
      w: 10,
      h: 10,
    });
    // NW drives both anchors, so the SE corner must stay put as it collapses.
    const nw = resize(origin, "stretchNW", 1000, 1000)!;
    expect({ w: nw.w, h: nw.h }).toEqual({ w: 10, h: 10 });
    expect(nw.x + nw.w).toBe(origin.x + origin.w);
    expect(nw.y + nw.h).toBe(origin.y + origin.h);
  });

  it("never returns a side under the floor, on any zone or delta", () => {
    for (const zone of ZONES) {
      for (const d of [-5000, -201, -50, 0, 50, 5000]) {
        for (const constrain of [false, true]) {
          const next = resize(origin, zone, d, -d, constrain)!;
          expect(next.w, `${zone} ${d} ${constrain}`).toBeGreaterThanOrEqual(10);
          expect(next.h, `${zone} ${d} ${constrain}`).toBeGreaterThanOrEqual(10);
        }
      }
    }
  });
});

describe("resizedRect — constrained", () => {
  /**
   * The regression the old `getIntersection` path had.
   *
   * It rebuilt the size from `element.ratio` — the source file's native aspect,
   * never recomputed — so at zero delta it produced `height * ratio` rather than
   * the width the element actually had. Any element whose sides had been set
   * independently snapped to its native proportions on the first mouse move.
   * Expressed as a scale, `s` is 1 at zero delta whatever the proportions.
   */
  it("does not jump on the first mouse move of a non-native box", () => {
    const origin: Rect = { x: 0, y: 0, w: 200, h: 50 };
    expect(resize(origin, "stretchSE", 0, 0, true)).toEqual(origin);

    // Continuous across zero: one pixel of drag produces one pixel of growth,
    // not a leap to `h * ratio`.
    const next = resize(origin, "stretchSE", 1, 0, true)!;
    expect(next.x).toBe(0);
    expect(next.y).toBe(0);
    expect(next.w).toBeCloseTo(201, 10);
    expect(next.h).toBeCloseTo(50.25, 10);
  });

  it("holds the proportions the box had at mousedown, on every zone", () => {
    const origin: Rect = { x: 30, y: 40, w: 200, h: 50 };
    for (const zone of ZONES) {
      const next = resize(origin, zone, 37, -21, true)!;
      expect(next, zone).not.toBeNull();
      expect(next.w / next.h, zone).toBeCloseTo(origin.w / origin.h, 10);
    }
  });

  it("follows whichever axis the pointer pushed further", () => {
    const origin: Rect = { x: 0, y: 0, w: 200, h: 100 };
    expect(resize(origin, "stretchSE", 100, 0, true)).toMatchObject({
      w: 300,
      h: 150,
    });
    expect(resize(origin, "stretchSE", 0, 100, true)).toMatchObject({
      w: 400,
      h: 200,
    });
  });

  it("spreads the undriven axis about the centre for an edge grip", () => {
    expect(resize({ x: 0, y: 0, w: 100, h: 100 }, "stretchE", 100, 0, true)).toEqual(
      { x: 0, y: -50, w: 200, h: 200 },
    );
  });

  it("keeps the opposite corner fixed", () => {
    const origin: Rect = { x: 0, y: 0, w: 200, h: 100 };
    const nw = resize(origin, "stretchNW", -50, 0, true)!;
    expect(nw.x + nw.w).toBeCloseTo(origin.x + origin.w, 10);
    expect(nw.y + nw.h).toBeCloseTo(origin.y + origin.h, 10);

    const se = resize(origin, "stretchSE", 50, 0, true)!;
    expect(se.x).toBe(origin.x);
    expect(se.y).toBe(origin.y);
  });

  /** Stops at the floor rather than snapping back to the size it started at. */
  it("clamps at the floor with the proportions intact", () => {
    const origin: Rect = { x: 0, y: 0, w: 200, h: 100 };
    const next = resize(origin, "stretchSE", -10000, -10000, true)!;
    expect(next.w).toBeGreaterThanOrEqual(10);
    expect(next.h).toBeGreaterThanOrEqual(10);
    expect(next.w / next.h).toBeCloseTo(2, 10);
  });

  it("falls back to the free path for a box with no usable proportions", () => {
    const next = resize({ x: 0, y: 0, w: 0, h: 100 }, "stretchE", 50, 0, true)!;
    expect(next).toEqual({ x: 0, y: 0, w: 50, h: 100 });
  });
});

describe("resizedRect — declines", () => {
  const origin: Rect = { x: 10, y: 20, w: 200, h: 100 };

  /**
   * The origin rect, not null. "Nothing happened" is `resizedDocument`'s
   * judgement to make, against what the element actually holds — see the
   * identity tests there, which are what keep a bare click on a grip from
   * opening an undo step.
   */
  it("returns the origin rect for a zero delta on every zone, in both modes", () => {
    for (const zone of ZONES) {
      expect(resize(origin, zone, 0, 0, false), zone).toEqual(origin);
      expect(resize(origin, zone, 0, 0, true), zone).toEqual(origin);
    }
  });

  it("returns null rather than NaN for a degenerate origin or delta", () => {
    expect(resize(origin, "stretchSE", NaN, 0)).toBeNull();
    expect(resize(origin, "stretchSE", 0, Infinity)).toBeNull();
    expect(resize({ ...origin, w: NaN }, "stretchSE", 10, 10)).toBeNull();
    expect(resize({ ...origin, x: Infinity }, "stretchSE", 10, 10)).toBeNull();
    expect(resize(origin, "position" as StretchZone, 10, 10)).toBeNull();
  });

  it("never produces a non-finite side", () => {
    for (const zone of ZONES) {
      for (const constrain of [false, true]) {
        const next = resize({ x: 0, y: 0, w: 0, h: 0 }, zone, 40, -40, constrain);
        if (next == null) {
          continue;
        }
        for (const value of [next.x, next.y, next.w, next.h]) {
          expect(Number.isFinite(value), `${zone} ${constrain}`).toBe(true);
        }
      }
    }
  });
});

/**
 * The regression these exist for.
 *
 * `GestureCommit.apply` re-applies against the *live* document on every
 * mousemove, so a write that adjusts a value instead of setting one compounds.
 * The first version of `resizedDocument` read `location` off the live document
 * and added `next − originLocal`, which is constant for a stationary pointer —
 * so parking on the NE grip 20px above the start slid the element up 20px per
 * mouse event, forever, and the same for W, N, NW and SW. Only E, S and SE were
 * safe, because their anchor does not move.
 *
 * Every test here drives the document the way the gesture does — repeatedly,
 * cumulatively — rather than checking a single call, because a single call is
 * exactly what the broken version got right.
 */
describe("resizedDocument", () => {
  const ORIGIN: Rect = { x: 100, y: 100, w: 200, h: 100 };

  const docWith = (over: Record<string, any> = {}) =>
    ({
      elements: {
        a: {
          filetype: "shape",
          location: { x: ORIGIN.x, y: ORIGIN.y },
          width: ORIGIN.w,
          height: ORIGIN.h,
          ...over,
        },
      },
      tracks: [],
    }) as any;

  /** One mousemove: resolve the pointer delta, then write it into the doc. */
  const step = (
    doc: any,
    zone: StretchZone,
    dx: number,
    dy: number,
    originLocation = { x: ORIGIN.x, y: ORIGIN.y },
    constrain = false,
  ) => {
    const next = resize(ORIGIN, zone, dx, dy, constrain);
    if (next == null) {
      return doc;
    }
    return resizedDocument(doc, "a", {
      originLocal: ORIGIN,
      originLocation,
      next,
    });
  };

  const el = (doc: any) => doc.elements.a;

  it("does not move the element when the pointer holds still", () => {
    for (const zone of ZONES) {
      let doc = docWith();
      doc = step(doc, zone, 30, -20);
      const settled = { ...el(doc).location };
      const size = { w: el(doc).width, h: el(doc).height };

      // 60 more events at the same pointer position — a second of hovering.
      for (let i = 0; i < 60; i++) {
        doc = step(doc, zone, 30, -20);
      }

      expect(el(doc).location, zone).toEqual(settled);
      expect({ w: el(doc).width, h: el(doc).height }, zone).toEqual(size);
    }
  });

  it("lands where a single call would, however many events the drag took", () => {
    for (const zone of ZONES) {
      for (const constrain of [false, true]) {
        // A drag sampled at 40 intermediate positions...
        let dragged = docWith();
        for (let i = 1; i <= 40; i++) {
          dragged = step(
            dragged,
            zone,
            (60 * i) / 40,
            (-45 * i) / 40,
            undefined,
            constrain,
          );
        }
        // ...and the same drag delivered as one event.
        const jumped = step(
          docWith(),
          zone,
          60,
          -45,
          undefined,
          constrain,
        );

        expect(el(dragged), `${zone} ${constrain}`).toEqual(el(jumped));
      }
    }
  });

  it("returns to the start when the pointer does", () => {
    for (const zone of ZONES) {
      let doc = docWith();
      for (const [dx, dy] of [
        [40, -40],
        [80, 10],
        [-30, 60],
        [0, 0],
      ]) {
        doc = step(doc, zone, dx, dy);
      }
      expect(el(doc).location, zone).toEqual({ x: ORIGIN.x, y: ORIGIN.y });
      expect(el(doc).width, zone).toBe(ORIGIN.w);
      expect(el(doc).height, zone).toBe(ORIGIN.h);
    }
  });

  it("declines by identity when re-applied unchanged", () => {
    for (const zone of ZONES) {
      const once = step(docWith(), zone, 30, -20);
      const twice = step(once, zone, 30, -20);
      // Identity, not just equality: `GestureCommit` reads "nothing happened"
      // off object identity to decide whether to record an undo step.
      expect(twice, zone).toBe(once);
    }
  });

  it("declines by identity for an element that is not there", () => {
    const doc = docWith();
    expect(
      resizedDocument(doc, "missing", {
        originLocal: ORIGIN,
        originLocation: { x: 0, y: 0 },
        next: { x: 0, y: 0, w: 50, h: 50 },
      }),
    ).toBe(doc);
  });

  /**
   * An animated element is drawn where its track puts it, not at `location`.
   * The resize still writes `location`, so the anchor correction is measured
   * against the drawn rect and applied to the field — mixing the two is what
   * made a W or N drag on an animated clip slide by `animated − static`.
   */
  it("keeps the animation offset while anchoring an animated element", () => {
    // Drawn 500px right of where `location` says, and dragged from the W grip.
    const originLocation = { x: ORIGIN.x - 500, y: ORIGIN.y };
    let doc = docWith({ location: { ...originLocation } });

    for (let i = 0; i < 10; i++) {
      doc = step(doc, "stretchW", -60, 0, originLocation);
    }

    // The left edge moved 60px left of where it was drawn, so the field moves
    // 60px too — and exactly once, not once per event.
    expect(el(doc).location).toEqual({ x: originLocation.x - 60, y: ORIGIN.y });
    expect(el(doc).width).toBe(260);
  });

  it("leaves every other field on the element alone", () => {
    const doc = step(docWith({ rotation: 30, opacity: 55 }), "stretchNE", 40, -40);
    expect(el(doc)).toMatchObject({ rotation: 30, opacity: 55, filetype: "shape" });
  });

  it("does not mutate the document it was given", () => {
    const before = docWith();
    const snapshot = JSON.parse(JSON.stringify(before));
    step(before, "stretchNW", 40, -40);
    expect(before).toEqual(snapshot);
  });
});

describe("constrainsAspect", () => {
  /** The whole truth table, so a kind cannot quietly change sides. */
  it("frees text, group and shape by default and locks the rest", () => {
    for (const filetype of ["text", "group", "shape"]) {
      expect(constrainsAspect(filetype, false), filetype).toBe(false);
    }
    for (const filetype of ["image", "video", "gif"]) {
      expect(constrainsAspect(filetype, false), filetype).toBe(true);
    }
  });

  it("inverts every kind's default when Shift is held", () => {
    for (const filetype of ["text", "group", "shape", "image", "video", "gif"]) {
      expect(constrainsAspect(filetype, true), filetype).toBe(
        !constrainsAspect(filetype, false),
      );
    }
  });
});

/**
 * What a rotated resize has to do, and what it used to do instead.
 *
 * `localMatrixOf` turns the element about the centre of its box, and that
 * centre moves the moment `width` or `height` change. Holding the anchor by
 * pinning the unrotated rect's own coordinates — keeping `x + w` fixed — is
 * therefore only correct while the element is upright; at any other angle the
 * pinned corner swings around the moving centre and the box slides off in a
 * direction unrelated to the drag.
 *
 * These assert through `localMatrixOf` and `applyPoint`, the functions the
 * renderer actually draws with, rather than restating the formula under test.
 * The anchor each grip must hold is spelled out independently below.
 */
describe("resizedRect — rotated and scaled", () => {
  const elementAt = (rect: Rect, rotation: number, scaleTenths?: number) =>
    ({
      filetype: "shape",
      location: { x: rect.x, y: rect.y },
      width: rect.w,
      height: rect.h,
      rotation,
      startTime: 0,
      animation:
        scaleTenths == null
          ? undefined
          : {
              scale: { isActivate: true, x: [], ax: [[0, scaleTenths]] },
            },
    }) as any;

  /** The anchor's position in the parent's space, through the real matrix. */
  const anchorPoint = (element: any, { u, v }: { u: number; v: number }) =>
    applyPoint(localMatrixOf(element, 0), {
      x: u * element.width,
      y: v * element.height,
    });

  const ROTATIONS = [0, 30, 45, 90, 137, 180, 270, -45, 359];

  it("keeps the opposite corner under the same pixel, at every angle", () => {
    const origin: Rect = { x: 100, y: 60, w: 200, h: 120 };

    for (const rotation of ROTATIONS) {
      for (const zone of ZONES) {
        for (const constrain of [false, true]) {
          for (const [dx, dy] of [
            [50, 30],
            [-40, 25],
            [80, -60],
            [-15, -15],
          ]) {
            const before = elementAt(origin, rotation);
            const next = resizedRect({
              origin,
              zone,
              localDx: dx,
              localDy: dy,
              constrain,
              minSize: 10,
              linear: localMatrixOf(before, 0),
            })!;
            const after = elementAt(next, rotation);

            const label = `${zone} @${rotation}° ${dx},${dy} c=${constrain}`;
            const held = ANCHOR[zone];
            expect(anchorPoint(after, held).x, label).toBeCloseTo(
              anchorPoint(before, held).x,
              8,
            );
            expect(anchorPoint(after, held).y, label).toBeCloseTo(
              anchorPoint(before, held).y,
              8,
            );
          }
        }
      }
    }
  });

  it("keeps the opposite corner fixed for a scaled element too", () => {
    const origin: Rect = { x: 40, y: 40, w: 160, h: 90 };

    for (const scaleTenths of [5, 10, 25]) {
      for (const zone of ZONES) {
        const before = elementAt(origin, 35, scaleTenths);
        const next = resizedRect({
          origin,
          zone,
          localDx: 45,
          localDy: -30,
          constrain: false,
          minSize: 10,
          linear: localMatrixOf(before, 0),
        })!;
        const after = elementAt(next, 35, scaleTenths);

        const label = `${zone} s=${scaleTenths}`;
        const held = ANCHOR[zone];
        expect(anchorPoint(after, held).x, label).toBeCloseTo(
          anchorPoint(before, held).x,
          8,
        );
        expect(anchorPoint(after, held).y, label).toBeCloseTo(
          anchorPoint(before, held).y,
          8,
        );
      }
    }
  });

  /**
   * Rotation places the box; it must not change how big the drag makes it. The
   * pointer delta arrives already taken into the element's own axes, so the
   * same delta means the same size whichever way the element is facing.
   */
  it("sizes the box identically however the element is rotated", () => {
    const origin: Rect = { x: 100, y: 60, w: 200, h: 120 };

    for (const zone of ZONES) {
      for (const constrain of [false, true]) {
        const upright = resizedRect({
          origin,
          zone,
          localDx: 55,
          localDy: -35,
          constrain,
          minSize: 10,
        })!;

        for (const rotation of ROTATIONS) {
          const turned = resizedRect({
            origin,
            zone,
            localDx: 55,
            localDy: -35,
            constrain,
            minSize: 10,
            linear: localMatrixOf(elementAt(origin, rotation), 0),
          })!;
          const label = `${zone} @${rotation}° c=${constrain}`;
          expect(turned.w, label).toBeCloseTo(upright.w, 10);
          expect(turned.h, label).toBeCloseTo(upright.h, 10);
        }
      }
    }
  });

  /** An upright element must behave exactly as it did before `linear` existed. */
  it("matches the identity result when the element is upright", () => {
    const origin: Rect = { x: 100, y: 60, w: 200, h: 120 };

    for (const zone of ZONES) {
      for (const constrain of [false, true]) {
        const withoutLinear = resizedRect({
          origin,
          zone,
          localDx: 55,
          localDy: -35,
          constrain,
          minSize: 10,
        });
        const withIdentity = resizedRect({
          origin,
          zone,
          localDx: 55,
          localDy: -35,
          constrain,
          minSize: 10,
          linear: localMatrixOf(elementAt(origin, 0), 0),
        });
        expect(withIdentity, `${zone} c=${constrain}`).toEqual(withoutLinear);
      }
    }
  });

  it("returns null rather than NaN for a degenerate matrix", () => {
    const origin: Rect = { x: 0, y: 0, w: 100, h: 100 };
    for (const bad of [{ a: NaN }, { b: Infinity }, { c: NaN }, { d: NaN }]) {
      expect(
        resizedRect({
          origin,
          zone: "stretchSE",
          localDx: 10,
          localDy: 10,
          constrain: false,
          minSize: 10,
          linear: { ...IDENTITY, ...bad },
        }),
      ).toBeNull();
    }
  });
});

/**
 * Snapping a resize, which did not exist.
 *
 * `alignDirection` was written only by the move branch and `isAlign` was never
 * called from the resize one, so dragging an element out to fill the frame was
 * a pixel-hunt with no magnet and no guide. `isAlign` could not be reused as it
 * stands: it slides a rect of *fixed size* until an edge lands on a line, where
 * a resize has to hold the anchor and change the size instead.
 *
 * These assert on where the edge actually lands, through the same matrix
 * composition the renderer uses, and on the anchor still being held afterwards.
 */
describe("resizeSnap", () => {
  const FRAME = { w: 1920, h: 1080 };

  /** The parent-space box of the element `resizedRect` would produce. */
  const boxOf = (rect: Rect, linear = IDENTITY) => {
    const cx = rect.w / 2;
    const cy = rect.h / 2;
    const corner = (u: number, v: number) => {
      const spun = applyVector(linear, { x: u * rect.w - cx, y: v * rect.h - cy });
      return { x: rect.x + cx + spun.x, y: rect.y + cy + spun.y };
    };
    return { nw: corner(0, 0), se: corner(1, 1) };
  };

  /** Run the real two-step the canvas runs: snap the delta, then resize. */
  const drag = (input: {
    origin: Rect;
    zone: StretchZone;
    dx?: number;
    dy?: number;
    constrain?: boolean;
    linear?: Mat;
    parentMatrix?: Mat;
    minSize?: number;
  }) => {
    const dx = input.dx ?? 0;
    const dy = input.dy ?? 0;
    const common = {
      origin: input.origin,
      zone: input.zone,
      constrain: input.constrain ?? false,
      minSize: input.minSize ?? 10,
      linear: input.linear,
    };
    const snapped = resizeSnap({
      ...common,
      localDx: dx,
      localDy: dy,
      parentMatrix: input.parentMatrix,
      frame: FRAME,
    });
    const rect = resizedRect({
      ...common,
      localDx: snapped.localDx,
      localDy: snapped.localDy,
    })!;
    return { rect, direction: snapped.direction, snapped };
  };

  /**
   * The case that prompted this: an element dragged out to fill the frame lands
   * on it exactly, rather than a few pixels short with nothing to aim at.
   */
  it("fills the frame exactly from a corner drag that comes close", () => {
    const origin: Rect = { x: 0, y: 0, w: 1000, h: 600 };
    // Pointer 7px short of the bottom-right corner — well inside the magnet.
    const { rect, direction } = drag({
      origin,
      zone: "stretchSE",
      dx: FRAME.w - origin.w - 7,
      dy: FRAME.h - origin.h - 7,
    });

    expect(rect).toEqual({ x: 0, y: 0, w: FRAME.w, h: FRAME.h });
    expect(direction.sort()).toEqual(["bottom", "right"]);
  });

  it("snaps a single edge to each frame line, and names the guide", () => {
    const origin: Rect = { x: 400, y: 300, w: 400, h: 200 };

    const right = drag({ zone: "stretchE", origin, dx: FRAME.w - 800 - 6, dy: 0 });
    expect(boxOf(right.rect).se.x).toBeCloseTo(FRAME.w, 9);
    expect(right.direction).toEqual(["right"]);

    const left = drag({ zone: "stretchW", origin, dx: -394, dy: 0 });
    expect(boxOf(left.rect).nw.x).toBeCloseTo(0, 9);
    expect(left.direction).toEqual(["left"]);

    const bottom = drag({ zone: "stretchS", origin, dx: 0, dy: FRAME.h - 500 - 9 });
    expect(boxOf(bottom.rect).se.y).toBeCloseTo(FRAME.h, 9);
    expect(bottom.direction).toEqual(["bottom"]);

    const top = drag({ zone: "stretchN", origin, dx: 0, dy: -294 });
    expect(boxOf(top.rect).nw.y).toBeCloseTo(0, 9);
    expect(top.direction).toEqual(["top"]);
  });

  it("snaps to the frame's centre lines too", () => {
    const origin: Rect = { x: 0, y: 0, w: 400, h: 200 };

    const vertical = drag({ zone: "stretchE", origin, dx: FRAME.w / 2 - 400 - 8 });
    expect(boxOf(vertical.rect).se.x).toBeCloseTo(FRAME.w / 2, 9);
    expect(vertical.direction).toEqual(["vertical"]);

    const horizontal = drag({ zone: "stretchS", origin, dx: 0, dy: FRAME.h / 2 - 200 + 5 });
    expect(boxOf(horizontal.rect).se.y).toBeCloseTo(FRAME.h / 2, 9);
    expect(horizontal.direction).toEqual(["horizontal"]);
  });

  it("leaves the drag alone outside the magnet's reach", () => {
    const origin: Rect = { x: 0, y: 0, w: 400, h: 200 };
    const far = FRAME.w - 400 - (SNAP_PADDING + 1);
    const { rect, direction, snapped } = drag({ zone: "stretchE", origin, dx: far });

    expect(direction).toEqual([]);
    expect(snapped.localDx).toBe(far);
    expect(boxOf(rect).se.x).toBeCloseTo(FRAME.w - (SNAP_PADDING + 1), 9);
  });

  it("pulls from either side of the line", () => {
    const origin: Rect = { x: 0, y: 0, w: 400, h: 200 };
    for (const overshoot of [-9, -1, 0, 1, 9]) {
      const { rect } = drag({
        zone: "stretchE",
        origin,
        dx: FRAME.w - 400 + overshoot,
      });
      expect(boxOf(rect).se.x, `${overshoot}`).toBeCloseTo(FRAME.w, 9);
    }
  });

  /**
   * The invariant the previous fix established. A snap that moved the edge
   * without telling the anchor arithmetic would drag the opposite corner along
   * with it, which is why the correction goes into the delta and not the rect.
   */
  it("still holds the anchor after snapping, on every zone", () => {
    const origin: Rect = { x: 300, y: 200, w: 400, h: 300 };

    const anchorPointOf = (rect: Rect, { u, v }: { u: number; v: number }) => {
      const cx = rect.w / 2;
      const cy = rect.h / 2;
      const spun = applyVector(IDENTITY, {
        x: u * rect.w - cx,
        y: v * rect.h - cy,
      });
      return { x: rect.x + cx + spun.x, y: rect.y + cy + spun.y };
    };

    for (const zone of ZONES) {
      // Deltas chosen to land inside a frame line's pull, so a snap really does
      // fire and the anchor is tested against a corrected delta.
      for (const [dx, dy] of [
        [FRAME.w - 700 - 5, FRAME.h - 500 - 5],
        [-295, -195],
        [900, 400],
      ]) {
        const held = ANCHOR[zone];
        const before = anchorPointOf(origin, held);
        const { rect } = drag({ zone, origin, dx, dy });
        const after = anchorPointOf(rect, held);

        const label = `${zone} ${dx},${dy}`;
        expect(after.x, label).toBeCloseTo(before.x, 9);
        expect(after.y, label).toBeCloseTo(before.y, 9);
      }
    }
  });

  it("snaps a scaled element by where it is drawn, not by its fields", () => {
    // Scale 2 about the centre: a 400-wide box is drawn 800 wide.
    const linear: Mat = { ...IDENTITY, a: 2, d: 2 };
    const origin: Rect = { x: 0, y: 0, w: 400, h: 200 };
    const { rect, direction } = drag({
      zone: "stretchE",
      origin,
      // Drawn east edge starts at 0 + 200 + 2*200 = 600; aim near the frame's
      // right edge, which the *drawn* box must reach, not the field.
      dx: (FRAME.w - 600) / 2 - 6,
      linear,
    });

    expect(boxOf(rect, linear).se.x).toBeCloseTo(FRAME.w, 8);
    expect(direction).toEqual(["right"]);
  });

  it("snaps in world space for a child of a translated, scaled group", () => {
    // Parent halves everything and shifts it right by 200.
    const parentMatrix: Mat = { a: 0.5, b: 0, c: 0, d: 0.5, e: 200, f: 0 };
    const origin: Rect = { x: 0, y: 0, w: 400, h: 200 };
    // The child's east edge sits at world 200 + 0.5*400 = 400. Reaching the
    // frame's right edge needs (1920 - 400) / 0.5 = 3040 in local units.
    const { rect, direction } = drag({
      zone: "stretchE",
      origin,
      dx: 3040 - 5,
      parentMatrix,
    });

    const worldEast = applyPoint(parentMatrix, boxOf(rect).se);
    expect(worldEast.x).toBeCloseTo(FRAME.w, 8);
    expect(direction).toEqual(["right"]);
  });

  it("declines to snap a rotated element, and draws no guide for it", () => {
    const origin: Rect = { x: 0, y: 0, w: 400, h: 200 };
    for (const rotation of [1, 30, 45, -20]) {
      const theta = (rotation * Math.PI) / 180;
      const linear: Mat = {
        ...IDENTITY,
        a: Math.cos(theta),
        b: Math.sin(theta),
        c: -Math.sin(theta),
        d: Math.cos(theta),
      };
      const dx = FRAME.w - 400 - 3;
      const snapped = resizeSnap({
        origin,
        zone: "stretchE",
        localDx: dx,
        localDy: 0,
        constrain: false,
        minSize: 10,
        linear,
        frame: FRAME,
      });
      expect(snapped.direction, `${rotation}°`).toEqual([]);
      expect(snapped.localDx, `${rotation}°`).toBe(dx);
    }
  });

  it("declines to snap a child of a rotated group", () => {
    const theta = Math.PI / 6;
    const parentMatrix: Mat = {
      a: Math.cos(theta),
      b: Math.sin(theta),
      c: -Math.sin(theta),
      d: Math.cos(theta),
      e: 0,
      f: 0,
    };
    const snapped = resizeSnap({
      origin: { x: 0, y: 0, w: 400, h: 200 },
      zone: "stretchE",
      localDx: 1500,
      localDy: 0,
      constrain: false,
      minSize: 10,
      parentMatrix,
      frame: FRAME,
    });
    expect(snapped.direction).toEqual([]);
  });

  /**
   * One scale drives both sides, so honouring two targets at once is generally
   * impossible. Take the nearer line and let the proportions place the rest.
   */
  it("snaps one axis only when proportions are constrained, and keeps them", () => {
    const origin: Rect = { x: 0, y: 0, w: 400, h: 200 };
    const { rect, direction } = drag({
      zone: "stretchSE",
      origin,
      dx: FRAME.w - 400 - 4,
      dy: 300,
      constrain: true,
    });

    expect(direction).toEqual(["right"]);
    expect(boxOf(rect).se.x).toBeCloseTo(FRAME.w, 8);
    expect(rect.w / rect.h).toBeCloseTo(origin.w / origin.h, 9);
  });

  /** A guide drawn where the element is not is worse than no guide. */
  it("claims no guide when minSize stops the edge short of the line", () => {
    const origin: Rect = { x: 0, y: 0, w: 400, h: 200 };
    // Aim the east edge at the frame's left edge: the box would have to be
    // negative, so `minSize` clamps it and the edge never arrives.
    const { rect, direction } = drag({ zone: "stretchE", origin, dx: -400 + 3 });

    expect(direction).toEqual([]);
    expect(rect.w).toBe(10);
  });

  it("never snaps an axis the grip does not drive", () => {
    // A pure east drag whose *vertical* edges happen to sit on frame lines.
    const origin: Rect = { x: 0, y: 0, w: 400, h: FRAME.h };
    const { direction } = drag({ zone: "stretchE", origin, dx: 50 });
    expect(direction).toEqual([]);
  });

  it("survives a degenerate frame or zone without throwing", () => {
    const origin: Rect = { x: 0, y: 0, w: 400, h: 200 };
    for (const frame of [
      { w: NaN, h: 1080 },
      { w: 1920, h: Infinity },
    ]) {
      const snapped = resizeSnap({
        origin,
        zone: "stretchE",
        localDx: 30,
        localDy: 0,
        constrain: false,
        minSize: 10,
        frame,
      });
      expect(snapped.direction).toEqual([]);
      expect(snapped.localDx).toBe(30);
    }
  });
});
