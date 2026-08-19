import { describe, it, expect } from "vitest";
import {
  KEYFRAME_LANE_PX,
  KEYFRAME_MIN_CLIP_H,
  MAX_MARKERS_PER_CLIP,
  keyframeLane,
  keyframeTimes,
  planKeyframeMarkers,
} from "./keyframeMarkers";
import {
  TRACK_HEIGHT,
  TRACK_PITCH,
  hitTest,
  layoutTimeline,
  type ClipRect,
  type LayoutInput,
} from "./layout";
import { msToPxSigned } from "./geometry";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { bakeTrack } from "../animation/keyframes";
import {
  audioElement,
  gifElement,
  imageElement,
  keys,
  shapeElement,
  videoElement,
} from "../renderer/testing";

const RANGE = 0.9; // 45px per second

const rect = (over: Partial<ClipRect> = {}): ClipRect => ({
  elementId: "a",
  trackId: "v1",
  x: 100,
  y: 40,
  w: 180,
  h: TRACK_HEIGHT,
  ...over,
});

/** One live track built from `[t, value]` pairs. */
function track(pairs: Array<[number, number]>, isActivate = true) {
  const authored = keys(...pairs);
  return { isActivate, x: authored, ax: bakeTrack(authored) };
}

function withTracks(over: Record<string, any>, base = imageElement()) {
  return imageElement({
    ...(base as any),
    animation: { ...(base.animation as any), ...over },
  } as any);
}

describe("keyframeTimes", () => {
  it("returns nothing for an element with no keyframes", () => {
    expect(keyframeTimes(imageElement())).toEqual([]);
  });

  it("collects one property's keyframe times", () => {
    const el = withTracks({ opacity: track([[0, 0], [1000, 100]]) });
    expect(keyframeTimes(el)).toEqual([0, 1000]);
  });

  it("unions across properties, sorted", () => {
    // One lane, so the user sees that *something* is keyed at each instant;
    // which property it was is the curve editor's job.
    const el = withTracks({
      opacity: track([[1000, 0]]),
      rotation: track([[500, 0]]),
      scale: track([[1500, 10]]),
    });
    expect(keyframeTimes(el)).toEqual([500, 1000, 1500]);
  });

  it("unions both lanes of position", () => {
    const el = withTracks({
      position: {
        isActivate: true,
        x: keys([0, 0], [1000, 5]),
        y: keys([500, 0]),
        ax: [],
        ay: [],
      },
    });
    expect(keyframeTimes(el)).toEqual([0, 500, 1000]);
  });

  it("ignores an inactive track", () => {
    const el = withTracks({ opacity: track([[0, 0], [1000, 100]], false) });
    expect(keyframeTimes(el)).toEqual([]);
  });

  it("ignores an active track with no keyframes", () => {
    const el = withTracks({ opacity: { isActivate: true, x: [], ax: [] } });
    expect(keyframeTimes(el)).toEqual([]);
  });

  it("gives a shape its opacity track and nothing else", () => {
    // A shape's type carries opacity alone, so any other track on it is data
    // the renderer never reads and must not be advertised.
    const el = shapeElement({
      animation: {
        opacity: track([[0, 0]]),
        position: track([[500, 5]]),
      } as any,
    });
    expect(keyframeTimes(el)).toEqual([0]);
  });

  it.each([
    ["gif", gifElement()],
    ["audio", audioElement()],
  ])("returns nothing for %s, which carries no animation block", (_l, el) => {
    expect(keyframeTimes(el as any)).toEqual([]);
  });

  it.each([
    ["a missing animation block", undefined],
    ["null", null],
    ["a string", "nope"],
    ["tracks that are not objects", { opacity: 5, position: "x" }],
    ["tracks whose lists are not arrays", { opacity: { isActivate: true, x: 7 } }],
    ["keyframes with no p", { opacity: { isActivate: true, x: [{}, null] } }],
    [
      "keyframes with a NaN time",
      { opacity: { isActivate: true, x: [{ p: [NaN, 1] }] } },
    ],
  ])("survives %s without throwing", (_label, animation) => {
    const el = imageElement({ animation: animation as any });
    expect(() => keyframeTimes(el)).not.toThrow();
    expect(Array.isArray(keyframeTimes(el))).toBe(true);
  });
});

describe("keyframeLane", () => {
  const animated = withTracks({ opacity: track([[0, 0], [1000, 100]]) });

  it("sits along the bottom of the clip", () => {
    expect(keyframeLane(rect(), animated)).toEqual({
      top: 40 + TRACK_HEIGHT - KEYFRAME_LANE_PX,
      height: KEYFRAME_LANE_PX,
      centerY: 40 + TRACK_HEIGHT - KEYFRAME_LANE_PX / 2,
    });
  });

  it("is absent when the element has no keyframes", () => {
    expect(keyframeLane(rect(), imageElement())).toBeNull();
  });

  it.each([
    ["gif", gifElement()],
    ["audio", audioElement()],
  ])("is absent for %s, so its waveform keeps the full height", (_l, el) => {
    expect(keyframeLane(rect(), el as any)).toBeNull();
  });

  it("is absent on a clip too short to spare the room", () => {
    expect(
      keyframeLane(rect({ h: KEYFRAME_MIN_CLIP_H - 1 }), animated),
    ).toBeNull();
    expect(keyframeLane(rect({ h: KEYFRAME_MIN_CLIP_H }), animated)).not.toBeNull();
  });
});

describe("planKeyframeMarkers", () => {
  const plan = (element: any, over: Partial<ClipRect> = {}, range = RANGE) =>
    planKeyframeMarkers({ element, rect: rect(over), range });

  it("places a marker at rect.x plus the keyframe's own offset", () => {
    const el = withTracks({ opacity: track([[0, 0], [1000, 50], [2000, 100]]) });
    const markers = plan(el);

    expect(markers.map((m) => m.tMs)).toEqual([0, 1000, 2000]);
    for (const marker of markers) {
      expect(marker.x).toBeCloseTo(100 + msToPxSigned(marker.tMs, RANGE), 6);
    }
  });

  it("puts a keyframe at t=0 exactly on the clip's left edge", () => {
    const el = withTracks({ opacity: track([[0, 0], [1000, 100]]) });
    expect(plan(el)[0].x).toBe(100);
  });

  it("places a sped-up clip's keyframes at the same pixels as a 1x clip", () => {
    // Keyframe times are timeline ms, so there is no speed term. A keyframe at
    // t=1000 is one second of timeline along, which is when it plays.
    const authored = keys([0, 0], [1000, 100]);
    const animation = {
      ...(videoElement().animation as any),
      opacity: { isActivate: true, x: authored, ax: bakeTrack(authored) },
    };
    const slow = videoElement({ speed: 1, duration: 4000, animation } as any);
    const fast = videoElement({ speed: 2, duration: 4000, animation } as any);

    const a = planKeyframeMarkers({ element: slow, rect: rect(), range: RANGE });
    const b = planKeyframeMarkers({ element: fast, rect: rect(), range: RANGE });
    expect(b.map((m) => m.x)).toEqual(a.map((m) => m.x));
  });

  it("merges keyframes too close together to draw apart", () => {
    // At range 0.9 two keyframes 1ms apart are 0.045px apart — drawn separately
    // they are an unreadable smear.
    const el = withTracks({ opacity: track([[1000, 0], [1001, 50]]) });
    const markers = plan(el);
    expect(markers).toHaveLength(1);
    expect(markers[0].count).toBe(2);
    // The merged marker keeps the earliest time, as the sampler breaks ties.
    expect(markers[0].tMs).toBe(1000);
  });

  it("separates the same pair once the timeline is zoomed in", () => {
    const el = withTracks({ opacity: track([[1000, 0], [1001, 50]]) });
    const markers = planKeyframeMarkers({
      element: el,
      rect: rect({ w: 100_000 }),
      range: 1000,
    });
    expect(markers).toHaveLength(2);
  });

  it("accumulates a three-way merge", () => {
    const el = withTracks({
      opacity: track([[1000, 0], [1001, 5], [1002, 9]]),
    });
    expect(plan(el)[0].count).toBe(3);
  });

  it("drops keyframes outside the clip's span", () => {
    // A trim keeps keyframes it pushed out of view, so dragging the edge back
    // out restores them — but they have nowhere to draw meanwhile.
    const el = withTracks({
      opacity: track([[-5000, 0], [1000, 50], [999_999, 100]]),
    });
    expect(plan(el).map((m) => m.tMs)).toEqual([1000]);
  });

  it("keeps a keyframe exactly on the clip's end", () => {
    const el = imageElement({
      duration: 4000,
      animation: {
        ...(imageElement().animation as any),
        opacity: track([[0, 0], [4000, 100]]),
      } as any,
    });
    expect(plan(el).map((m) => m.tMs)).toEqual([0, 4000]);
  });

  it("returns nothing for an element with no live tracks", () => {
    expect(plan(imageElement())).toEqual([]);
  });

  it("plans nothing for keyframes that fall outside the clip box", () => {
    // A long clip zoomed in has most of its keyframes off the visible box;
    // planning them would be thousands of markers per repaint, all of which the
    // clip path then throws away.
    const el = imageElement({
      duration: 100_000,
      animation: {
        ...(imageElement().animation as any),
        opacity: track([[0, 0], [50_000, 50], [100_000, 100]]),
      } as any,
    });
    const markers = plan(el, { x: 100, w: 180 });
    expect(markers.every((m) => m.x <= 100 + 180 + 4)).toBe(true);
  });

  it("stays bounded and fast on a track with 100,000 keyframes", () => {
    // Culling to the clip box plus the spacing rule bounds this at rect.w / 5;
    // the cap is the backstop for a pathological zoom.
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < 100_000; i++) {
      pairs.push([i, i % 100]);
    }
    const el = imageElement({
      duration: 200_000,
      animation: {
        ...(imageElement().animation as any),
        opacity: { isActivate: true, x: keys(...pairs), ax: [] },
      } as any,
    });

    const start = Date.now();
    const markers = plan(el, { w: 200 });
    expect(Date.now() - start).toBeLessThan(500);
    expect(markers.length).toBeLessThanOrEqual(MAX_MARKERS_PER_CLIP);
    expect(markers.length).toBeLessThanOrEqual(200 / 5 + 1);
  });
});

/**
 * The explicit non-conflict pin.
 *
 * Diamonds are display-only. The marker data is not part of `TimelineLayout` at
 * all, so a press cannot land on one — but that is only obvious to someone who
 * knows the module boundary, and this replays the whole hit-test suite against
 * a document whose clips are loaded with keyframes to say so out loud.
 */
describe("hitTest is unaffected by keyframes", () => {
  function doc(elements: Record<string, any>): TimelineDocument {
    return normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0), createTrack("v2", "video", 1)],
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
      topOffset: 0,
      ...over,
    });
  }

  /** Keyframes on every property, including ones right under the trim handles. */
  const loaded = {
    position: {
      isActivate: true,
      x: keys([0, 0], [10, 5], [3990, 8], [4000, 9]),
      y: keys([0, 0], [2000, 5]),
      ax: [],
      ay: [],
    },
    opacity: track([[0, 0], [1, 1], [2, 2], [4000, 100]]),
    scale: track([[0, 10], [4000, 20]]),
    rotation: track([[0, 0], [4000, 360]]),
  };

  const plain = doc({
    a: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }),
    b: imageElement({ trackId: "v1", startTime: 6000, duration: 4000 }),
  });

  const animated = doc({
    a: imageElement({
      trackId: "v1",
      startTime: 0,
      duration: 4000,
      animation: loaded as any,
    }),
    b: imageElement({
      trackId: "v1",
      startTime: 6000,
      duration: 4000,
      animation: loaded as any,
    }),
  });

  const probes: Array<[string, number, number]> = [
    ["clip body", 90, 10],
    ["second clip on the row", 360, 10],
    ["leading trim handle", 1, 10],
    ["just inside the leading handle", 9, 10],
    ["trailing trim handle", 179, 10],
    ["just inside the trailing handle", 170, 10],
    ["bare track", 250, 10],
    ["the row below", 10, TRACK_PITCH + 5],
    ["the gap between rows", 10, TRACK_HEIGHT + 1],
    ["below the last row", 10, 400],
    ["the very bottom of a clip, where the lane is", 90, TRACK_HEIGHT - 1],
    ["the bottom-left corner, lane over trim handle", 1, TRACK_HEIGHT - 1],
    ["the bottom-right corner, lane over trim handle", 179, TRACK_HEIGHT - 1],
  ];

  it.each(probes)("resolves %s identically", (_label, x, y) => {
    expect(hitTest(layout(animated), x, y)).toEqual(
      hitTest(layout(plain), x, y),
    );
  });

  it("produces an identical layout except for the elements themselves", () => {
    const a = layout(plain);
    const b = layout(animated);
    expect(b.clips).toEqual(a.clips);
    expect(b.totalHeight).toBe(a.totalHeight);
    expect(b.rows.map((r) => [r.trackId, r.top, r.height])).toEqual(
      a.rows.map((r) => [r.trackId, r.top, r.height]),
    );
  });

  it("carries no marker data on the layout at all", () => {
    // Structural, not incidental: there is nothing in here for a press to hit.
    const l = layout(animated);
    expect(Object.keys(l).sort()).toEqual(["clips", "rows", "totalHeight"]);
    for (const clip of l.clips) {
      expect(Object.keys(clip).sort()).toEqual([
        "elementId",
        "h",
        "trackId",
        "w",
        "x",
        "y",
      ]);
    }
  });
});

describe("lane and markers agree", () => {
  it("reports no lane when every keyframe is outside the clip", () => {
    // Trimming a clip's left edge inward rebases its keyframes to negative
    // times. They are kept, so dragging the edge back out restores them — but
    // there is nothing to draw, and reserving the 8px band anyway left a dead
    // strip with the waveform squeezed up into it.
    const el = withTracks({ opacity: track([[-5000, 0], [-1000, 100]]) });
    const r = rect();
    expect(keyframeTimes(el).length).toBeGreaterThan(0);
    expect(planKeyframeMarkers({ element: el, rect: r, range: RANGE })).toEqual([]);
    expect(keyframeLane(r, el, RANGE)).toBeNull();
  });

  it("reports a lane whenever there is a marker to put in it", () => {
    const el = withTracks({ opacity: track([[0, 0], [1000, 100]]) });
    const r = rect();
    expect(
      planKeyframeMarkers({ element: el, rect: r, range: RANGE }).length,
    ).toBeGreaterThan(0);
    expect(keyframeLane(r, el, RANGE)).not.toBeNull();
  });

  it("still answers without a range, for callers that only need the geometry", () => {
    const el = withTracks({ opacity: track([[0, 0], [1000, 100]]) });
    expect(keyframeLane(rect(), el)).not.toBeNull();
  });
});
