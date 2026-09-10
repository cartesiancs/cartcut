import { describe, it, expect } from "vitest";
import {
  collectSnapPoints,
  snapEdge,
  snapSpan,
  type SnapPoint,
} from "./snapping";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { imageElement } from "../renderer/testing";
import { pxToMsSigned } from "./geometry";

const RANGE = 0.9; // 45px/s, so 1px ≈ 22.2ms

function doc(elements: Record<string, any>): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0), createTrack("v2", "video", 1)],
    elements,
  });
}

describe("collectSnapPoints", () => {
  it("always offers the start of the timeline", () => {
    expect(collectSnapPoints(doc({}))).toEqual([{ ms: 0, kind: "origin" }]);
  });

  it("offers both edges of every clip", () => {
    const points = collectSnapPoints(
      doc({ a: imageElement({ trackId: "v1", startTime: 1000, duration: 2000 }) }),
    );
    expect(points).toContainEqual({
      ms: 1000,
      kind: "clipStart",
      trackId: "v1",
    });
    expect(points).toContainEqual({
      ms: 3000,
      kind: "clipEnd",
      trackId: "v1",
    });
  });

  it("offers the playhead when there is one", () => {
    const points = collectSnapPoints(doc({}), { playheadMs: 4200 });
    expect(points).toContainEqual({ ms: 4200, kind: "playhead" });
  });

  it("excludes the clips being dragged", () => {
    // Otherwise a clip snaps to its own current position and cannot be moved.
    const points = collectSnapPoints(
      doc({ a: imageElement({ trackId: "v1", startTime: 1000, duration: 2000 }) }),
      { excludeIds: ["a"] },
    );
    expect(points.every((p) => p.kind === "origin")).toBe(true);
  });
});

describe("snapEdge", () => {
  const points: SnapPoint[] = [
    { ms: 1000, kind: "clipEnd", trackId: "v1" },
    { ms: 5000, kind: "clipStart", trackId: "v2" },
  ];

  it("leaves an edge alone when nothing is near", () => {
    expect(snapEdge(3000, points, RANGE, 10)).toEqual({ ms: 3000, hit: null });
  });

  it("pulls the edge onto a nearby point", () => {
    // 1px is ~22ms at this range, so 100ms is well inside a 10px window.
    expect(snapEdge(1100, points, RANGE, 10)).toEqual({
      ms: 1000,
      hit: points[0],
    });
  });

  it("moves only the edge it is given", () => {
    // The distinction from `snapSpan`, which would return a start for a span of
    // a fixed length. Here the answer is the edge itself, whichever end it is.
    expect(snapEdge(4900, points, RANGE, 10).ms).toBe(5000);
  });

  it("chooses the nearest candidate, not the last one tested", () => {
    const near: SnapPoint[] = [
      { ms: 3000, kind: "clipEnd", trackId: "v1" },
      { ms: 3100, kind: "clipStart", trackId: "v1" },
    ];
    expect(snapEdge(3010, near, RANGE, 10).hit).toBe(near[0]);
    expect(snapEdge(3090, near, RANGE, 10).hit).toBe(near[1]);
  });

  it("measures tolerance in pixels, so the window narrows as you zoom in", () => {
    // 300ms is 13.5px at this range and 60px at range 4.
    expect(snapEdge(1300, points, RANGE, 20).hit).toBe(points[0]);
    expect(snapEdge(1300, points, 4, 20).hit).toBe(null);
  });

  it("prefers a point on the track being trimmed", () => {
    const tied: SnapPoint[] = [
      { ms: 2900, kind: "clipEnd", trackId: "v1" },
      { ms: 3100, kind: "clipStart", trackId: "v2" },
    ];
    expect(snapEdge(3000, tied, RANGE, 20, "v2").hit).toBe(tied[1]);
    expect(snapEdge(3000, tied, RANGE, 20, "v1").hit).toBe(tied[0]);
  });

  it("still takes a genuinely closer point from another track", () => {
    const uneven: SnapPoint[] = [
      { ms: 2950, kind: "clipEnd", trackId: "v2" },
      { ms: 3200, kind: "clipStart", trackId: "v1" },
    ];
    expect(snapEdge(3000, uneven, RANGE, 20, "v1").hit).toBe(uneven[0]);
  });

  it("has no effect with a zero tolerance", () => {
    expect(snapEdge(1000.5, points, RANGE, 0)).toEqual({
      ms: 1000.5,
      hit: null,
    });
  });

  it("never moves the edge further than the tolerance allows", () => {
    for (const edgeMs of [0, 900, 1500, 4800, 9000]) {
      const result = snapEdge(edgeMs, points, RANGE, 10);
      expect(Math.abs(result.ms - edgeMs)).toBeLessThanOrEqual(
        pxToMsSigned(10, RANGE) + 1e-9,
      );
    }
  });
});

describe("snapSpan", () => {
  const points: SnapPoint[] = [
    { ms: 1000, kind: "clipEnd", trackId: "v1" },
    { ms: 5000, kind: "clipStart", trackId: "v2" },
  ];

  it("leaves a span alone when nothing is near", () => {
    const result = snapSpan(3000, 500, points, RANGE, 10);
    expect(result).toEqual({ startMs: 3000, hit: null, edge: null });
  });

  it("pulls the leading edge onto a nearby point", () => {
    const result = snapSpan(1100, 500, points, RANGE, 10);
    expect(result.startMs).toBe(1000);
    expect(result.edge).toBe("start");
    expect(result.hit?.ms).toBe(1000);
  });

  it("pulls the trailing edge onto a nearby point", () => {
    // Span 4900..5100; its end is 100ms from the point at 5000.
    const result = snapSpan(4800, 200, points, RANGE, 10);
    expect(result.startMs).toBe(4800);
    expect(result.edge).toBe("end");
  });

  it("chooses the nearest candidate, not the last one tested", () => {
    // The original ran four checks in sequence and let the last match win, so
    // a clip near two points jumped to whichever was tested last.
    const twoPoints: SnapPoint[] = [
      { ms: 1000, kind: "clipEnd" },
      { ms: 1150, kind: "clipStart" },
    ];
    const result = snapSpan(1120, 500, twoPoints, RANGE, 20);
    expect(result.startMs).toBe(1150);
  });

  it("measures tolerance in pixels, so the window narrows as you zoom in", () => {
    const far: SnapPoint[] = [{ ms: 1300, kind: "clipStart" }];

    // 300ms away. At range 0.9 that is ~13.5px — inside a 20px window.
    expect(snapSpan(1000, 500, far, 0.9, 20).hit).not.toBeNull();
    // At range 4 the same 300ms is 60px away, well outside it.
    expect(snapSpan(1000, 500, far, 4, 20).hit).toBeNull();
  });

  it("prefers a point on the track being dropped onto", () => {
    const tied: SnapPoint[] = [
      { ms: 2000, kind: "clipEnd", trackId: "other" },
      { ms: 2000, kind: "clipStart", trackId: "target" },
    ];
    const result = snapSpan(2050, 500, tied, RANGE, 10, "target");
    expect(result.hit?.trackId).toBe("target");
  });

  it("still takes a genuinely closer point from another track", () => {
    const points2: SnapPoint[] = [
      { ms: 2000, kind: "clipStart", trackId: "target" },
      { ms: 2045, kind: "clipEnd", trackId: "other" },
    ];
    const result = snapSpan(2050, 500, points2, RANGE, 10, "target");
    expect(result.hit?.trackId).toBe("other");
  });

  it("snaps flush against a neighbour, leaving no seam", () => {
    // Dropping a clip just past the end of another should butt them together.
    const neighbour: SnapPoint[] = [{ ms: 4000, kind: "clipEnd" }];
    const result = snapSpan(4030, 2000, neighbour, RANGE, 10);
    expect(result.startMs).toBe(4000);
  });

  it("has no effect with a zero tolerance", () => {
    expect(snapSpan(1001, 500, points, RANGE, 0).hit).toBeNull();
  });

  it("never moves the span further than the tolerance allows", () => {
    const toleranceMs = pxToMsSigned(10, RANGE);
    for (const start of [900, 1050, 4800, 5200]) {
      const result = snapSpan(start, 500, points, RANGE, 10);
      expect(Math.abs(result.startMs - start)).toBeLessThanOrEqual(
        toleranceMs + 1,
      );
    }
  });
});
