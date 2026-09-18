import { describe, it, expect } from "vitest";
import { cropDragged, type CropZone } from "./cropRect";
import { MIN_CROP } from "../timeline/cropOps";
import type { CropRect } from "../../@types/timeline";

const rect = (x: number, y: number, width: number, height: number): CropRect => ({
  x,
  y,
  width,
  height,
});

/** A square frame, so a drawn ratio and a normalized one are the same number. */
const SQUARE = { width: 100, height: 100 };
/** A 2:1 frame, where they are not: a drawn 1:1 is a normalized 0.5. */
const WIDE = { width: 200, height: 100 };

const HALF = rect(0.25, 0.25, 0.5, 0.5);

const ZONES: CropZone[] = [
  "stretchN",
  "stretchS",
  "stretchE",
  "stretchW",
  "stretchNE",
  "stretchNW",
  "stretchSE",
  "stretchSW",
];

function drag(
  zone: CropZone,
  dx: number,
  dy: number,
  over: Partial<Parameters<typeof cropDragged>[0]> = {},
) {
  return cropDragged({
    origin: HALF,
    zone,
    dx,
    dy,
    aspect: null,
    frame: SQUARE,
    ...over,
  });
}

const near = (got: CropRect, want: CropRect, digits = 9) => {
  expect(got.x, "x").toBeCloseTo(want.x, digits);
  expect(got.y, "y").toBeCloseTo(want.y, digits);
  expect(got.width, "width").toBeCloseTo(want.width, digits);
  expect(got.height, "height").toBeCloseTo(want.height, digits);
};

// ------------------------------------------------------------------ free drags

describe("a free drag moves only the edges its grip drives", () => {
  it.each([
    ["stretchE", 0.1, 0.1, rect(0.25, 0.25, 0.6, 0.5)],
    ["stretchW", 0.1, 0.1, rect(0.35, 0.25, 0.4, 0.5)],
    ["stretchS", 0.1, 0.1, rect(0.25, 0.25, 0.5, 0.6)],
    ["stretchN", 0.1, 0.1, rect(0.25, 0.35, 0.5, 0.4)],
    ["stretchSE", 0.1, 0.1, rect(0.25, 0.25, 0.6, 0.6)],
    ["stretchNW", 0.1, 0.1, rect(0.35, 0.35, 0.4, 0.4)],
    ["stretchNE", 0.1, 0.1, rect(0.25, 0.35, 0.6, 0.4)],
    ["stretchSW", 0.1, 0.1, rect(0.35, 0.25, 0.4, 0.6)],
  ])("%s", (zone, dx, dy, want) => {
    near(drag(zone as CropZone, dx, dy), want);
  });

  it("holds the opposite edge still, whatever the delta", () => {
    for (const zone of ZONES) {
      for (const d of [-0.4, -0.1, 0, 0.1, 0.3]) {
        const out = drag(zone, d, d);
        // Whichever edges the grip does not drive are exactly where they were.
        if (zone === "stretchE" || zone === "stretchNE" || zone === "stretchSE") {
          expect(out.x, `${zone} left`).toBeCloseTo(HALF.x, 9);
        }
        if (zone === "stretchW" || zone === "stretchNW" || zone === "stretchSW") {
          expect(out.x + out.width, `${zone} right`).toBeCloseTo(
            HALF.x + HALF.width,
            9,
          );
        }
        if (zone === "stretchS" || zone === "stretchSE" || zone === "stretchSW") {
          expect(out.y, `${zone} top`).toBeCloseTo(HALF.y, 9);
        }
        if (zone === "stretchN" || zone === "stretchNE" || zone === "stretchNW") {
          expect(out.y + out.height, `${zone} bottom`).toBeCloseTo(
            HALF.y + HALF.height,
            9,
          );
        }
      }
    }
  });

  it("leaves an undriven axis exactly alone", () => {
    near(drag("stretchE", 0.1, 0.4), rect(0.25, 0.25, 0.6, 0.5));
    near(drag("stretchN", 0.4, -0.1), rect(0.25, 0.15, 0.5, 0.6));
  });

  it("is the identity at zero delta, for every grip", () => {
    for (const zone of ZONES) {
      near(drag(zone, 0, 0), HALF);
    }
  });
});

describe("a free drag stays inside the frame", () => {
  it.each(ZONES)("%s never leaves the unit square", (zone) => {
    for (const dx of [-5, -0.9, -0.3, 0.3, 0.9, 5]) {
      for (const dy of [-5, -0.9, 0.9, 5]) {
        const out = drag(zone, dx, dy);
        expect(out.x, `${zone} ${dx},${dy} x`).toBeGreaterThanOrEqual(-1e-12);
        expect(out.y).toBeGreaterThanOrEqual(-1e-12);
        expect(out.x + out.width).toBeLessThanOrEqual(1 + 1e-12);
        expect(out.y + out.height).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });

  it("rests against the edge rather than snapping back", () => {
    near(drag("stretchE", 5, 0), rect(0.25, 0.25, 0.75, 0.5));
    near(drag("stretchW", -5, 0), rect(0, 0.25, 0.75, 0.5));
    near(drag("stretchN", 0, -5), rect(0.25, 0, 0.5, 0.75));
    near(drag("stretchS", 0, 5), rect(0.25, 0.25, 0.5, 0.75));
  });

  it("holds the floor on each axis independently", () => {
    const out = drag("stretchSE", -5, -5);
    expect(out.width).toBeCloseTo(MIN_CROP, 12);
    expect(out.height).toBeCloseTo(MIN_CROP, 12);
    // Still anchored at the north-west corner it was dragged from.
    expect(out.x).toBeCloseTo(0.25, 9);
    expect(out.y).toBeCloseTo(0.25, 9);
  });

  it("flattens one axis against the floor while the other keeps moving", () => {
    const out = drag("stretchSE", -5, 0.1);
    expect(out.width).toBeCloseTo(MIN_CROP, 12);
    expect(out.height).toBeCloseTo(0.6, 9);
  });
});

// ------------------------------------------------------------- the aspect lock

describe("an aspect lock", () => {
  it("holds the drawn ratio on a square frame", () => {
    const out = drag("stretchSE", 0.2, 0, { aspect: 1, frame: SQUARE });
    expect(out.width / out.height).toBeCloseTo(1, 9);
  });

  it("converts a drawn ratio through the frame's own shape", () => {
    // A drawn 1:1 on a 2:1 frame is a normalized 1:2.
    const out = cropDragged({
      origin: rect(0.25, 0.25, 0.5, 0.5),
      zone: "stretchSE",
      dx: -0.1,
      dy: 0,
      aspect: 1,
      frame: WIDE,
    });
    expect(out.width / out.height).toBeCloseTo(0.5, 9);
    // And the drawn rectangle really is square.
    expect((out.width * WIDE.width) / (out.height * WIDE.height)).toBeCloseTo(1, 9);
  });

  it("follows the axis the pointer pushed further, on a corner", () => {
    // Deltas small enough that the frame is not what limits the answer: the
    // rect is anchored at 0.25, so anything past 0.75 is the edge talking
    // rather than the rule under test.
    const far = drag("stretchSE", 0.15, 0.02, { aspect: 1 });
    expect(far.width).toBeCloseTo(0.65, 9);
    expect(far.height).toBeCloseTo(0.65, 9);
    const tall = drag("stretchSE", 0.02, 0.15, { aspect: 1 });
    expect(tall.height).toBeCloseTo(0.65, 9);
    expect(tall.width).toBeCloseTo(0.65, 9);
  });

  it("flattens rather than inverting when a grip is dragged past its opposite", () => {
    // The bug this pins: a negative wanted size reached the locked branch,
    // where it was multiplied by the ratio and used as a divisor, so the rect
    // came back at the wrong shape instead of at the floor.
    for (const zone of ZONES) {
      for (const aspect of [1, 16 / 9, 9 / 16]) {
        const out = cropDragged({
          origin: HALF,
          zone,
          dx: zone.includes("W") ? 9 : -9,
          dy: zone.includes("N") ? 9 : -9,
          aspect,
          frame: SQUARE,
        });
        const drawn = (out.width * SQUARE.width) / (out.height * SQUARE.height);
        expect(drawn, `${zone} @ ${aspect}`).toBeCloseTo(aspect, 6);
        expect(out.width, `${zone} width`).toBeGreaterThanOrEqual(MIN_CROP - 1e-12);
        expect(out.height, `${zone} height`).toBeGreaterThanOrEqual(MIN_CROP - 1e-12);
      }
    }
  });

  it("spreads the undriven axis about the centre, on an edge", () => {
    // East drag under a 1:1 lock: the height follows, centred, so the rect keeps
    // its vertical middle rather than dropping downwards.
    const out = drag("stretchE", 0.1, 0, { aspect: 1 });
    expect(out.width).toBeCloseTo(0.6, 9);
    expect(out.height).toBeCloseTo(0.6, 9);
    expect(out.y + out.height / 2).toBeCloseTo(0.5, 9);
    expect(out.x).toBeCloseTo(0.25, 9);
  });

  it("spreads horizontally for a north or south drag", () => {
    const out = drag("stretchS", 0, 0.1, { aspect: 1 });
    expect(out.height).toBeCloseTo(0.6, 9);
    expect(out.width).toBeCloseTo(0.6, 9);
    expect(out.x + out.width / 2).toBeCloseTo(0.5, 9);
  });

  it("shrinks both axes together rather than breaking the ratio at an edge", () => {
    for (const zone of ZONES) {
      for (const aspect of [1, 16 / 9, 9 / 16, 21 / 9, 4 / 5]) {
        const out = cropDragged({
          origin: HALF,
          zone,
          dx: 9,
          dy: 9,
          aspect,
          frame: SQUARE,
        });
        const drawn =
          (out.width * SQUARE.width) / (out.height * SQUARE.height);
        expect(drawn, `${zone} @ ${aspect}`).toBeCloseTo(aspect, 6);
        expect(out.x).toBeGreaterThanOrEqual(-1e-12);
        expect(out.y).toBeGreaterThanOrEqual(-1e-12);
        expect(out.x + out.width).toBeLessThanOrEqual(1 + 1e-9);
        expect(out.y + out.height).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("keeps the ratio on a non-square frame at every grip", () => {
    for (const zone of ZONES) {
      const out = cropDragged({
        origin: HALF,
        zone,
        dx: 0.15,
        dy: -0.15,
        aspect: 16 / 9,
        frame: WIDE,
      });
      const drawn = (out.width * WIDE.width) / (out.height * WIDE.height);
      expect(drawn, zone).toBeCloseTo(16 / 9, 6);
    }
  });

  it("ignores a lock that is not a usable ratio", () => {
    for (const aspect of [0, -1, NaN, Infinity]) {
      const out = drag("stretchE", 0.1, 0, { aspect });
      near(out, rect(0.25, 0.25, 0.6, 0.5));
    }
  });

  it("ignores a lock when the frame has no shape", () => {
    const out = cropDragged({
      origin: HALF,
      zone: "stretchE",
      dx: 0.1,
      dy: 0,
      aspect: 1,
      frame: { width: 0, height: 0 },
    });
    near(out, rect(0.25, 0.25, 0.6, 0.5));
  });
});

// ------------------------------------------------------------------ the body

describe("dragging the body", () => {
  it("slides the rectangle without changing its size", () => {
    const out = drag("inside", 0.1, -0.1);
    near(out, rect(0.35, 0.15, 0.5, 0.5));
  });

  it("slides along an edge rather than leaving the frame", () => {
    // Pushed hard right and slightly down: it rests against the right edge and
    // still moves on the axis that has room.
    const out = drag("inside", 5, 0.1);
    near(out, rect(0.5, 0.35, 0.5, 0.5));
  });

  it("clamps into every corner", () => {
    near(drag("inside", -5, -5), rect(0, 0, 0.5, 0.5));
    near(drag("inside", 5, 5), rect(0.5, 0.5, 0.5, 0.5));
  });

  it("does not resize under an aspect lock", () => {
    const out = drag("inside", 0.1, 0.1, { aspect: 16 / 9 });
    expect(out.width).toBe(HALF.width);
    expect(out.height).toBe(HALF.height);
  });

  it("cannot move a rectangle that already fills the frame", () => {
    const out = cropDragged({
      origin: rect(0, 0, 1, 1),
      zone: "inside",
      dx: 0.3,
      dy: -0.3,
      aspect: null,
      frame: SQUARE,
    });
    near(out, rect(0, 0, 1, 1));
  });
});

// ------------------------------------------------------- the absolute setter

describe("the absolute-setter contract", () => {
  it("gives the same rect however many times the same delta is replayed", () => {
    for (const zone of ZONES) {
      const once = drag(zone, 0.13, -0.07, { aspect: 16 / 9 });
      for (let i = 0; i < 5; i++) {
        near(drag(zone, 0.13, -0.07, { aspect: 16 / 9 }), once, 12);
      }
    }
  });

  it("returns to the origin when the pointer comes back", () => {
    for (const zone of ZONES) {
      // A gesture that went out to a limit and back must land where it started.
      drag(zone, 9, 9);
      near(drag(zone, 0, 0), HALF, 12);
    }
  });

  it("treats a non-finite delta as no movement", () => {
    near(drag("stretchE", NaN, 0), HALF);
    near(drag("stretchSE", Infinity, NaN), HALF);
  });

  it("returns the origin for a zone it does not know", () => {
    near(drag("nonsense" as CropZone, 0.2, 0.2), HALF);
  });
});
