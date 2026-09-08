import { describe, it, expect } from "vitest";
import {
  MIN_CLIP_PX,
  TRACK_GAP,
  TRACK_HEIGHT,
  TRACK_PITCH,
  RULER_OFFSET,
  TRIM_HANDLE_PX,
  clipsInRect,
  hitTest,
  layoutTimeline,
  rectBetween,
  rowTop,
  timeAtX,
  trackAtY,
  trimHandleWidth,
  xAtTime,
  type LayoutInput,
} from "./layout";
import { addTransition } from "./transitionOps";
import {
  SCHEMA_VERSION,
  createTrack,
  emptyDocument,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { groupElement, imageElement, videoElement } from "../renderer/testing";

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

describe("rectBetween", () => {
  it("normalises a band dragged down and to the right", () => {
    expect(rectBetween({ x: 10, y: 20 }, { x: 60, y: 90 })).toEqual({
      x: 10,
      y: 20,
      w: 50,
      h: 70,
    });
  });

  it("gives the same band dragged up and to the left", () => {
    expect(rectBetween({ x: 60, y: 90 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      w: 50,
      h: 70,
    });
  });

  it("gives the same band dragged up and to the right, and down and to the left", () => {
    const expected = { x: 10, y: 20, w: 50, h: 70 };
    expect(rectBetween({ x: 10, y: 90 }, { x: 60, y: 20 })).toEqual(expected);
    expect(rectBetween({ x: 60, y: 20 }, { x: 10, y: 90 })).toEqual(expected);
  });

  it("reports no area for a press that never moved", () => {
    expect(rectBetween({ x: 40, y: 40 }, { x: 40, y: 40 })).toEqual({
      x: 40,
      y: 40,
      w: 0,
      h: 0,
    });
  });
});

describe("clipsInRect", () => {
  // At RANGE, one second is 45px: `a` spans x 0..180 on row 0, `b` spans
  // x 270..450 on row 0, and `c` spans x 0..180 on row 1 (y 44..84).
  const d = doc([["v1", "video"], ["v2", "video"]], {
    a: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }),
    b: imageElement({ trackId: "v1", startTime: 6000, duration: 4000 }),
    c: imageElement({ trackId: "v2", startTime: 0, duration: 4000 }),
  });

  it("selects a clip the band merely grazes", () => {
    // Five pixels of a 180px clip. Touching is the whole rule.
    expect(clipsInRect(layout(d), { x: 175, y: 5, w: 10, h: 10 })).toEqual(["a"]);
  });

  it("does not have to contain a clip to select it", () => {
    // The band drawn wholly *inside* the clip — the other half of "touch".
    expect(clipsInRect(layout(d), { x: 50, y: 10, w: 10, h: 10 })).toEqual(["a"]);
  });

  it("sweeps two rows at once, naming them in layout order", () => {
    // Track index, then start time — top to bottom, left to right, which is
    // what is on screen.
    expect(clipsInRect(layout(d), { x: 0, y: 0, w: 300, h: 100 })).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("selects the same clips whichever corner the drag started from", () => {
    const l = layout(d);
    const tl = { x: 10, y: 10 };
    const br = { x: 300, y: 100 };
    const tr = { x: 300, y: 10 };
    const bl = { x: 10, y: 100 };
    const expected = ["a", "b", "c"];
    for (const [from, to] of [
      [tl, br],
      [br, tl],
      [tr, bl],
      [bl, tr],
    ]) {
      expect(clipsInRect(l, rectBetween(from, to))).toEqual(expected);
    }
  });

  it("selects neither of two clips when the band sits in the gap between them", () => {
    expect(clipsInRect(layout(d), { x: 200, y: 5, w: 50, h: 10 })).toEqual([]);
  });

  it("declines a band with no width", () => {
    // `overlap.ts`' rule: a half-open interval of zero width holds nothing.
    expect(clipsInRect(layout(d), { x: 90, y: 0, w: 0, h: 40 })).toEqual([]);
  });

  it("declines a band with no height", () => {
    // Otherwise a perfectly horizontal sweep would claim a whole row.
    expect(clipsInRect(layout(d), { x: 0, y: 20, w: 500, h: 0 })).toEqual([]);
  });

  it("leaves a clip alone when the band stops exactly at its left edge", () => {
    expect(clipsInRect(layout(d), { x: 200, y: 5, w: 70, h: 10 })).toEqual([]);
  });

  it("claims a clip when the band starts exactly on its left edge", () => {
    expect(clipsInRect(layout(d), { x: 270, y: 5, w: 10, h: 10 })).toEqual(["b"]);
  });

  it("leaves a clip alone when the band starts exactly at its right edge", () => {
    // The rule `hitTest` gives abutting clips: an edge belongs to one side.
    expect(clipsInRect(layout(d), { x: 180, y: 5, w: 10, h: 10 })).toEqual([]);
  });

  it("finds a clip too short to draw at its true width", () => {
    // 10ms is 0.45px of time and `MIN_CLIP_PX` of picture. The band agrees
    // with the pixels, not with the arithmetic.
    const tiny = doc([["v1", "video"]], {
      t: imageElement({ trackId: "v1", startTime: 20_000, duration: 10 }),
    });
    const l = layout(tiny);
    expect(l.clips[0]).toMatchObject({ x: 900, w: MIN_CLIP_PX });
    expect(clipsInRect(l, { x: 902, y: 5, w: 1, h: 10 })).toEqual(["t"]);
  });

  it("cannot select a clip scrolled off the side, because none is drawn to touch", () => {
    const l = layout(d, { hScroll: 5000 });
    expect(clipsInRect(l, { x: 0, y: 0, w: 1000, h: 500 })).toEqual([]);
  });

  it("cannot select a row scrolled out of view", () => {
    const l = layout(d, { vScroll: 500 });
    expect(clipsInRect(l, { x: 0, y: 0, w: 1000, h: 500 })).toEqual([]);
  });

  it("ignores a transition badge, selecting the two clips it joins", () => {
    const abutting = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0)],
      elements: {
        a: videoElement({
          trackId: "v1",
          startTime: 0,
          duration: 4000,
          trim: { startTime: 2000, endTime: 6000 },
          sourceDuration: 20_000,
        }),
        b: videoElement({
          trackId: "v1",
          startTime: 4000,
          duration: 4000,
          trim: { startTime: 2000, endTime: 6000 },
          sourceDuration: 20_000,
        }),
      },
    });
    const withT = addTransition(abutting, "t1", "a", "b", "cross", 800, "center");
    const l = layout(withT);
    expect(l.transitions).toHaveLength(1);
    expect(clipsInRect(l, { x: 0, y: 0, w: 1000, h: 100 })).toEqual(["a", "b"]);
  });

  it("selects a group's bar like any other clip", () => {
    const grouped = doc([["g1", "group"]], {
      g: groupElement({ trackId: "g1", startTime: 0, duration: 4000 }),
    });
    expect(clipsInRect(layout(grouped), { x: 0, y: 0, w: 200, h: 40 })).toEqual([
      "g",
    ]);
  });

  it("finds nothing over an empty track", () => {
    expect(
      clipsInRect(layout(doc([["v1", "video"]])), { x: 0, y: 0, w: 500, h: 100 }),
    ).toEqual([]);
  });

  it("finds nothing on an empty layout", () => {
    expect(
      clipsInRect(layout(doc([])), { x: 0, y: 0, w: 500, h: 100 }),
    ).toEqual([]);
  });

  it("agrees with hitTest on a one-pixel band", () => {
    // The contract that keeps the two queries in one file: a click and a
    // one-pixel band on the same pixel must name the same clip.
    const l = layout(d);
    for (const clip of l.clips) {
      const x = clip.x + clip.w / 2;
      const y = clip.y + clip.h / 2;
      expect(clipsInRect(l, { x, y, w: 1, h: 1 })).toEqual([clip.elementId]);
      expect(hitTest(l, x, y)).toMatchObject({ elementId: clip.elementId });
    }
  });
});
