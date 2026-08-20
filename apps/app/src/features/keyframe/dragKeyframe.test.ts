import { describe, it, expect } from "vitest";
import {
  SNAP_RADIUS_PX,
  beginDrag,
  curveChanged,
  snapCandidates,
  updateDrag,
  type DragTarget,
} from "./dragKeyframe";
import { msPerPx, toScreen, type Viewport } from "./editorGeometry";
import { bakeTrack } from "../animation/keyframes";
import { handlesInBounds } from "../animation/handleBounds";
import { SCHEMA_VERSION, createTrack, type TimelineDocument } from "../timeline/tracks";
import { imageElement, keys } from "../renderer/testing";

const DURATION = 2000;

function view(over: Partial<Viewport> = {}): Viewport {
  return {
    timelineRange: 4,
    timelineScroll: 0,
    verticalScroll: 0,
    verticalRange: 1,
    startTime: 0,
    duration: DURATION,
    ...over,
  };
}

/** An image animated on `position`, both lanes keyed at the same instants. */
function doc(): TimelineDocument {
  const base = imageElement();
  const x = keys([0, 0], [500, 50], [1000, 100]);
  const y = keys([0, 200], [500, 300], [1000, 400]);
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements: {
      a: imageElement({
        trackId: "v1",
        duration: DURATION,
        location: { x: 7, y: 9 },
        animation: {
          ...(base.animation as any),
          position: {
            isActivate: true,
            x,
            ax: bakeTrack(x),
            y,
            ay: bakeTrack(y),
          },
        } as any,
      }),
    },
  };
}

const target: DragTarget = {
  elementId: "a",
  property: "position",
  lane: "x",
};

const lane = (d: TimelineDocument, which: "x" | "y") =>
  (d.elements.a as any).animation.position[which];
const times = (d: TimelineDocument, which: "x" | "y") =>
  lane(d, which).map((k: any) => k.p[0]);

/** Canvas coordinates of a track-space point. */
const screen = (v: Viewport, tMs: number, value: number) =>
  toScreen(v, tMs, value);

const noSnap = { playheadMs: -99999, enableSnap: false };

describe("dragging an anchor", () => {
  const v = view();
  const base = doc();

  // The bug this exists for: `_handleMouseMove` used to fold each frame's
  // delta into the result of the last one. Rounding error compounded, and the
  // index it re-read is one `moveKeyframe` re-sorts — so a drag past a
  // neighbour silently started moving a different keyframe.
  it("does not drift over many identical moves", () => {
    const state = beginDrag(base, target, { index: 1, part: "p" });
    const point = screen(v, 750, 75);

    const first = updateDrag(state, v, point.x, point.y, noSnap);
    for (let i = 0; i < 50; i++) {
      const again = updateDrag(state, v, point.x, point.y, noSnap);
      expect(times(again.doc, "x")).toEqual(times(first.doc, "x"));
      expect(lane(again.doc, "x")[again.index].p).toEqual(
        lane(first.doc, "x")[first.index].p,
      );
    }
  });

  it("reports the index the keyframe landed at after re-sorting", () => {
    const state = beginDrag(base, target, { index: 0, part: "p" });
    const point = screen(v, 750, 5);
    const out = updateDrag(state, v, point.x, point.y, noSnap);

    expect(times(out.doc, "x")).toEqual([500, 750, 1000]);
    expect(out.index).toBe(1);
    expect(lane(out.doc, "x")[out.index].p[0]).toBe(750);
  });

  // The lanes desyncing is what made a position drag trace a path nobody drew.
  it("keeps the sibling lane at the same instants", () => {
    const state = beginDrag(base, target, { index: 1, part: "p" });
    const point = screen(v, 750, 75);
    const out = updateDrag(state, v, point.x, point.y, noSnap);

    expect(times(out.doc, "x")).toEqual(times(out.doc, "y"));
  });

  it("leaves the sibling lane's values alone", () => {
    const state = beginDrag(base, target, { index: 1, part: "p" });
    const point = screen(v, 750, 75);
    const out = updateDrag(state, v, point.x, point.y, noSnap);

    expect(lane(out.doc, "y").map((k: any) => k.p[1])).toEqual([200, 300, 400]);
  });

  // `p[0]` used to run negative freely while the drawn dot sat pinned at x=0
  // by the clamp inside `millisecondsToPx` — the point stopped moving and the
  // data did not.
  it("holds a drag past the end of the clip at the end", () => {
    const state = beginDrag(base, target, { index: 2, part: "p" });
    const point = screen(v, 99999, 50);
    const out = updateDrag(state, v, point.x, point.y, noSnap);

    expect(lane(out.doc, "x")[out.index].p[0]).toBe(DURATION);
  });

  it("holds a drag before the clip at zero", () => {
    // A document whose earliest keyframe is not already at 0, so the clamp is
    // what stops the drag rather than the neighbour below.
    const late = doc();
    for (const which of ["x", "y"] as const) {
      lane(late, which)[0].p[0] = 200;
      lane(late, which)[0].cs = [200, lane(late, which)[0].p[1]];
    }
    const state = beginDrag(late, target, { index: 0, part: "p" });
    const point = screen(v, -5000, 50);
    const out = updateDrag(state, v, point.x, point.y, noSnap);

    expect(lane(out.doc, "x")[out.index].p[0]).toBe(0);
  });

  // `moveKeyframe` refuses a move that would land exactly on another keyframe,
  // because one of the two would become unreachable. Clamping a drag to the
  // clip start can produce exactly that when a keyframe already sits there —
  // the drag is declined outright rather than eating its neighbour.
  it("declines a clamped drag that would land on a neighbour", () => {
    const state = beginDrag(base, target, { index: 1, part: "p" });
    const point = screen(v, -5000, 50);
    const out = updateDrag(state, v, point.x, point.y, noSnap);

    expect(out.doc).toBe(base);
    expect(times(out.doc, "x")).toEqual([0, 500, 1000]);
  });

  it("declines a drag that ends where it began", () => {
    const state = beginDrag(base, target, { index: 1, part: "p" });
    const point = screen(v, 500, 50);
    const out = updateDrag(state, v, point.x, point.y, noSnap);

    expect(curveChanged(base, out.doc, target)).toBe(false);
  });

  it("leaves the invariant intact on both lanes", () => {
    const state = beginDrag(base, target, { index: 0, part: "p" });
    const point = screen(v, 1500, 5);
    const out = updateDrag(state, v, point.x, point.y, noSnap);

    expect(handlesInBounds(lane(out.doc, "x"))).toBe(true);
    expect(handlesInBounds(lane(out.doc, "y"))).toBe(true);
  });
});

describe("snapping", () => {
  const v = view();
  const base = doc();

  it("offers the playhead and both clip edges", () => {
    expect(snapCandidates(view({ startTime: 100 }), 700)).toEqual([
      600,
      0,
      DURATION,
    ]);
  });

  it("pulls a near miss onto the playhead", () => {
    const state = beginDrag(base, target, { index: 1, part: "p" });
    // Two pixels short of the playhead — inside the snap radius.
    const point = screen(v, 750, 50);
    const out = updateDrag(state, v, point.x - 2, point.y, {
      playheadMs: 750,
      enableSnap: true,
    });

    expect(lane(out.doc, "x")[out.index].p[0]).toBe(750);
  });

  it("leaves a deliberate miss alone", () => {
    const state = beginDrag(base, target, { index: 1, part: "p" });
    const point = screen(v, 750, 50);
    const far = SNAP_RADIUS_PX + 4;
    const out = updateDrag(state, v, point.x + far, point.y, {
      playheadMs: 750,
      enableSnap: true,
    });

    const landed = lane(out.doc, "x")[out.index].p[0];
    expect(landed).not.toBe(750);
    expect(landed).toBeCloseTo(750 + far * msPerPx(v.timelineRange), 0);
  });

  it("is off when the modifier is held", () => {
    const state = beginDrag(base, target, { index: 1, part: "p" });
    const point = screen(v, 750, 50);
    const out = updateDrag(state, v, point.x - 2, point.y, {
      playheadMs: 750,
      enableSnap: false,
    });

    expect(lane(out.doc, "x")[out.index].p[0]).not.toBe(750);
  });

  it("snaps both lanes together", () => {
    const state = beginDrag(base, target, { index: 1, part: "p" });
    const point = screen(v, 750, 50);
    const out = updateDrag(state, v, point.x - 2, point.y, {
      playheadMs: 750,
      enableSnap: true,
    });

    expect(times(out.doc, "y")).toEqual(times(out.doc, "x"));
  });
});

describe("dragging a handle", () => {
  const v = view();
  const base = doc();

  // The whole point of `handleBounds`: the handle used to follow the pointer
  // anywhere while `bakeTrack` clamped the abscissa before solving, so past
  // the neighbour the drawn handle moved and the curve did not.
  it.each([
    ["cs past the previous anchor", "cs" as const, -9000, 0],
    ["ce past the next anchor", "ce" as const, 9000, 1000],
  ])("holds %s at the boundary", (_name, part, tMs, expected) => {
    const state = beginDrag(base, target, { index: 1, part });
    const point = screen(v, tMs as number, 50);
    const out = updateDrag(state, v, point.x, point.y, noSnap);

    expect(lane(out.doc, "x")[1][part][0]).toBe(expected);
  });

  // Time only. Clamping the value axis too would make overshoot and bounce
  // easings inexpressible.
  it("lets a handle range freely on the value axis", () => {
    const state = beginDrag(base, target, { index: 1, part: "ce" });
    const point = screen(v, 600, 5000);
    const out = updateDrag(state, v, point.x, point.y, noSnap);

    expect(lane(out.doc, "x")[1].ce[1]).toBeCloseTo(5000, 6);
  });

  it("leaves the anchor and the other handle where they were", () => {
    const state = beginDrag(base, target, { index: 1, part: "ce" });
    const point = screen(v, 700, 90);
    const out = updateDrag(state, v, point.x, point.y, noSnap);

    expect(lane(out.doc, "x")[1].p).toEqual(lane(base, "x")[1].p);
    expect(lane(out.doc, "x")[1].cs).toEqual(lane(base, "x")[1].cs);
  });

  // A handle belongs to one curve. Only anchors are structural, so only
  // anchors are paired.
  it("does not touch the sibling lane", () => {
    const state = beginDrag(base, target, { index: 1, part: "ce" });
    const point = screen(v, 700, 90);
    const out = updateDrag(state, v, point.x, point.y, noSnap);

    expect(lane(out.doc, "y")).toEqual(lane(base, "y"));
  });

  it("keeps the reported index", () => {
    const state = beginDrag(base, target, { index: 1, part: "cs" });
    const point = screen(v, 300, 40);
    expect(updateDrag(state, v, point.x, point.y, noSnap).index).toBe(1);
  });

  it("does not drift over many identical moves", () => {
    const state = beginDrag(base, target, { index: 1, part: "ce" });
    const point = screen(v, 700, 90);

    const first = updateDrag(state, v, point.x, point.y, noSnap);
    for (let i = 0; i < 50; i++) {
      expect(lane(updateDrag(state, v, point.x, point.y, noSnap).doc, "x")).toEqual(
        lane(first.doc, "x"),
      );
    }
  });
});

describe("curveChanged", () => {
  const base = doc();

  it("is false for the same document", () => {
    expect(curveChanged(base, base, target)).toBe(false);
  });

  // The ops build a fresh document every mousemove, so `!==` says "changed"
  // about a drag that ended exactly where it began — and `withCheckpoint`
  // would record an undo step that appears to do nothing.
  it("is false for a rebuilt document holding the same curve", () => {
    const rebuilt: TimelineDocument = {
      ...base,
      elements: {
        ...base.elements,
        a: JSON.parse(JSON.stringify(base.elements.a)),
      },
    };
    expect(curveChanged(base, rebuilt, target)).toBe(false);
  });

  it.each([["x" as const], ["y" as const]])(
    "notices a change on the %s lane",
    (which) => {
      const v = view();
      const state = beginDrag(base, { ...target, lane: which }, {
        index: 1,
        part: "p",
      });
      const point = screen(v, 800, 80);
      const out = updateDrag(state, v, point.x, point.y, noSnap);
      expect(curveChanged(base, out.doc, target)).toBe(true);
    },
  );
});
