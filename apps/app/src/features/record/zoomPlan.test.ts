import { describe, expect, it } from "vitest";

import {
  depthFor,
  findAnchors,
  findDwells,
  planZoom,
  sampleZoom,
  smoothstep,
  zoomRangeFor,
  type CursorSample,
  type PointerMark,
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

/** The input shape `planZoom` takes, from a cursor track alone. */
function cursorOnly(cursor: CursorSample[]) {
  return { cursor, pointer: [] as PointerMark[] };
}

/** A click at a point. */
function click(t: number, x: number, y: number): PointerMark {
  return { t, x, y, kind: "down" };
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

  // Zero velocity at both ends is the whole reason for it: a linear ramp makes
  // the zoom snap into and out of motion.
  it("barely moves at the very start", () => {
    expect(smoothstep(0.02)).toBeLessThan(0.01);
  });
});

// `clampCenter` and `visibleRectFor` moved to `recordFit.ts#clampAim` and
// `#recordBox`, which know the project frame's aspect. The covering property they
// existed to guarantee is asserted there, at three source aspects rather than one.

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
    expect(planZoom(cursorOnly(samples), FRAME, "off", 4000)).toEqual([]);
  });

  it("plans nothing from an empty track", () => {
    expect(planZoom(cursorOnly([]), FRAME, "on", 4000)).toEqual([]);
  });

  // The reason the recorder composes after the take rather than during it: the
  // zoom has to be moving before the cursor arrives.
  it("starts the zoom before the cursor settles", () => {
    const [segment] = planZoom(
      cursorOnly(still(200, 200, 2000, 3000)),
      FRAME,
      "on",
      9000,
    );

    expect(segment.inStart).toBe(1500);
    expect(segment.inStart).toBeLessThan(2000);
  });

  it("clamps the lookahead at the start of the recording", () => {
    const [segment] = planZoom(cursorOnly(samples), FRAME, "on", 6000);
    expect(segment.inStart).toBe(0);
  });

  it("keeps the four instants in order and inside the recording", () => {
    for (const segment of planZoom(cursorOnly(samples), FRAME, "on", 6000)) {
      expect(segment.inStart).toBeLessThanOrEqual(segment.inEnd);
      expect(segment.inEnd).toBeLessThanOrEqual(segment.outStart);
      expect(segment.outStart).toBeLessThanOrEqual(segment.outEnd);
      expect(segment.outEnd).toBeLessThanOrEqual(6000);
    }
  });

  it("has exactly two modes, and off plans nothing", () => {
    // The depth of a move is decided by how localized the thing that earned it
    // was, so a global strength would be a second control over the same number.
    expect(zoomRangeFor("off")).toEqual({ min: 1, max: 1 });
    expect(zoomRangeFor("on").max).toBeGreaterThan(1);
  });

  it("never plans a zoom that fails to cover the frame", () => {
    // Below 1 the picture does not fill the frame and a pan would slide it around
    // inside its own padding. `recordFit.ts#Z_COVER` is the same statement.
    for (const strength of ["on"] as const) {
      for (const segment of planZoom(cursorOnly(samples), FRAME, strength, 6000)) {
        expect(segment.zoom).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("aims as a fraction of the capture, not in pixels", () => {
    const [segment] = planZoom(
      cursorOnly(still(250, 750, 0, 3000)),
      FRAME,
      "on",
      6000,
    );
    expect(segment.u).toBeCloseTo(0.25, 6);
    expect(segment.v).toBeCloseTo(0.75, 6);
  });

  // A move that zooms in and straight back out reads as a glitch, not emphasis.
  it("drops a dwell too short to hold at full zoom", () => {
    expect(
      planZoom(cursorOnly(still(200, 200, 0, 300)), FRAME, "on", 4000),
    ).toEqual([]);
  });

  it("never overlaps two moves", () => {
    const path = [
      ...still(200, 200, 0, 3000),
      ...sweep({ x: 200, y: 200 }, { x: 800, y: 800 }, 3100, 1800),
      ...still(800, 800, 5000, 3000),
      ...sweep({ x: 800, y: 800 }, { x: 200, y: 700 }, 8100, 1800),
      ...still(200, 700, 10_000, 4000),
    ];

    const segments = planZoom(cursorOnly(path), FRAME, "on", 40_000);
    expect(segments.length).toBeGreaterThan(1);

    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index].inStart).toBeGreaterThanOrEqual(
        segments[index - 1].outEnd,
      );
    }
  });

  it("leaves no gap for the camera to fall back through", () => {
    // Activity 400ms apart is one piece of activity. Whichever of the three
    // answers the packer reaches for, it must not leave a gap so short that the
    // camera releases fully to the resting pose and starts straight back in:
    // `zoomCamera.ts` chains anything closer than a quarter second, and anything
    // it does not chain has to be a real pause.
    const path = [
      ...still(200, 200, 0, 3000),
      ...still(800, 800, 3400, 3000),
    ];

    const segments = planZoom(cursorOnly(path), FRAME, "on", 40_000);
    expect(segments.length).toBeGreaterThan(0);

    for (let index = 1; index < segments.length; index += 1) {
      const gap = segments[index].inStart - segments[index - 1].outEnd;
      expect(gap === 0 || gap > 250).toBe(true);
    }
  });

  it("shortens the move in front rather than merging, when it can", () => {
    // The cheapest of the three answers: a zoom that arrives, sits for half a
    // second and releases is still a move, and keeping it separate keeps its own
    // framing rather than widening to cover both.
    const path = [
      ...still(200, 200, 0, 3000),
      ...still(800, 800, 3400, 3000),
    ];

    const segments = planZoom(cursorOnly(path), FRAME, "on", 40_000);
    expect(segments.length).toBe(2);
    expect(segments[0].outEnd).toBe(segments[1].inStart);
    // Each keeps a framing of its own rather than a union of the two.
    expect(segments[0].u).toBeLessThan(0.4);
    expect(segments[1].u).toBeGreaterThan(0.6);
  });

  // The headline guarantee, and the reason the packing rule exists. Measured
  // against a real 37-second take, the old planner answered eight moves to
  // fourteen presses: six presses did nothing at all.
  it("gives every click a zoom, however they are spaced", () => {
    for (const spacing of [300, 700, 1500, 2600, 4000]) {
      const pointer: PointerMark[] = [];
      for (let index = 0; index < 12; index += 1) {
        pointer.push(
          click(1000 + index * spacing, 120 + (index % 6) * 140, 150 + (index % 4) * 200),
        );
      }
      const duration = 1000 + 12 * spacing + 6000;
      const segments = planZoom({ cursor: [], pointer }, FRAME, "on", duration);

      for (const mark of pointer) {
        const covered = segments.some(
          (segment) => mark.t >= segment.inStart && mark.t <= segment.outEnd,
        );
        expect(
          covered,
          `click at ${mark.t}ms (spacing ${spacing}) landed in no zoom`,
        ).toBe(true);
      }
    }
  });

  // Found by recording for real: a click at 14.4s of an 18.5s take got no zoom,
  // because it clustered with a dwell that ran to the last frame, and that
  // cluster wanted to hold past the end of the take and was dropped for being
  // unfinishable.
  it("keeps a click inside activity that runs to the last frame", () => {
    const duration = 18_500;
    const cursor = still(700, 700, 14_343, duration - 14_343);
    const pointer = [click(14_361, 700, 700)];

    const segments = planZoom({ cursor, pointer }, FRAME, "on", duration);
    const covered = segments.some(
      (segment) => 14_361 >= segment.inStart && 14_361 <= segment.outEnd,
    );

    expect(covered).toBe(true);
    // ...and it still releases before the end, rather than holding off it.
    for (const segment of segments) {
      expect(segment.outEnd).toBeLessThanOrEqual(duration - 400);
    }
  });

  it("keeps a click even when the take is already fully spoken for", () => {
    // The budget only ever spends dwells. A press is the user saying "this", and
    // a plan that answers nothing to it is the plan being wrong.
    const cursor: CursorSample[] = [];
    for (let index = 0; index < 10; index += 1) {
      cursor.push(...still(150 + (index % 5) * 170, 300, index * 5000, 2500));
    }
    const pointer = [click(51_000, 900, 900)];
    const duration = 60_000;

    const segments = planZoom({ cursor, pointer }, FRAME, "on", duration);
    const covered = segments.some(
      (segment) => 51_000 >= segment.inStart && 51_000 <= segment.outEnd,
    );
    expect(covered).toBe(true);
  });

  // The single biggest gap this closes. A decisive click is the clearest
  // statement of interest there is, and on its own it moves the cursor for far
  // less than MIN_DWELL_MS.
  it("zooms on a click the cursor never dwelled for", () => {
    const brush = sweep({ x: 100, y: 100 }, { x: 900, y: 900 }, 0, 4000);
    const withoutClick = planZoom(cursorOnly(brush), FRAME, "on", 8000);
    const withClick = planZoom(
      { cursor: brush, pointer: [click(2000, 500, 500)] },
      FRAME,
      "on",
      8000,
    );

    expect(withoutClick).toEqual([]);
    expect(withClick.length).toBe(1);
    expect(withClick[0].u).toBeCloseTo(0.5, 6);
  });

  it("holds one zoom across a burst of clicks in one place", () => {
    const pointer = [
      click(1000, 500, 500),
      click(1400, 520, 505),
      click(1900, 510, 495),
    ];
    const segments = planZoom({ cursor: [], pointer }, FRAME, "on", 8000);

    expect(segments.length).toBe(1);
    expect(segments[0].outStart).toBeGreaterThan(1900);
  });

  it("leaves most of the take unzoomed", () => {
    // Ten looks back to back would zoom the whole thing, which is a static crop
    // with extra steps and leaves the viewer with no idea where anything is.
    const LOOKS = 12;
    const cursor: CursorSample[] = [];
    for (let index = 0; index < LOOKS; index += 1) {
      cursor.push(...still(150 + (index % 5) * 170, 300, index * 5000, 2500));
    }
    const duration = 60_000;

    const all = planZoom({ cursor, pointer: [] }, FRAME, "on", duration);
    const zoomed = all.reduce(
      (sum, segment) => sum + (segment.outEnd - segment.inStart),
      0,
    );

    expect(all.length).toBeGreaterThan(1);
    expect(all.length).toBeLessThan(LOOKS);
    expect(zoomed).toBeLessThanOrEqual(duration * 0.7);
  });

  it("keeps one look even when it alone exceeds the budget", () => {
    // A short recording of somebody doing exactly one thing is the case this
    // feature is most obviously for, and the cap must not answer it with nothing.
    const segments = planZoom(
      cursorOnly(still(200, 200, 0, 4000)),
      FRAME,
      "on",
      6000,
    );
    expect(segments.length).toBe(1);
  });

  // The clip has to finish on the whole screen: a fragment of a screen with no
  // idea where it was is a bad last frame, and a bad frame to cut against.
  it("releases before the end of the clip", () => {
    const segments = planZoom(
      cursorOnly(still(200, 200, 0, 5000)),
      FRAME,
      "on",
      5200,
    );

    for (const segment of segments) {
      expect(segment.outEnd).toBeLessThanOrEqual(5200 - 400);
    }
  });

  it("drops a move with no room to finish rather than cutting it off", () => {
    expect(
      planZoom(cursorOnly(still(200, 200, 4600, 1000)), FRAME, "on", 5000),
    ).toEqual([]);
  });
});

describe("findAnchors", () => {
  it("makes one anchor of a drag, covering its whole path", () => {
    const pointer: PointerMark[] = [
      { t: 1000, x: 100, y: 100, kind: "down" },
      { t: 1100, x: 300, y: 200, kind: "drag" },
      { t: 1200, x: 500, y: 400, kind: "drag" },
      { t: 1300, x: 700, y: 600, kind: "up" },
    ];

    const anchors = findAnchors([], pointer, FRAME);
    const dragAnchor = anchors.find((anchor) => anchor.end > anchor.start);

    expect(dragAnchor).toBeDefined();
    expect(dragAnchor!.minX).toBe(300);
    expect(dragAnchor!.maxX).toBe(700);
    expect(dragAnchor!.end).toBe(1300);
  });

  it("closes a drag whose release was lost", () => {
    // A monitor started mid-gesture, or a window that swallowed the mouse-up.
    // Without this the drag would swallow everything after it to the end of the
    // take and the whole recording would be one anchor.
    const pointer: PointerMark[] = [
      { t: 1000, x: 100, y: 100, kind: "drag" },
      { t: 1100, x: 200, y: 200, kind: "drag" },
      { t: 9000, x: 800, y: 800, kind: "down" },
    ];

    const anchors = findAnchors([], pointer, FRAME);
    expect(anchors.length).toBe(2);
    expect(anchors[0].end).toBe(1100);
  });

  it("weights a click above a dwell", () => {
    const [dwell] = findAnchors(still(200, 200, 0, 2000), [], FRAME);
    const [clicked] = findAnchors([], [click(1000, 200, 200)], FRAME);
    expect(clicked.weight).toBeGreaterThan(dwell.weight);
  });

  it("drops an unreadable mark rather than carrying a NaN into a centroid", () => {
    const pointer = [
      click(1000, 200, 200),
      { t: NaN, x: 1, y: 1, kind: "down" } as PointerMark,
      { t: 2000, x: NaN, y: 1, kind: "down" } as PointerMark,
    ];
    const anchors = findAnchors([], pointer, FRAME);
    expect(anchors.length).toBe(1);
    expect(Number.isFinite(anchors[0].minX)).toBe(true);
  });
});

describe("depthFor", () => {
  const point = { start: 0, end: 0, minX: 500, maxX: 500, minY: 500, maxY: 500, weight: 3 };

  it("gives a point the deepest zoom the strength allows", () => {
    expect(depthFor(point, FRAME, "on")).toBeCloseTo(
      zoomRangeFor("on").max,
      9,
    );
    expect(depthFor(point, FRAME, "on")).toBeCloseTo(
      zoomRangeFor("on").max,
      9,
    );
  });

  it("gives a spread-out cluster a shallower zoom than a tight one", () => {
    const spread = { ...point, minX: 100, maxX: 900, minY: 100, maxY: 900 };
    expect(depthFor(spread, FRAME, "on")).toBeLessThan(
      depthFor(point, FRAME, "on"),
    );
  });

  it("never leaves the strength's range", () => {
    for (const strength of ["on"] as const) {
      const { min, max } = zoomRangeFor(strength);
      for (const size of [0, 10, 100, 400, 900, 5000]) {
        const anchor = {
          ...point,
          minX: 500 - size / 2,
          maxX: 500 + size / 2,
          minY: 500 - size / 2,
          maxY: 500 + size / 2,
        };
        const depth = depthFor(anchor, FRAME, strength);
        expect(depth).toBeGreaterThanOrEqual(min);
        expect(depth).toBeLessThanOrEqual(max);
      }
    }
  });

  it("answers 1 when the zoom is off", () => {
    expect(depthFor(point, FRAME, "off")).toBe(1);
  });
});

describe("sampleZoom", () => {
  const segments = planZoom(
    cursorOnly(still(200, 200, 2000, 4000)),
    FRAME,
    "on",
    12_000,
  );

  it("is at rest outside every move", () => {
    const before = sampleZoom(segments, 0);
    const after = sampleZoom(segments, 11_000);
    expect(before.progress).toBe(0);
    expect(after.progress).toBe(0);
    expect(before.u).toBe(0.5);
    expect(before.v).toBe(0.5);
  });

  it("is at rest when there is no plan at all", () => {
    // An empty plan and a disabled auto-zoom have to be the same code path, or
    // "off" becomes a second set of rules to keep in agreement with the first.
    expect(sampleZoom([], 1234)).toEqual({
      progress: 0,
      zoom: 1,
      u: 0.5,
      v: 0.5,
    });
  });

  it("holds at full progress between the two eases", () => {
    const [segment] = segments;
    const middle = (segment.inEnd + segment.outStart) / 2;
    expect(sampleZoom(segments, middle).progress).toBe(1);
    expect(sampleZoom(segments, segment.inEnd).progress).toBe(1);
  });

  it("rises through the ease in and falls through the ease out", () => {
    const [segment] = segments;
    const rising = [0.2, 0.5, 0.8].map(
      (f) =>
        sampleZoom(segments, segment.inStart + (segment.inEnd - segment.inStart) * f)
          .progress,
    );
    expect(rising[0]).toBeLessThan(rising[1]);
    expect(rising[1]).toBeLessThan(rising[2]);

    const falling = [0.2, 0.5, 0.8].map(
      (f) =>
        sampleZoom(
          segments,
          segment.outStart + (segment.outEnd - segment.outStart) * f,
        ).progress,
    );
    expect(falling[0]).toBeGreaterThan(falling[1]);
    expect(falling[1]).toBeGreaterThan(falling[2]);
  });

  it("keeps progress inside the unit interval everywhere", () => {
    const [segment] = segments;
    for (let t = segment.inStart; t <= segment.outEnd; t += 10) {
      const view = sampleZoom(segments, t);
      expect(view.progress).toBeGreaterThanOrEqual(0);
      expect(view.progress).toBeLessThanOrEqual(1);
    }
  });

  it("reports the segment's own aim throughout it, unblended", () => {
    // The blend is the caller's, because the resting pose is `recordFit`'s answer
    // and this module does not know it.
    const [segment] = segments;
    for (const t of [segment.inStart + 1, segment.inEnd, segment.outEnd - 1]) {
      const view = sampleZoom(segments, t);
      expect(view.u).toBe(segment.u);
      expect(view.zoom).toBe(segment.zoom);
    }
  });

  it("answers the resting view for an unreadable instant", () => {
    expect(sampleZoom(segments, NaN).progress).toBe(0);
  });
});
