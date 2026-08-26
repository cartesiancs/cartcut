/**
 * Where transition badges and cut affordances sit, and who wins a click.
 *
 * Hit-testing order is the whole subject. A badge straddles a cut, so it
 * overlaps both neighbours' trim handles by construction, and a bare cut sits
 * exactly where those two handles meet. Getting the priority wrong makes one of
 * three things unreachable — and one of them, trimming at a split, is a daily
 * gesture.
 */

import { describe, it, expect } from "vitest";
import {
  CUT_AFFORDANCE_PX,
  MIN_TRANSITION_PX,
  hitTest,
  layoutTimeline,
  type LayoutInput,
} from "./layout";
import { addTransition } from "./transitionOps";
import { addEffect } from "./effectOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { videoElement } from "../renderer/testing";

const RANGE = 0.9;

function layout(doc: TimelineDocument, over: Partial<LayoutInput> = {}) {
  return layoutTimeline({
    doc,
    range: RANGE,
    hScroll: 0,
    vScroll: 0,
    viewportW: 2000,
    viewportH: 500,
    topOffset: 0,
    ...over,
  });
}

function clip(over: {
  startTime: number;
  trimIn: number;
  trimOut: number;
  sourceDuration?: number;
}) {
  const { startTime, trimIn, trimOut, sourceDuration = 20_000 } = over;
  return videoElement({
    trackId: "v0",
    startTime,
    duration: trimOut - trimIn,
    trim: { startTime: trimIn, endTime: trimOut },
    sourceDuration,
  });
}

/** Two abutting clips, cut at 4000, handles either side. */
function baseDoc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      a: clip({ startTime: 0, trimIn: 2000, trimOut: 6000 }),
      b: clip({ startTime: 4000, trimIn: 2000, trimOut: 6000 }),
    },
  });
}

function withTransition(ms = 800): TimelineDocument {
  return addTransition(baseDoc(), "t1", "a", "b", "cross", ms, "center");
}

/** Row 0 is 0..TRACK_HEIGHT with `topOffset: 0`; this is its vertical centre. */
const MID_Y = 20;

describe("layout", () => {
  it("reports a bare cut between two abutting clips", () => {
    const l = layout(baseDoc());
    expect(l.cuts).toHaveLength(1);
    expect(l.cuts[0]).toMatchObject({ fromId: "a", toId: "b", atMs: 4000 });
    expect(l.transitions).toHaveLength(0);
  });

  it("stops reporting the cut once a transition is on it", () => {
    // Offering to add a second would be an offer `addTransition` declines.
    const l = layout(withTransition());
    expect(l.cuts).toHaveLength(0);
    expect(l.transitions).toHaveLength(1);
  });

  it("keeps a transition out of the clip rects", () => {
    const l = layout(withTransition());
    expect(l.clips.map((c) => c.elementId).sort()).toEqual(["a", "b"]);
  });

  it("centres the badge on the cut", () => {
    const l = layout(withTransition());
    const badge = l.transitions[0];
    const cutX = l.clips.find((c) => c.elementId === "b")!.x;
    expect(badge.x + badge.w / 2).toBeCloseTo(cutX, 1);
  });

  it("keeps a very short badge grabbable", () => {
    const l = layout(withTransition(40), { range: 0.05 });
    expect(l.transitions[0].w).toBeGreaterThanOrEqual(MIN_TRANSITION_PX);
  });

  it("marks a badge the handles forced shorter", () => {
    // 400ms of handle each side, so a 4s request resolves to 800ms.
    const tight = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: {
        a: clip({
          startTime: 0,
          trimIn: 0,
          trimOut: 4000,
          sourceDuration: 4400,
        }),
        b: clip({ startTime: 4000, trimIn: 400, trimOut: 4400 }),
      },
    });
    const doc = addTransition(tight, "t1", "a", "b", "cross", 4000, "center");
    expect(layout(doc).transitions[0].clamped).toBe(true);
    expect(layout(withTransition()).transitions[0].clamped).toBe(false);
  });

  it("gives an effect an ordinary clip rect on its own row", () => {
    const doc = addEffect(baseDoc(), "fx", "p", 0, 2000, "e0");
    const l = layout(doc);
    const rect = l.clips.find((c) => c.elementId === "fx");
    expect(rect).toBeDefined();
    // Row 0 — an effect track goes to the front, where it applies to
    // everything beneath it.
    expect(rect!.y).toBe(0);
  });
});

describe("hitTest priority", () => {
  it("gives a badge precedence over the trim handles it overlaps", () => {
    // Without this a badge is unclickable at every zoom, because it sits
    // exactly where both clips' handles are.
    const l = layout(withTransition());
    const badge = l.transitions[0];
    const hit = hitTest(l, badge.x + badge.w / 2, MID_Y);
    expect(hit).toMatchObject({ kind: "transition", transitionId: "t1" });
  });

  it("claims each end of a badge as a length handle", () => {
    const l = layout(withTransition());
    const badge = l.transitions[0];
    expect(hitTest(l, badge.x + 1, MID_Y)).toMatchObject({
      kind: "transition",
      zone: "resizeStart",
    });
    expect(hitTest(l, badge.x + badge.w - 1, MID_Y)).toMatchObject({
      kind: "transition",
      zone: "resizeEnd",
    });
    expect(hitTest(l, badge.x + badge.w / 2, MID_Y)).toMatchObject({
      zone: "body",
    });
  });

  it("offers a bare cut in the middle band of the row", () => {
    const l = layout(baseDoc());
    const cut = l.cuts[0];
    expect(hitTest(l, cut.x, MID_Y)).toMatchObject({
      kind: "cut",
      fromId: "a",
      toId: "b",
    });
  });

  it("leaves the trim handles reachable above and below that band", () => {
    // The regression this guards: every split makes a cut, and a full-height
    // grab zone there would make trimming either side of any of them
    // impossible. The affordance owns only the band it draws.
    const l = layout(baseDoc());
    const cut = l.cuts[0];

    const above = hitTest(l, cut.x, cut.y + 2);
    const below = hitTest(l, cut.x, cut.y + cut.h - 2);
    expect(above.kind).toBe("clip");
    expect(below.kind).toBe("clip");
  });

  it("draws and grabs the affordance over the same band", () => {
    const l = layout(baseDoc());
    const cut = l.cuts[0];
    const cy = cut.y + cut.h / 2;

    expect(hitTest(l, cut.x, cy + CUT_AFFORDANCE_PX - 1).kind).toBe("cut");
    expect(hitTest(l, cut.x, cy + CUT_AFFORDANCE_PX + 1).kind).not.toBe("cut");
  });

  it("does not offer a cut away from the join", () => {
    const l = layout(baseDoc());
    const cut = l.cuts[0];
    expect(hitTest(l, cut.x + 40, MID_Y).kind).toBe("clip");
  });

  it("offers nothing at a cut that already has a transition", () => {
    const l = layout(withTransition());
    expect(l.cuts).toHaveLength(0);
  });
});
