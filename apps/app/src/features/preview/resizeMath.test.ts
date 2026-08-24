import { describe, it, expect } from "vitest";
import {
  constrainsAspect,
  resizedDocument,
  resizedRect,
  type StretchZone,
} from "./resizeMath";
import type { Rect } from "./dragMath";

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
