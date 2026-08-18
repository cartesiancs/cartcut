import { describe, it, expect } from "vitest";
import {
  MIN_CLIP_PX,
  TRACK_GAP,
  TRACK_HEIGHT,
  TRACK_PITCH,
  RULER_OFFSET,
  TRIM_HANDLE_PX,
  hitTest,
  layoutTimeline,
  rowTop,
  timeAtX,
  trackAtY,
  trimHandleWidth,
  xAtTime,
  type LayoutInput,
} from "./layout";
import {
  SCHEMA_VERSION,
  createTrack,
  emptyDocument,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { imageElement, videoElement } from "../renderer/testing";

const RANGE = 0.9; // 45px per second

function doc(
  tracks: Array<[string, "video" | "audio" | "text"]>,
  elements: Record<string, any> = {},
): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: tracks.map(([id, kind], index) => createTrack(id, kind, index)),
    elements,
  });
}

function layout(d: TimelineDocument, over: Partial<LayoutInput> = {}) {
  return layoutTimeline({
    doc: d,
    range: RANGE,
    hScroll: 0,
    vScroll: 0,
    viewportW: 1000,
    viewportH: 500,
    // Most cases are about row stacking, so they measure from zero; the
    // ruler offset gets its own block below.
    topOffset: 0,
    ...over,
  });
}

describe("xAtTime / timeAtX", () => {
  it("round-trips a position through the scale", () => {
    expect(timeAtX(xAtTime(5000, RANGE, 0), RANGE, 0)).toBeCloseTo(5000);
    expect(timeAtX(xAtTime(5000, RANGE, 300), RANGE, 300)).toBeCloseTo(5000);
  });

  it("shifts by the scroll", () => {
    expect(xAtTime(1000, RANGE, 0)).toBeCloseTo(45);
    expect(xAtTime(1000, RANGE, 20)).toBeCloseTo(25);
  });

  it("goes negative for a clip scrolled off the left edge", () => {
    // The clamped conversion in utils/time would pin this to 0 and draw the
    // clip at the wrong width.
    expect(xAtTime(0, RANGE, 200)).toBeCloseTo(-200);
  });
});

describe("rowTop", () => {
  it("stacks rows at a constant pitch", () => {
    expect(rowTop(0, 0, 0)).toBe(0);
    expect(rowTop(1, 0, 0)).toBe(TRACK_PITCH);
    expect(rowTop(2, 0, 0)).toBe(TRACK_PITCH * 2);
  });

  it("clears the ruler by default", () => {
    // The ruler is absolutely positioned over the top of the canvas, so a row
    // at y=0 is half-hidden behind the timecode.
    expect(rowTop(0, 0)).toBe(RULER_OFFSET);
    expect(RULER_OFFSET).toBeGreaterThan(0);
  });

  it("leaves a gap between rows", () => {
    expect(TRACK_PITCH).toBe(TRACK_HEIGHT + TRACK_GAP);
  });

  it("subtracts the vertical scroll", () => {
    expect(rowTop(2, 30, 0)).toBe(TRACK_PITCH * 2 - 30);
  });
});

describe("the ruler offset", () => {
  const d = doc([["v1", "video"]], {
    a: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }),
  });

  it("pushes the first row clear of the ruler", () => {
    const result = layoutTimeline({
      doc: d,
      range: RANGE,
      hScroll: 0,
      vScroll: 0,
      viewportW: 1000,
      viewportH: 500,
    });
    expect(result.rows[0].top).toBe(RULER_OFFSET);
    expect(result.clips[0].y).toBe(RULER_OFFSET);
  });

  it("counts toward the total height, so scrolling can reach the last row", () => {
    const result = layoutTimeline({
      doc: d,
      range: RANGE,
      hScroll: 0,
      vScroll: 0,
      viewportW: 1000,
      viewportH: 500,
    });
    expect(result.totalHeight).toBe(RULER_OFFSET + TRACK_PITCH);
  });

  it("moves rows and clips together", () => {
    const result = layoutTimeline({
      doc: d,
      range: RANGE,
      hScroll: 0,
      vScroll: 0,
      viewportW: 1000,
      viewportH: 500,
      topOffset: 100,
    });
    expect(result.rows[0].top).toBe(100);
    expect(result.clips[0].y).toBe(100);
  });
});

describe("layoutTimeline", () => {
  it("gives an empty document no rows and no clips", () => {
    const result = layout(emptyDocument());
    expect(result.rows).toEqual([]);
    expect(result.clips).toEqual([]);
    expect(result.totalHeight).toBe(0);
  });

  it("orders rows top-down by track index", () => {
    const result = layout(doc([["a", "video"], ["b", "audio"]]));
    expect(result.rows.map((r) => r.trackId)).toEqual(["a", "b"]);
    expect(result.rows.map((r) => r.top)).toEqual([0, TRACK_PITCH]);
  });

  it("puts two clips on one track at the same y", () => {
    // The headline change: a row is a track, not an element.
    const result = layout(
      doc([["v1", "video"]], {
        a: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }),
        b: imageElement({ trackId: "v1", startTime: 2000, duration: 1000 }),
      }),
    );

    expect(result.clips).toHaveLength(2);
    expect(result.clips[0].y).toBe(result.clips[1].y);
    expect(result.clips[0].x).not.toBe(result.clips[1].x);
  });

  it("places adjacent clips flush, with no seam and no overlap", () => {
    // What a split produces. The two halves must tile exactly.
    const result = layout(
      doc([["v1", "video"]], {
        left: imageElement({ trackId: "v1", startTime: 0, duration: 2000 }),
        right: imageElement({ trackId: "v1", startTime: 2000, duration: 2000 }),
      }),
    );
    const [a, b] = result.clips;
    expect(a.x + a.w).toBeCloseTo(b.x);
  });

  it("measures a clip by its timeline span, dividing out speed", () => {
    // findTarget used raw `duration` here while drawCanvas divided by speed,
    // which is why a sped-up clip's right edge could not be grabbed.
    const result = layout(
      doc([["v1", "video"]], {
        fast: videoElement({
          trackId: "v1",
          startTime: 0,
          duration: 4000,
          speed: 2,
          trim: { startTime: 0, endTime: 4000 },
          sourceDuration: 4000,
        }),
      }),
    );
    // 4000ms of source at 2x is 2000ms of timeline = 90px.
    expect(result.clips[0].w).toBeCloseTo(90);
  });

  it("keeps a clip straddling the left edge at negative x and full width", () => {
    const result = layout(
      doc([["v1", "video"]], {
        a: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }),
      }),
      { hScroll: 45 },
    );
    expect(result.clips[0].x).toBeCloseTo(-45);
    expect(result.clips[0].w).toBeCloseTo(180);
  });

  it("culls clips outside the viewport horizontally", () => {
    const result = layout(
      doc([["v1", "video"]], {
        near: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }),
        far: imageElement({ trackId: "v1", startTime: 600_000, duration: 1000 }),
      }),
      { viewportW: 500 },
    );
    expect(result.clips.map((c) => c.elementId)).toEqual(["near"]);
  });

  it("culls rows scrolled out of view", () => {
    const tracks = Array.from({ length: 20 }, (_, i) => [`t${i}`, "video"] as const);
    const elements: Record<string, any> = {};
    for (let i = 0; i < 20; i++) {
      elements[`e${i}`] = imageElement({ trackId: `t${i}`, duration: 1000 });
    }
    const result = layout(doc([...tracks] as any, elements), {
      viewportH: 100,
    });
    // Only the first few rows fit in 100px of viewport.
    expect(result.clips.length).toBeLessThan(20);
    expect(result.clips.length).toBeGreaterThan(0);
  });

  it("shifts every row by the same vertical scroll", () => {
    const d = doc([["a", "video"], ["b", "video"], ["c", "video"]]);
    const unscrolled = layout(d);
    const scrolled = layout(d, { vScroll: 25 });
    for (let i = 0; i < unscrolled.rows.length; i++) {
      expect(scrolled.rows[i].top).toBe(unscrolled.rows[i].top - 25);
    }
  });

  it("never draws a clip narrower than the minimum", () => {
    const result = layout(
      doc([["v1", "video"]], {
        blink: imageElement({ trackId: "v1", startTime: 0, duration: 1 }),
      }),
    );
    expect(result.clips[0].w).toBe(MIN_CLIP_PX);
  });

  it("reports a total height independent of scroll", () => {
    const d = doc([["a", "video"], ["b", "video"]]);
    expect(layout(d).totalHeight).toBe(TRACK_PITCH * 2);
    expect(layout(d, { vScroll: 500 }).totalHeight).toBe(TRACK_PITCH * 2);
  });

  it("leaves a clip whose track vanished out of the layout", () => {
    const result = layout(
      doc([["v1", "video"]], {
        orphan: imageElement({ trackId: "gone", duration: 1000 }),
      }),
    );
    expect(result.clips).toEqual([]);
  });
});

describe("trimHandleWidth", () => {
  it("is the full handle on a comfortable clip", () => {
    expect(trimHandleWidth(200)).toBe(TRIM_HANDLE_PX);
  });

  it("shrinks on a narrow clip so the body stays grabbable", () => {
    expect(trimHandleWidth(12)).toBe(4);
  });

  it("never lets the two handles cover the whole clip", () => {
    for (const w of [1, 4, 9, 12, 24, 100]) {
      expect(trimHandleWidth(w) * 2).toBeLessThanOrEqual((w * 2) / 3);
    }
  });
});

describe("hitTest", () => {
  const d = doc([["v1", "video"], ["v2", "video"]], {
    a: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }),
    b: imageElement({ trackId: "v1", startTime: 6000, duration: 4000 }),
  });

  it("finds the clip under the pointer", () => {
    const hit = hitTest(layout(d), 90, 10);
    expect(hit).toMatchObject({ kind: "clip", elementId: "a", zone: "body" });
  });

  it("distinguishes the two clips on one track", () => {
    const l = layout(d);
    expect(hitTest(l, 90, 10)).toMatchObject({ elementId: "a" });
    expect(hitTest(l, 360, 10)).toMatchObject({ elementId: "b" });
  });

  it("claims the leading edge for the start handle", () => {
    const l = layout(d);
    expect(hitTest(l, 1, 10)).toMatchObject({ zone: "trimStart" });
    expect(hitTest(l, 9, 10)).toMatchObject({ zone: "body" });
  });

  it("claims the trailing edge for the end handle", () => {
    const l = layout(d);
    // Clip "a" spans 0..180px.
    expect(hitTest(l, 179, 10)).toMatchObject({ zone: "trimEnd" });
    expect(hitTest(l, 170, 10)).toMatchObject({ zone: "body" });
  });

  it("reports the empty part of a track, not nothing", () => {
    // Needed so a click on bare track can still target that row.
    expect(hitTest(layout(d), 250, 10)).toEqual({
      kind: "track",
      trackId: "v1",
    });
  });

  it("reports the row below correctly", () => {
    expect(hitTest(layout(d), 10, TRACK_PITCH + 5)).toEqual({
      kind: "track",
      trackId: "v2",
    });
  });

  it("finds nothing in the gap between rows", () => {
    expect(hitTest(layout(d), 10, TRACK_HEIGHT + 1)).toEqual({ kind: "none" });
  });

  it("finds nothing below the last row", () => {
    expect(hitTest(layout(d), 10, 400)).toEqual({ kind: "none" });
  });

  it("excludes the clip's right edge, so touching clips do not both claim it", () => {
    const tight = doc([["v1", "video"]], {
      left: imageElement({ trackId: "v1", startTime: 0, duration: 2000 }),
      right: imageElement({ trackId: "v1", startTime: 2000, duration: 2000 }),
    });
    const l = layout(tight);
    // 90px is exactly the boundary; it belongs to "right".
    expect(hitTest(l, 90, 10)).toMatchObject({ elementId: "right" });
  });

  it("agrees with the rectangles it was built from", () => {
    // Drawing and hit-testing reading the same layout is the whole point.
    const l = layout(d);
    for (const clip of l.clips) {
      const hit = hitTest(l, clip.x + clip.w / 2, clip.y + clip.h / 2);
      expect(hit).toMatchObject({ kind: "clip", elementId: clip.elementId });
    }
  });
});

describe("trackAtY", () => {
  it("maps a y to its row", () => {
    const l = layout(doc([["a", "video"], ["b", "audio"]]));
    expect(trackAtY(l, 0)).toBe("a");
    expect(trackAtY(l, TRACK_HEIGHT - 1)).toBe("a");
    expect(trackAtY(l, TRACK_PITCH)).toBe("b");
  });

  it("returns null in a gap and outside the rows", () => {
    const l = layout(doc([["a", "video"]]));
    expect(trackAtY(l, TRACK_HEIGHT + 1)).toBeNull();
    expect(trackAtY(l, -5)).toBeNull();
  });
});
