import { describe, expect, it } from "vitest";
import {
  EDGE_SCROLL,
  UNARMED,
  axisVelocity,
  contentTravel,
  createEdgeScroller,
  maxVerticalScroll,
  pinToBand,
  scrollAxesOf,
  scrollStep,
  updateArm,
  wholeRowsInView,
  type Band,
  type EdgeArm,
} from "./edgeScroll";
import { resolveMove } from "./dragResolve";
import { moveClips } from "./clipOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { imageElement } from "../renderer/testing";
import {
  RULER_OFFSET,
  TRACK_GAP,
  TRACK_HEIGHT,
  TRACK_PITCH,
  layoutTimeline,
  rowStack,
  type RowStack,
} from "./layout";

const { ZONE_PX, RAMP_PX, MIN_PX_PER_S, MAX_PX_PER_S, MAX_STEP_MS, ARM_PX } =
  EDGE_SCROLL;

const ARMED: EdgeArm = { low: true, high: true };
/** A 400px row area under the ruler. */
const BAND: Band = { lo: RULER_OFFSET, hi: RULER_OFFSET + 400 };

/** Eight video rows, a clip on the last. */
function tallDoc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: Array.from({ length: 8 }, (_, i) =>
      createTrack(`v${i}`, "video", i),
    ),
    elements: { a: imageElement({ trackId: "v7", startTime: 1000 }) },
  });
}

function moveBy(base: TimelineDocument, dxPx: number, dyPx: number) {
  return resolveMove({
    base,
    primaryId: "a",
    dragIds: ["a"],
    dxPx,
    dyPx,
    free: true,
    range: 0.9,
    fps: 30,
    playheadMs: 0,
    stack: rowStack(base.tracks),
  });
}

describe("contentTravel", () => {
  it("adds the scroll's change to the screen travel, on both axes", () => {
    expect(
      contentTravel({ dx: 10, dy: -5 }, { h: 100, v: 200 }, { h: 130, v: 80 }),
    ).toEqual({ dx: 40, dy: -125 });
  });

  it("is the screen travel when nothing scrolled", () => {
    expect(
      contentTravel({ dx: 7, dy: 9 }, { h: 50, v: 50 }, { h: 50, v: 50 }),
    ).toEqual({ dx: 7, dy: 9 });
  });

  it("carries a still pointer across the rows the view scrolled past", () => {
    // The pointer has not moved; the rows went down under it by three pitches
    // (the view scrolled up). The clip must go up three rows with them.
    const base = tallDoc();
    const atDown = { h: 0, v: 7 * TRACK_PITCH };
    const now = { h: 0, v: 4 * TRACK_PITCH };
    const travel = contentTravel({ dx: 0, dy: 0 }, atDown, now);

    const plan = moveBy(base, travel.dx, travel.dy);
    expect(plan).toMatchObject({ kind: "move", trackDelta: -3 });
    if (plan.kind !== "move") return;
    expect(
      moveClips(base, ["a"], plan.appliedMs, plan.trackDelta).elements.a
        .trackId,
    ).toBe("v4");

    // The harness measures something: the same gesture read in screen px, the
    // way the canvas did before, goes nowhere.
    expect(moveBy(base, 0, 0).kind).toBe("none");
  });

  it("reaches the top row from the bottom one by scroll alone", () => {
    const base = tallDoc();
    const travel = contentTravel(
      { dx: 0, dy: 0 },
      { h: 0, v: 7 * TRACK_PITCH },
      { h: 0, v: 0 },
    );
    const plan = moveBy(base, travel.dx, travel.dy);
    expect(plan).toMatchObject({ kind: "move", trackDelta: -7 });
  });
});

describe("pinToBand", () => {
  const band: Band = { lo: 0, hi: 600 };

  it("passes travel through while the pointer stays inside", () => {
    expect(pinToBand(100, 250, band)).toBe(250);
    expect(pinToBand(100, -100, band)).toBe(-100);
  });

  it("holds the pointer at either edge", () => {
    expect(pinToBand(100, 900, band)).toBe(500);
    expect(pinToBand(100, -300, band)).toBe(-100);
  });

  it("leaves travel alone on a band with no extent", () => {
    expect(pinToBand(100, 900, { lo: 0, hi: 0 })).toBe(900);
  });
});

/** `n` rows, every one at the default height unless `heights` says otherwise. */
function rowsOf(n: number, heights: Record<string, number> = {}): RowStack {
  return rowStack(
    Array.from({ length: n }, (_, i) => createTrack(`r${i}`, "video", i)),
    heights,
  );
}

describe("wholeRowsInView", () => {
  const band: Band = { lo: RULER_OFFSET, hi: RULER_OFFSET + 4 * TRACK_PITCH };

  it("is the rows that fit, unscrolled", () => {
    expect(wholeRowsInView(0, band, rowsOf(30))).toEqual({ first: 0, last: 3 });
  });

  it("drops a row the ruler half covers, and one cut off at the bottom", () => {
    // Twenty px down: row 0 is half under the ruler and row 4 is not yet in.
    expect(wholeRowsInView(20, band, rowsOf(30))).toEqual({ first: 1, last: 3 });
  });

  it("follows the scroll a whole pitch at a time", () => {
    expect(wholeRowsInView(10 * TRACK_PITCH, band, rowsOf(30))).toEqual({
      first: 10,
      last: 13,
    });
  });

  it("never names a row that does not exist", () => {
    expect(wholeRowsInView(0, band, rowsOf(2))).toEqual({ first: 0, last: 1 });
    expect(wholeRowsInView(1e5, band, rowsOf(30))).toBeNull();
  });

  it("is null when the band is shorter than a row", () => {
    expect(
      wholeRowsInView(
        0,
        { lo: RULER_OFFSET, hi: RULER_OFFSET + 30 },
        rowsOf(30),
      ),
    ).toBeNull();
  });

  it("keeps the last row in view at the furthest scroll", () => {
    const rows = 30;
    const total = RULER_OFFSET + rows * TRACK_PITCH;
    const visibleBottom = 235.9;
    const max = maxVerticalScroll(total, visibleBottom);
    expect(
      wholeRowsInView(
        max,
        { lo: RULER_OFFSET, hi: visibleBottom },
        rowsOf(rows),
      )?.last,
    ).toBe(rows - 1);
  });

  it("is the old pitch division wherever the rows are all the default height", () => {
    // The formula this replaced, copied here as an oracle that shares no code
    // with the subject.
    const old = (v: number, b: Band, n: number, top: number) => {
      const first = Math.max(0, Math.ceil((b.lo - top + v) / TRACK_PITCH));
      const last = Math.min(
        n - 1,
        Math.floor((b.hi - TRACK_HEIGHT - top + v) / TRACK_PITCH),
      );
      return first <= last ? { first, last } : null;
    };
    const bands: Band[] = [
      { lo: RULER_OFFSET, hi: RULER_OFFSET + 400 },
      { lo: RULER_OFFSET, hi: 235.9 },
      { lo: 0, hi: 30 },
      { lo: 12.5, hi: 190.25 },
    ];
    let checked = 0;
    for (const n of [0, 1, 2, 5, 30]) {
      const stack = rowsOf(n);
      for (const top of [0, RULER_OFFSET]) {
        for (const b of bands) {
          for (let v = 0; v <= 40 * TRACK_PITCH; v += 1.75) {
            expect(wholeRowsInView(v, b, stack, top)).toEqual(old(v, b, n, top));
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it("disagrees with the old division below a resized row", () => {
    // Proves the sweep can fail. Row 1 at 120: by the fixed pitch rows 0 to 3
    // fit the band, but row 3 now ends 80px lower and does not.
    const stack = rowsOf(30, { r1: 120 });
    expect(wholeRowsInView(0, band, stack)).toEqual({ first: 0, last: 1 });
    expect(wholeRowsInView(0, band, rowsOf(30))).toEqual({ first: 0, last: 3 });
  });

  it("measures each row by its own height", () => {
    // A 200px row is only wholly in view once all of it is.
    const tall = rowsOf(3, { r1: 200 });
    const tight: Band = { lo: RULER_OFFSET, hi: RULER_OFFSET + 240 };
    expect(wholeRowsInView(0, tight, tall)).toEqual({ first: 0, last: 0 });
    expect(wholeRowsInView(TRACK_PITCH, tight, tall)).toEqual({
      first: 1,
      last: 1,
    });
  });
});

describe("maxVerticalScroll with resized rows", () => {
  it("keeps the last row's bottom one gap above the visible bottom", () => {
    const doc = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: Array.from({ length: 6 }, (_, i) =>
        createTrack(`r${i}`, "video", i),
      ),
      elements: {},
    });
    const heights = { r2: 150, r5: 32 };
    const visibleBottom = 260;
    const total = layoutTimeline({
      doc,
      range: 0.9,
      hScroll: 0,
      vScroll: 0,
      viewportW: 800,
      viewportH: 600,
      heights,
    }).totalHeight;
    const max = maxVerticalScroll(total, visibleBottom);
    const at = layoutTimeline({
      doc,
      range: 0.9,
      hScroll: 0,
      vScroll: max,
      viewportW: 800,
      viewportH: 600,
      heights,
    });
    const last = at.rows[at.rows.length - 1];
    expect(last.height).toBe(32);
    expect(last.top + last.height).toBe(visibleBottom - TRACK_GAP);
  });
});

describe("scrollAxesOf", () => {
  it("lets a freed clip scroll both ways and a slide only along time", () => {
    expect(scrollAxesOf("moveFree")).toEqual({ x: true, y: true });
    expect(scrollAxesOf("moveH")).toEqual({ x: true, y: false });
  });

  it("scrolls for nothing else", () => {
    for (const phase of [
      "idle",
      "pressed",
      "marquee",
      "trimStart",
      "trimEnd",
      "transitionStart",
      "transitionEnd",
      "level",
      "levelPoint",
    ] as const) {
      expect(scrollAxesOf(phase)).toEqual({ x: false, y: false });
    }
  });
});

describe("axisVelocity", () => {
  it("is zero in the middle of the band", () => {
    expect(axisVelocity((BAND.lo + BAND.hi) / 2, BAND, ARMED)).toBe(0);
  });

  it("is zero right on a zone's inner line, and starts just past it", () => {
    expect(axisVelocity(BAND.lo + ZONE_PX, BAND, ARMED)).toBe(0);
    expect(axisVelocity(BAND.hi - ZONE_PX, BAND, ARMED)).toBe(0);

    const up = axisVelocity(BAND.lo + ZONE_PX - 0.01, BAND, ARMED);
    const down = axisVelocity(BAND.hi - ZONE_PX + 0.01, BAND, ARMED);
    expect(up).toBeLessThan(0);
    expect(down).toBeGreaterThan(0);
    expect(Math.abs(up)).toBeCloseTo(MIN_PX_PER_S, 0);
    expect(down).toBeCloseTo(MIN_PX_PER_S, 0);
  });

  it("is zero in a zone that is not armed", () => {
    expect(axisVelocity(BAND.lo, BAND, UNARMED)).toBe(0);
    expect(axisVelocity(BAND.hi, BAND, { low: true, high: false })).toBe(0);
    expect(axisVelocity(BAND.lo, BAND, { low: false, high: true })).toBe(0);
  });

  it("grows with depth and tops out past the ramp, outside the canvas too", () => {
    const inner = BAND.hi - ZONE_PX;
    let previous = 0;
    for (let depth = 1; depth <= RAMP_PX; depth += 1) {
      const v = axisVelocity(inner + depth, BAND, ARMED);
      expect(v).toBeGreaterThan(previous);
      previous = v;
    }
    expect(previous).toBe(MAX_PX_PER_S);
    expect(axisVelocity(inner + RAMP_PX * 5, BAND, ARMED)).toBe(MAX_PX_PER_S);
    expect(axisVelocity(-1000, BAND, ARMED)).toBe(-MAX_PX_PER_S);
  });

  it("is symmetric between the two edges", () => {
    for (const depth of [1, 10, 40, 100]) {
      expect(axisVelocity(BAND.lo + ZONE_PX - depth, BAND, ARMED)).toBe(
        -axisVelocity(BAND.hi - ZONE_PX + depth, BAND, ARMED),
      );
    }
  });

  it("shrinks the zones on a short band so they cannot overlap", () => {
    const short: Band = { lo: 0, hi: 30 };
    // A third of 30 each: 0..10 scrolls up, 20..30 scrolls down, 10..20 is still.
    expect(axisVelocity(15, short, ARMED)).toBe(0);
    expect(axisVelocity(5, short, ARMED)).toBeLessThan(0);
    expect(axisVelocity(25, short, ARMED)).toBeGreaterThan(0);
  });

  it("is zero on a band with no extent, and for a non-finite position", () => {
    expect(axisVelocity(-50, { lo: 40, hi: 40 }, ARMED)).toBe(0);
    expect(axisVelocity(NaN, BAND, ARMED)).toBe(0);
  });
});

describe("updateArm", () => {
  /** A press inside the bottom zone, as on the last visible row. */
  const pressedLow = BAND.hi - ZONE_PX / 2;

  it("arms every zone the press did not start in", () => {
    expect(updateArm(UNARMED, pressedLow, pressedLow, BAND)).toEqual({
      low: true,
      high: false,
    });
  });

  it("arms the zone it started in after travelling towards it", () => {
    expect(
      updateArm(UNARMED, pressedLow + ARM_PX - 1, pressedLow, BAND).high,
    ).toBe(false);
    expect(updateArm(UNARMED, pressedLow + ARM_PX, pressedLow, BAND).high).toBe(
      true,
    );
  });

  it("arms the zone it started in once the pointer has left it", () => {
    const left = updateArm(UNARMED, BAND.hi - ZONE_PX - 1, pressedLow, BAND);
    expect(left.high).toBe(true);
    // And it stays armed on coming back to where the press was.
    expect(updateArm(left, pressedLow, pressedLow, BAND).high).toBe(true);
  });

  it("does the same for the top", () => {
    const pressedHigh = BAND.lo + ZONE_PX / 2;
    expect(updateArm(UNARMED, pressedHigh, pressedHigh, BAND)).toEqual({
      low: false,
      high: true,
    });
    expect(updateArm(UNARMED, pressedHigh - ARM_PX, pressedHigh, BAND).low).toBe(
      true,
    );
  });

  it("returns the same object when nothing changed", () => {
    const armed = { low: true, high: true };
    expect(updateArm(armed, pressedLow, pressedLow, BAND)).toBe(armed);
  });
});

describe("scrollStep", () => {
  it("steps within range", () => {
    expect(scrollStep(100, 25, 0, 500)).toBe(125);
    expect(scrollStep(100, -25, 0, 500)).toBe(75);
  });

  it("clamps at both ends", () => {
    expect(scrollStep(490, 25, 0, 500)).toBe(500);
    expect(scrollStep(10, -25, 0, 500)).toBe(0);
  });

  it("declines at an end by returning the value it was given", () => {
    expect(scrollStep(500, 25, 0, 500)).toBe(500);
    expect(scrollStep(0, -25, 0, 500)).toBe(0);
    expect(scrollStep(250, 0, 0, 500)).toBe(250);
  });

  it("never pulls back a scroll the wheel left past the end", () => {
    expect(scrollStep(800, 25, 0, 500)).toBe(800);
    expect(scrollStep(800, -25, 0, 500)).toBe(775);
  });

  it("leaves the right-hand end open when given no maximum", () => {
    expect(scrollStep(1e6, 25, 0, Infinity)).toBe(1e6 + 25);
  });
});

describe("maxVerticalScroll", () => {
  it("is zero while every row fits", () => {
    const total = RULER_OFFSET + 3 * TRACK_PITCH;
    expect(maxVerticalScroll(total, 600)).toBe(0);
  });

  it("brings the last row's bottom to one gap above the visible bottom", () => {
    const rows = 20;
    const total = RULER_OFFSET + rows * TRACK_PITCH;
    const visibleBottom = 300;
    const max = maxVerticalScroll(total, visibleBottom);

    const lastBottom =
      RULER_OFFSET + (rows - 1) * TRACK_PITCH + TRACK_HEIGHT - max;
    expect(lastBottom).toBe(visibleBottom - TRACK_GAP);
  });
});

describe("createEdgeScroller", () => {
  const FRAME_MS = 16;

  function harness(initial: { x: number; y: number } = { x: 0, y: 0 }) {
    const frames = new Map<number, () => void>();
    let nextId = 1;
    let clock = 1000;
    let velocity = initial;
    let canMove = true;
    const steps: Array<[number, number]> = [];

    const scroller = createEdgeScroller({
      scheduler: {
        request: (callback) => {
          const id = nextId++;
          frames.set(id, callback);
          return id;
        },
        cancel: (id) => void frames.delete(id),
      },
      now: () => clock,
      velocity: () => velocity,
      scrollBy: (dx, dy) => {
        if (!canMove) return false;
        steps.push([dx, dy]);
        return true;
      },
    });

    return {
      scroller,
      steps,
      pending: () => frames.size,
      setVelocity: (v: { x: number; y: number }) => (velocity = v),
      blockAt: () => (canMove = false),
      tick(count = 1, ms = FRAME_MS) {
        for (let i = 0; i < count; i++) {
          clock += ms;
          const due = [...frames.values()];
          frames.clear();
          for (const callback of due) callback();
        }
      },
    };
  }

  it("does not start while the pointer is outside every zone", () => {
    const h = harness();
    h.scroller.update();
    expect(h.scroller.running).toBe(false);
    expect(h.pending()).toBe(0);
  });

  it("keeps scrolling while the pointer is still, scaled by elapsed time", () => {
    const h = harness({ x: 0, y: -1000 });
    h.scroller.update();
    h.tick(3);
    expect(h.steps).toEqual([
      [0, -16],
      [0, -16],
      [0, -16],
    ]);
    expect(h.scroller.running).toBe(true);
  });

  it("requests one frame however many moves arrive", () => {
    const h = harness({ x: 500, y: 0 });
    h.scroller.update();
    h.scroller.update();
    h.scroller.update();
    expect(h.pending()).toBe(1);
  });

  it("caps a late frame's step", () => {
    const h = harness({ x: 0, y: 1000 });
    h.scroller.update();
    h.tick(1, 400);
    expect(h.steps).toEqual([[0, MAX_STEP_MS]]);
  });

  it("stops once the pointer leaves the zones", () => {
    const h = harness({ x: 0, y: 1000 });
    h.scroller.update();
    h.tick(2);
    h.setVelocity({ x: 0, y: 0 });
    h.tick(1);
    expect(h.scroller.running).toBe(false);
    expect(h.steps).toHaveLength(2);
  });

  it("stops at an end, and starts again on the next move if it can", () => {
    const h = harness({ x: 0, y: 1000 });
    h.scroller.update();
    h.blockAt();
    h.tick(1);
    expect(h.scroller.running).toBe(false);

    h.scroller.update();
    expect(h.scroller.running).toBe(true);
  });

  it("cancels the pending frame on stop", () => {
    const h = harness({ x: 0, y: 1000 });
    h.scroller.update();
    h.scroller.stop();
    expect(h.pending()).toBe(0);
    h.tick(3);
    expect(h.steps).toEqual([]);
  });

  it("does not take a frame with no elapsed time for the end", () => {
    const h = harness({ x: 0, y: 1000 });
    h.scroller.update();
    h.tick(1, 0);
    expect(h.scroller.running).toBe(true);
    expect(h.steps).toEqual([]);
  });
});
