import { describe, it, expect } from "vitest";
import {
  GRAB_RADIUS,
  clampToClip,
  hitTest,
  msPerPx,
  snapTime,
  toScreen,
  toTrack,
  type Viewport,
} from "./editorGeometry";
import { normalizeKeyframes, type Keyframe } from "../animation/keyframes";
import { mulberry32 } from "../renderer/testing";

function view(over: Partial<Viewport> = {}): Viewport {
  return {
    timelineRange: 4,
    timelineScroll: 0,
    verticalScroll: 0,
    verticalRange: 1,
    startTime: 0,
    duration: 5000,
    ...over,
  };
}

const kf = (t: number, v: number, handle = 100): Keyframe => ({
  type: "cubic",
  p: [t, v],
  cs: [t - handle, v],
  ce: [t + handle, v],
});

const legal = (...list: Keyframe[]): Keyframe[] => normalizeKeyframes(list);

describe("toScreen / toTrack round trip", () => {
  // The bug this exists for: drawing went through `millisecondsToPx`, which
  // clamps a negative result to 0 and rounds; dragging went through
  // `pxToMilliseconds` twice, once for the pointer and once for the scroll. So
  // the maps were not inverses, and grabbing a keyframe without moving the
  // mouse nudged it — by a few ms in the middle of the timeline, and by
  // however far it was off-screen at the left edge.
  const viewports: Array<[string, Viewport]> = [
    ["defaults", view()],
    ["scrolled", view({ timelineScroll: 733 })],
    ["zoomed in", view({ timelineRange: 40 })],
    ["zoomed out", view({ timelineRange: 0.5 })],
    ["element starting late", view({ startTime: 12345 })],
    ["vertically panned", view({ verticalScroll: -420 })],
    ["vertically zoomed", view({ verticalRange: 3.5 })],
    [
      "everything at once",
      view({
        timelineRange: 17,
        timelineScroll: 991,
        verticalScroll: 88,
        verticalRange: 0.4,
        startTime: 2500,
      }),
    ],
  ];

  it.each(viewports)("survives a round trip with %s", (_name, v) => {
    const tolerance = msPerPx(v.timelineRange);
    for (const tMs of [0, 1, 37, 500, 4999]) {
      for (const value of [-300, 0, 42.5, 1000]) {
        const screen = toScreen(v, tMs, value);
        const back = toTrack(v, screen.x, screen.y);
        expect(Math.abs(back.tMs - tMs)).toBeLessThanOrEqual(tolerance);
        expect(back.value).toBeCloseTo(value, 6);
      }
    }
  });

  // The clamp in `millisecondsToPx` is one-way: everything at or before the
  // scroll position collapsed onto x=0, so every off-screen keyframe reported
  // the same time and a drag there wrote whichever one the clamp had eaten.
  it("keeps times distinct to the left of the viewport", () => {
    const v = view({ timelineScroll: 400 });
    const a = toScreen(v, 0, 0);
    const b = toScreen(v, 500, 0);
    expect(a.x).toBeLessThan(0);
    expect(a.x).not.toBe(b.x);
    expect(toTrack(v, a.x, a.y).tMs).toBe(0);
  });

  it("survives a round trip for 300 seeded random points", () => {
    const random = mulberry32(0x5eed);
    for (let round = 0; round < 300; round++) {
      const v = view({
        timelineRange: 0.5 + random() * 40,
        timelineScroll: Math.floor(random() * 4000),
        verticalScroll: Math.floor(random() * 800 - 400),
        verticalRange: 0.1 + random() * 9.9,
        startTime: Math.floor(random() * 10000),
      });
      const tMs = Math.floor(random() * 5000);
      const value = Math.floor(random() * 2000 - 1000);

      const screen = toScreen(v, tMs, value);
      const back = toTrack(v, screen.x, screen.y);

      expect(Math.abs(back.tMs - tMs)).toBeLessThanOrEqual(
        msPerPx(v.timelineRange),
      );
      expect(back.value).toBeCloseTo(value, 4);
    }
  });
});

describe("clampToClip", () => {
  it.each([
    ["a time before the clip", -1, 0],
    ["a time at the start", 0, 0],
    ["a time inside", 2500, 2500],
    ["a time at the end", 5000, 5000],
    ["a time past the end", 99999, 5000],
    ["a non-finite time", NaN, 0],
  ])("maps %s", (_name, input, expected) => {
    expect(clampToClip(view(), input as number)).toBe(expected);
  });
});

describe("snapTime", () => {
  it("pulls onto a candidate within tolerance", () => {
    expect(snapTime(497, [500, 1000], 10)).toBe(500);
  });

  it("leaves a time that is not close to anything", () => {
    expect(snapTime(300, [500, 1000], 10)).toBe(300);
  });

  it("chooses the nearest of several candidates", () => {
    expect(snapTime(504, [500, 505, 900], 20)).toBe(505);
  });

  it.each([
    ["no candidates at all", [] as number[]],
    ["only non-finite candidates", [NaN, Infinity]],
  ])("leaves the time alone with %s", (_name, candidates) => {
    expect(snapTime(321, candidates as number[], 50)).toBe(321);
  });

  // Alt-to-disable is expressed as an empty candidate list, so this is the
  // path a modifier-held drag takes.
  it("is a no-op at zero tolerance", () => {
    expect(snapTime(499, [500], 0)).toBe(499);
  });
});

describe("hitTest", () => {
  const list = legal(kf(0, 0), kf(1000, 100), kf(2000, 0));
  const v = view();

  /** Canvas coordinates of one part of one keyframe. */
  const at = (index: number, part: "p" | "cs" | "ce") => {
    const point = part === "p" ? list[index].p : list[index][part];
    return toScreen(v, point[0], point[1]);
  };

  it("finds an anchor under the pointer", () => {
    const point = at(1, "p");
    expect(hitTest(list, v, point.x, point.y)).toEqual({ index: 1, part: "p" });
  });

  it("returns null when the pointer is over nothing", () => {
    expect(hitTest(list, v, 5, 400)).toBeNull();
  });

  // The old test ran `cs`, then `ce`, then `p`, and the first two keyframes'
  // outward handles sit exactly on their anchors — so keyframe 0 could never
  // be picked up, and neither could the last one.
  it("grabs an end anchor whose inert handle sits on top of it", () => {
    for (const index of [0, list.length - 1]) {
      const point = at(index, "p");
      const hit = hitTest(list, v, point.x, point.y, { activeIndex: index });
      expect(hit).toEqual({ index, part: "p" });
    }
  });

  it("never returns a collapsed handle", () => {
    const point = at(0, "cs");
    const hit = hitTest(list, v, point.x, point.y, { activeIndex: 0 });
    expect(hit?.part).not.toBe("cs");
  });

  it("offers the handles of the selected keyframe", () => {
    const point = at(1, "ce");
    expect(hitTest(list, v, point.x, point.y, { activeIndex: 1 })).toEqual({
      index: 1,
      part: "ce",
    });
  });

  // The editor draws handles only for the selection, so offering the ones it
  // did not draw would be grabbing something invisible.
  it("does not offer the handles of an unselected keyframe", () => {
    const point = at(1, "ce");
    const hit = hitTest(list, v, point.x, point.y, { activeIndex: 2 });
    expect(hit?.part).not.toBe("ce");
  });

  it("prefers the nearer of two anchors in range", () => {
    // Two keyframes closer together than the grab radius, so both are in range
    // of a pointer between them.
    const tight = legal(kf(0, 0), kf(20, 0), kf(2000, 0));
    const near = toScreen(v, 20, 0);
    const hit = hitTest(tight, v, near.x - 1, near.y);
    expect(hit).toEqual({ index: 1, part: "p" });
  });

  it("respects a custom radius", () => {
    const point = at(1, "p");
    const offset = { x: point.x + GRAB_RADIUS - 1, y: point.y };
    expect(hitTest(list, v, offset.x, offset.y)).not.toBeNull();
    expect(hitTest(list, v, offset.x, offset.y, { radius: 2 })).toBeNull();
  });

  it.each([
    ["an empty list", [] as Keyframe[]],
    ["an out-of-range activeIndex", list],
  ])("survives %s", (_name, candidate) => {
    expect(
      hitTest(candidate as Keyframe[], v, 0, 0, { activeIndex: 99 }),
    ).not.toBeUndefined();
  });
});
