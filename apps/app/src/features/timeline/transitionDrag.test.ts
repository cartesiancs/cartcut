import { describe, it, expect } from "vitest";
import { resolveTransitionResize } from "./dragResolve";
import { DRAG, idleDrag, reduceDrag } from "./dragMachine";
import { addTransition, setTransitionDuration } from "./transitionOps";
import { msToPxSigned } from "./geometry";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { videoElement } from "../renderer/testing";
import type { Hit } from "./layout";
import type { TransitionAlignment } from "../../@types/timeline";

const RANGE = 0.9;
const FPS = 60;

function clip(over: { startTime: number; trimIn: number; trimOut: number }) {
  const { startTime, trimIn, trimOut } = over;
  return videoElement({
    trackId: "v0",
    startTime,
    duration: trimOut - trimIn,
    trim: { startTime: trimIn, endTime: trimOut },
    sourceDuration: 20_000,
  });
}

function docWith(
  alignment: TransitionAlignment,
  ms = 800,
): TimelineDocument {
  const base = normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      a: clip({ startTime: 0, trimIn: 4000, trimOut: 8000 }),
      b: clip({ startTime: 4000, trimIn: 4000, trimOut: 8000 }),
    },
  });
  return addTransition(base, "t1", "a", "b", "cross", ms, alignment);
}

function px(ms: number): number {
  return msToPxSigned(ms, RANGE);
}

function resize(
  doc: TimelineDocument,
  edge: "start" | "end",
  dxPx: number,
) {
  return resolveTransitionResize({
    base: doc,
    transitionId: "t1",
    edge,
    dxPx,
    range: RANGE,
    fps: FPS,
  });
}

describe("resolveTransitionResize", () => {
  it("changes length by twice the travel on a centred transition", () => {
    // Both ends move together, so a badge that grew by only the pointer's
    // travel would appear to lag it by half.
    const doc = docWith("center");
    const plan = resize(doc, "end", px(200));
    expect(plan.kind).toBe("duration");
    if (plan.kind !== "duration") return;
    expect(plan.durationMs).toBeCloseTo(1200, 0);
  });

  it("inverts the left handle, so dragging out lengthens", () => {
    const doc = docWith("center");
    const plan = resize(doc, "start", px(-200));
    expect(plan.kind).toBe("duration");
    if (plan.kind !== "duration") return;
    expect(plan.durationMs).toBeCloseTo(1200, 0);
  });

  it("changes length one for one when only one edge is free", () => {
    const doc = docWith("end");
    const plan = resize(doc, "start", px(-200));
    expect(plan.kind).toBe("duration");
    if (plan.kind !== "duration") return;
    expect(plan.durationMs).toBeCloseTo(1000, 0);
  });

  it("refuses to drag the edge pinned to the cut", () => {
    // An end-aligned transition's right edge IS the cut. Moving it would take
    // the badge off the cut it describes.
    expect(resize(docWith("end"), "end", px(300)).kind).toBe("none");
    expect(resize(docWith("start"), "start", px(-300)).kind).toBe("none");
  });

  it("declines a gesture that changes nothing", () => {
    expect(resize(docWith("center"), "end", 0).kind).toBe("none");
  });

  it("declines on an id that is not a transition", () => {
    const doc = docWith("center");
    expect(
      resolveTransitionResize({
        base: doc,
        transitionId: "a",
        edge: "end",
        dxPx: px(400),
        range: RANGE,
        fps: FPS,
      }).kind,
    ).toBe("none");
  });

  it("quantizes the resulting length to the frame grid", () => {
    const doc = docWith("center");
    const plan = resize(doc, "end", px(133.7));
    expect(plan.kind).toBe("duration");
    if (plan.kind !== "duration") return;
    // A duration is a difference of two frame-aligned instants, so it lands on
    // a whole number of frames.
    const frames = (plan.durationMs * FPS) / 1000;
    expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-6);
  });

  it("hands the clamp to the ops rather than doing it here", () => {
    // Handles allow 8000ms at most here. A drag past that is not rejected — it
    // is recorded, so trimming a neighbour later gives the length back.
    const doc = docWith("center");
    const plan = resize(doc, "end", px(20_000));
    expect(plan.kind).toBe("duration");
    if (plan.kind !== "duration") return;

    const applied = setTransitionDuration(doc, "t1", plan.durationMs);
    const t = applied.elements.t1;
    if (t.filetype !== "transition") throw new Error("not a transition");
    expect(t.duration).toBe(8000);
    expect(t.requestedDuration).toBe(plan.durationMs);
  });
});

describe("the drag machine", () => {
  const transitionHit = (
    zone: "body" | "resizeStart" | "resizeEnd",
  ): Hit => ({
    kind: "transition",
    transitionId: "t1",
    trackId: "v0",
    zone,
  });

  const cutHit: Hit = {
    kind: "cut",
    trackId: "v0",
    fromId: "a",
    toId: "b",
    atMs: 4000,
  };

  function down(hit: Hit) {
    return reduceDrag(idleDrag, { type: "down", x: 10, y: 10, t: 0, hit });
  }

  it("enters a resize phase from either end of a badge", () => {
    expect(down(transitionHit("resizeStart")).state.phase).toBe(
      "transitionStart",
    );
    expect(down(transitionHit("resizeEnd")).state.phase).toBe("transitionEnd");
  });

  it("treats the body of a badge as a press, not a drag", () => {
    // A transition is anchored to its cut; there is nothing to move.
    expect(down(transitionHit("body")).state.phase).toBe("pressed");
  });

  it("does not let a press on a badge become a clip slide", () => {
    const pressed = down(transitionHit("body")).state;
    const moved = reduceDrag(pressed, {
      type: "move",
      x: 10 + DRAG.MOVE_CANCEL_PX + 20,
      y: 10,
      t: 5,
    });
    expect(moved.state.phase).toBe("pressed");
  });

  it("does not arm a long press on a badge", () => {
    // Coming free of a track is a clip's behaviour and has no meaning here.
    const pressed = down(transitionHit("body")).state;
    const ticked = reduceDrag(pressed, {
      type: "tick",
      t: DRAG.LONG_PRESS_MS + 50,
    });
    expect(ticked.state.phase).toBe("pressed");
    expect(ticked.effects).toEqual([]);
  });

  it("treats a bare cut as a click and never as a drag", () => {
    const pressed = down(cutHit).state;
    expect(pressed.phase).toBe("pressed");

    const moved = reduceDrag(pressed, { type: "move", x: 60, y: 10, t: 5 });
    expect(moved.state.phase).toBe("pressed");

    const ticked = reduceDrag(moved.state, {
      type: "tick",
      t: DRAG.LONG_PRESS_MS + 50,
    });
    expect(ticked.state.phase).toBe("pressed");
  });

  it("still clears the selection on empty space", () => {
    const result = down({ kind: "none" });
    expect(result.effects).toEqual([{ type: "clearSelection" }]);
  });

  it("commits a finished resize as one undo step", () => {
    const dragging = down(transitionHit("resizeEnd")).state;
    const up = reduceDrag(dragging, { type: "up", t: 100 });
    expect(up.effects.map((e) => e.type)).toEqual([
      "checkpoint",
      "commit",
      "cursor",
    ]);
  });

  it("reverts a cancelled resize", () => {
    const dragging = down(transitionHit("resizeStart")).state;
    const cancelled = reduceDrag(dragging, { type: "cancel" });
    expect(cancelled.effects.map((e) => e.type)).toContain("revert");
  });
});
