import { describe, expect, it } from "vitest";
import {
  SNAP_TOLERANCE_PX,
  confirmTrimGuide,
  nextDragPreview,
  resolveMove,
  resolveTrim,
} from "./dragResolve";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import {
  audioElement,
  imageElement,
  videoElement,
  mulberry32,
} from "../renderer/testing";
import {
  ADJACENCY_EPSILON_MS,
  msToPxSigned,
  pxToMsSigned,
  spanEnd,
  spanStart,
} from "./geometry";
import { frameToMs, framePx, isFrameAligned, msToFrame } from "./frames";
import { moveClips, splitClip, trimClipEnd, trimClipStart } from "./clipOps";
import { TRACK_PITCH } from "./layout";
import { MAX_RANGE } from "./zoom";

const FPS = 60;
/** Zoomed in far enough that one frame is 50px — frame editing territory. */
const ZOOMED = MAX_RANGE;
/** The default zoom: one frame is 0.75px, so quantization is invisible. */
const WIDE = 0.9;

function doc(elements: Record<string, any>): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [
      createTrack("v1", "video", 0),
      createTrack("v2", "video", 1),
      createTrack("a1", "audio", 2),
    ],
    elements,
  });
}

/** A clip whose start and length are both whole frames. */
function alignedClip(startFrame: number, lengthFrames: number, over = {}) {
  return imageElement({
    trackId: "v1",
    startTime: frameToMs(startFrame, FPS),
    duration: frameToMs(lengthFrames, FPS),
    ...over,
  });
}

function move(base: TimelineDocument, over: Record<string, any> = {}) {
  return resolveMove({
    base,
    primaryId: "a",
    dragIds: ["a"],
    dxPx: 0,
    dyPx: 0,
    free: false,
    range: ZOOMED,
    fps: FPS,
    playheadMs: -1_000_000, // parked far away unless a test wants it
    trackPitch: TRACK_PITCH,
    ...over,
  });
}

/** `resolveTrim` on element "a" with the playhead parked far away. */
function trimAt(
  base: TimelineDocument,
  edge: "start" | "end",
  dxPx: number,
  over: Record<string, any> = {},
) {
  return resolveTrim({
    base,
    elementId: "a",
    edge,
    dxPx,
    range: ZOOMED,
    fps: FPS,
    playheadMs: -1_000_000,
    ...over,
  });
}

describe("resolveMove — behaviour that must not change", () => {
  it("reproduces the old integer rounding when quantization is off", () => {
    const base = doc({ a: imageElement({ trackId: "v1", startTime: 1000 }) });
    for (const dxPx of [1, 3, 7, 13, 29, -5, -17]) {
      const plan = move(base, { dxPx, range: WIDE, quantize: false });
      expect(plan.kind).toBe("move");
      if (plan.kind !== "move") return;
      expect(plan.appliedMs).toBe(
        Math.round(pxToMsSigned(dxPx, WIDE)),
      );
    }
  });

  it("declines a gesture that has not moved", () => {
    const base = doc({ a: imageElement({ trackId: "v1", startTime: 1000 }) });
    expect(move(base, { dxPx: 0 }).kind).toBe("none");
  });

  it("declines when the clip is missing", () => {
    expect(move(doc({}), { dxPx: 40 }).kind).toBe("none");
  });

  it("still commits a move that is purely vertical", () => {
    // The surviving half of the original `applied === 0 && trackDelta === 0`
    // guard: changing rows is an edit even when the time does not change.
    const base = doc({ a: alignedClip(60, 120) });
    const plan = move(base, { dxPx: 1, dyPx: TRACK_PITCH, free: true });
    expect(plan).toMatchObject({ kind: "move", trackDelta: 1 });
  });

  it("survives degenerate input without producing NaN", () => {
    const base = doc({ a: alignedClip(60, 120) });
    for (const over of [{ range: 0 }, { fps: 0 }, { fps: NaN }]) {
      const plan = move(base, { dxPx: 40, ...over });
      if (plan.kind === "move") {
        expect(Number.isNaN(plan.appliedMs)).toBe(false);
      }
    }
  });
});

describe("resolveMove — frame quantization", () => {
  it("lands on a frame boundary whatever the pixel delta", () => {
    const base = doc({ a: alignedClip(60, 120) });
    const random = mulberry32(5);
    for (let i = 0; i < 300; i++) {
      const dxPx = (random() - 0.5) * 600;
      const plan = move(base, { dxPx });
      if (plan.kind !== "move") continue;
      const landed = spanStart(base.elements.a) + plan.appliedMs;
      expect(isFrameAligned(landed, FPS)).toBe(true);
    }
  });

  it("moves in whole cells, holding each for one frame of travel", () => {
    // The headline behaviour: dragging produces a step function, not a ramp.
    const base = doc({ a: alignedClip(60, 120) });
    const cell = framePx(ZOOMED, FPS);
    const start = spanStart(base.elements.a);
    const seen: number[] = [];
    for (let dxPx = 0; dxPx <= cell * 4; dxPx += 1) {
      const plan = move(base, { dxPx });
      // Positions, not deltas: the difference of two frame instants is not
      // itself exactly one frame duration in IEEE-754, and it does not need to
      // be. Where the clip comes to rest is what has to be exact.
      const landed = start + (plan.kind === "move" ? plan.appliedMs : 0);
      if (seen.length === 0 || seen[seen.length - 1] !== landed) {
        seen.push(landed);
      }
    }
    // Five distinct resting places across four cells of travel, each the next
    // frame along, and never going backwards.
    expect(seen).toEqual([60, 61, 62, 63, 64].map((f) => frameToMs(f, FPS)));
  });

  it("declines a drag shorter than half a frame", () => {
    const base = doc({ a: alignedClip(60, 120) });
    const plan = move(base, { dxPx: framePx(ZOOMED, FPS) * 0.4 });
    expect(plan.kind).toBe("none");
  });

  it("is invisible at the default zoom", () => {
    // One frame is 0.75px there, so the clip still tracks the pointer.
    const base = doc({ a: alignedClip(60, 120) });
    for (const dxPx of [5, 20, 100]) {
      const plan = move(base, { dxPx, range: WIDE });
      expect(plan.kind).toBe("move");
      if (plan.kind !== "move") return;
      const wanted = pxToMsSigned(dxPx, WIDE);
      expect(Math.abs(plan.appliedMs - wanted)).toBeLessThanOrEqual(
        frameToMs(1, FPS) / 2 + 1e-9,
      );
    }
  });

  it("pulls a legacy off-grid clip onto the grid, once", () => {
    // The correction may briefly oppose the pointer — by up to half a frame —
    // which is what every NLE does with imported material.
    const base = doc({ a: imageElement({ trackId: "v1", startTime: 1988.888 }) });
    const plan = move(base, { dxPx: framePx(ZOOMED, FPS) * 3 });
    expect(plan.kind).toBe("move");
    if (plan.kind !== "move") return;
    const landed = 1988.888 + plan.appliedMs;
    expect(isFrameAligned(landed, FPS)).toBe(true);
  });

  it("never lets a clip start before zero", () => {
    const base = doc({ a: alignedClip(2, 120) });
    const plan = move(base, { dxPx: -10_000 });
    expect(plan.kind).toBe("move");
    if (plan.kind !== "move") return;
    const landed = spanStart(base.elements.a) + plan.appliedMs;
    expect(landed).toBe(0);
  });

  it("keeps a multi-clip selection's shape", () => {
    const base = doc({
      a: alignedClip(60, 60),
      b: alignedClip(180, 60),
      c: imageElement({ trackId: "v1", startTime: 5555.5, duration: 1000 }),
    });
    const plan = move(base, { dxPx: 137, dragIds: ["a", "b", "c"] });
    expect(plan.kind).toBe("move");
    if (plan.kind !== "move") return;

    const next = moveClips(base, ["a", "b", "c"], plan.appliedMs, 0);
    expect(isFrameAligned(next.elements.a.startTime, FPS)).toBe(true);
    expect(isFrameAligned(next.elements.b.startTime, FPS)).toBe(true);
    // The odd one out keeps its offset rather than being independently snapped.
    expect(next.elements.b.startTime - next.elements.a.startTime).toBeCloseTo(
      frameToMs(120, FPS),
      9,
    );
    expect(next.elements.c.startTime - next.elements.a.startTime).toBeCloseTo(
      5555.5 - frameToMs(60, FPS),
      9,
    );
  });
});

describe("a drag, event by event", () => {
  // `applyDrag` resolves every pointer event afresh from the gesture's base and
  // carries the preview across events with `nextDragPreview`. These drive whole
  // pointer paths through exactly that loop. One plan at a time cannot see the
  // bug they guard: each event was answered correctly, and the clip still froze
  // a few frames short of 0s, because of what was *kept* between events.

  /** What a move gesture leaves pending on release; `null` means nothing. */
  function moveGesture(
    base: TimelineDocument,
    path: number[],
    dragIds = ["a"],
  ): TimelineDocument | null {
    let preview: TimelineDocument | null = null;
    for (const dxPx of path) {
      const plan = move(base, { dxPx, dragIds, range: WIDE });
      const next =
        plan.kind === "none"
          ? null
          : moveClips(base, dragIds, plan.appliedMs, plan.trackDelta);
      preview = nextDragPreview(preview, base, next, "hold");
    }
    return preview;
  }

  /** The same for dragging the clip's left edge. */
  function trimStartGesture(
    base: TimelineDocument,
    path: number[],
  ): TimelineDocument | null {
    let preview: TimelineDocument | null = null;
    for (const dxPx of path) {
      const plan = trimAt(base, "start", dxPx, { range: WIDE });
      const next =
        plan.kind === "none" ? null : trimClipStart(base, "a", plan.trimMs);
      preview = nextDragPreview(preview, base, next, "base");
    }
    return preview;
  }

  /** Where the canvas shows clip "a" once the gesture is over. */
  const shownStart = (base: TimelineDocument, preview: TimelineDocument | null) =>
    spanStart((preview ?? base).elements.a);

  /**
   * Out to the right, then back to the left — the recorded trackpad gesture.
   * The return steps are coarse on purpose: a real pointer skips over the
   * origin rather than landing on it exactly.
   */
  function awayAndBack(outPx: number, backPx: number): number[] {
    const path: number[] = [];
    for (let dx = 25; dx <= outPx; dx += 25) path.push(dx);
    for (let dx = outPx - 70; dx > backPx; dx -= 70) path.push(dx);
    path.push(backPx);
    return path;
  }

  it("brings a clip that starts at 0 back to 0 when it is dragged away and back", () => {
    // The reported bug, as recorded: the pointer went on to -450px while the
    // clip stayed at 783ms, and releasing committed 783ms.
    const base = doc({ a: alignedClip(0, 540) });
    const preview = moveGesture(base, awayAndBack(300, -450));
    expect(shownStart(base, preview)).toBe(0);
    // Back home is no edit at all: nothing pending, so no undo step.
    expect(preview).toBeNull();
  });

  it("returns to the origin with the pointer, wherever the clip started", () => {
    const base = doc({ a: alignedClip(120, 60) });
    expect(moveGesture(base, awayAndBack(300, 0))).toBeNull();
  });

  it("reaches 0 from anywhere once the pointer overshoots", () => {
    // 14 frames: where the first report stopped.
    const base = doc({ a: alignedClip(14, 540) });
    const path = [];
    for (let dx = -40; dx >= -2_000; dx -= 40) path.push(dx);
    expect(shownStart(base, moveGesture(base, path))).toBe(0);
  });

  it("lands where the last pointer position says, however the pointer got there", () => {
    // With nothing in the way nothing is ever declined, so the route must not
    // matter: the whole path has to agree with its last event resolved alone.
    // The old hold-on-`none` failed exactly this whenever the path ended at the
    // clip's origin.
    const random = mulberry32(11);
    for (let trial = 0; trial < 300; trial++) {
      const startFrame = random() < 0.4 ? 0 : Math.floor(random() * 240);
      const base = doc({ a: alignedClip(startFrame, 60) });
      const path = Array.from(
        { length: 2 + Math.floor(random() * 40) },
        () => Math.round((random() - 0.5) * 800),
      );
      const whole = moveGesture(base, path);
      const lastAlone = moveGesture(base, [path[path.length - 1]]);
      expect(shownStart(base, whole)).toBe(shownStart(base, lastAlone));
    }
  });

  it("brings a trimmed edge back when it is dragged away and back past its clamp", () => {
    // The same freeze, one op over: `trimClipStart` clamps at 0 and hands its
    // input back, which is "no change", not a refusal to hold on to.
    const base = doc({ a: alignedClip(0, 540) });
    const preview = trimStartGesture(base, awayAndBack(300, -450));
    expect(shownStart(base, preview)).toBe(0);
    expect(preview).toBeNull();
  });

  it("still holds a blocked move against what stopped it", () => {
    // The other half of the contract: a *refused* move keeps its last frame,
    // rather than jumping home.
    const base = doc({ n: alignedClip(0, 60), a: alignedClip(180, 60) });
    const path = [];
    for (let dx = -15; dx >= -600; dx -= 15) path.push(dx);
    const preview = moveGesture(base, path);
    expect(preview).not.toBeNull();
    expect(shownStart(base, preview)).toBeGreaterThanOrEqual(
      spanEnd(base.elements.n),
    );
    expect(shownStart(base, preview)).toBeLessThan(spanStart(base.elements.a));
  });
});

describe("nextDragPreview", () => {
  const base = doc({ a: alignedClip(60, 60) });
  const earlier = moveClips(base, ["a"], 1000, 0);
  const later = moveClips(base, ["a"], 2000, 0);

  it("shows the base when the resolver answered no change", () => {
    expect(nextDragPreview(earlier, base, null, "hold")).toBeNull();
    expect(nextDragPreview(earlier, base, null, "base")).toBeNull();
  });

  it("holds the previous frame on a refusal, when asked to", () => {
    expect(nextDragPreview(earlier, base, base, "hold")).toBe(earlier);
  });

  it("shows the base on identity from an op that only clamps", () => {
    expect(nextDragPreview(earlier, base, base, "base")).toBeNull();
  });

  it("takes a changed document as the new candidate", () => {
    expect(nextDragPreview(earlier, base, later, "hold")).toBe(later);
    expect(nextDragPreview(earlier, base, later, "base")).toBe(later);
  });
});

describe("resolveMove — snapping composes with quantization", () => {
  it("takes an off-grid neighbour's edge verbatim", () => {
    // Adjacency is the stronger promise: re-quantizing here would open a
    // sub-frame gap and flash one frame of background at the cut.
    const neighbourEnd = 1988.888;
    const base = doc({
      a: alignedClip(300, 60),
      n: imageElement({
        trackId: "v1",
        startTime: 988.888,
        duration: 1000,
      }),
    });
    expect(spanEnd(base.elements.n)).toBe(neighbourEnd);

    const start = spanStart(base.elements.a);
    const dxPx = msToPxSigned(neighbourEnd - start, ZOOMED) + 2;
    const plan = move(base, { dxPx });
    expect(plan.kind).toBe("move");
    if (plan.kind !== "move") return;
    expect(start + plan.appliedMs).toBe(neighbourEnd);
    expect(plan.snapGuideMs).toBe(neighbourEnd);
  });

  it("agrees with quantization when the neighbour is aligned", () => {
    const base = doc({
      a: alignedClip(300, 60),
      n: alignedClip(0, 120),
    });
    const target = frameToMs(120, FPS);
    const start = spanStart(base.elements.a);
    const dxPx = msToPxSigned(target - start, ZOOMED) + 2;

    const snapPlan = move(base, { dxPx });
    const gridPlan = move(doc({ a: alignedClip(300, 60) }), { dxPx });
    expect(snapPlan).toMatchObject({ kind: "move" });
    if (snapPlan.kind !== "move" || gridPlan.kind !== "move") return;
    expect(start + snapPlan.appliedMs).toBe(target);
    expect(snapPlan.appliedMs).toBe(gridPlan.appliedMs);
  });

  it("keeps the snap tolerance in pixels, not milliseconds", () => {
    // Same distance in ms; snapping fires zoomed out and is irrelevant zoomed
    // in, where quantization has already chosen the same edge.
    const base = doc({
      a: alignedClip(600, 60),
      n: imageElement({ trackId: "v2", startTime: 0, duration: 3333.3 }),
    });
    const target = 3333.3;
    const start = spanStart(base.elements.a);

    const wide = move(base, {
      dxPx: msToPxSigned(target - start, WIDE) + SNAP_TOLERANCE_PX - 1,
      range: WIDE,
    });
    expect(wide.kind).toBe("move");
    if (wide.kind !== "move") return;
    expect(wide.snapGuideMs).toBe(target);

    const zoomed = move(base, {
      dxPx: msToPxSigned(target - start, ZOOMED) + SNAP_TOLERANCE_PX + 40,
    });
    expect(zoomed.kind).toBe("move");
    if (zoomed.kind !== "move") return;
    expect(zoomed.snapGuideMs).toBe(null);
    expect(isFrameAligned(start + zoomed.appliedMs, FPS)).toBe(true);
  });

  it("still snaps to the playhead and to zero", () => {
    const base = doc({ a: alignedClip(300, 60) });
    const start = spanStart(base.elements.a);

    const playhead = 1234.567;
    const toPlayhead = move(base, {
      dxPx: msToPxSigned(playhead - start, ZOOMED) + 3,
      playheadMs: playhead,
    });
    expect(toPlayhead).toMatchObject({ kind: "move", snapGuideMs: playhead });

    const toOrigin = move(base, {
      dxPx: msToPxSigned(-start, ZOOMED) + 3,
    });
    expect(toOrigin).toMatchObject({ kind: "move", snapGuideMs: 0 });
  });

  it("keeps a split's two halves exactly adjacent", () => {
    // The regression this ordering exists to prevent.
    const original = doc({
      a: imageElement({ trackId: "v1", startTime: 1988.888, duration: 3000 }),
    });
    const split = splitClip(original, "a", 3000, "b");
    expect(split).not.toBe(original);
    const boundary = spanEnd(split.elements.a);
    expect(split.elements.b.startTime).toBe(boundary);

    // Push the right half away, then drag it back onto its sibling. Quantizing
    // the return would land it a fraction of a frame off the boundary, and the
    // export would show one frame of background at the cut.
    const displaced = moveClips(split, ["b"], frameToMs(30, FPS), 0);
    expect(displaced).not.toBe(split);

    const plan = resolveMove({
      base: displaced,
      primaryId: "b",
      dragIds: ["b"],
      dxPx: msToPxSigned(-frameToMs(30, FPS) + 1, ZOOMED),
      dyPx: 0,
      free: false,
      range: ZOOMED,
      fps: FPS,
      playheadMs: -1_000_000,
      trackPitch: TRACK_PITCH,
    });
    expect(plan.kind).toBe("move");
    if (plan.kind !== "move") return;
    expect(spanStart(displaced.elements.b) + plan.appliedMs).toBe(boundary);
  });
});

describe("resolveTrim", () => {
  function trim(base: TimelineDocument, over: Record<string, any> = {}) {
    return resolveTrim({
      base,
      elementId: "a",
      edge: "start",
      dxPx: 0,
      range: ZOOMED,
      fps: FPS,
      playheadMs: -1_000_000, // parked far away unless a test wants it
      ...over,
    });
  }

  it("reproduces the old integer rounding when quantization is off", () => {
    const base = doc({ a: imageElement({ trackId: "v1", startTime: 1000 }) });
    const plan = trim(base, { dxPx: 13, range: WIDE, quantize: false });
    expect(plan).toEqual({
      kind: "trim",
      trimMs: Math.round(pxToMsSigned(13, WIDE)),
      snapGuideMs: null,
    });
  });

  it("puts the left edge on a frame boundary", () => {
    const base = doc({ a: alignedClip(60, 300) });
    const plan = trim(base, { dxPx: 137 });
    expect(plan.kind).toBe("trim");
    if (plan.kind !== "trim") return;
    const next = trimClipStart(base, "a", plan.trimMs);
    expect(isFrameAligned(spanStart(next.elements.a), FPS)).toBe(true);
  });

  it("puts the right edge on a frame boundary", () => {
    const base = doc({ a: alignedClip(60, 300) });
    const plan = trim(base, { edge: "end", dxPx: -137 });
    expect(plan.kind).toBe("trim");
    if (plan.kind !== "trim") return;
    const next = trimClipEnd(base, "a", plan.trimMs);
    expect(isFrameAligned(spanEnd(next.elements.a), FPS)).toBe(true);
  });

  it("quantizes the edge, not the delta", () => {
    // A delta-quantizer preserves whatever phase the edge already had; this
    // must actually correct it.
    const base = doc({
      a: imageElement({ trackId: "v1", startTime: 1988.888, duration: 3000 }),
    });
    const plan = trim(base, { dxPx: 137 });
    expect(plan.kind).toBe("trim");
    if (plan.kind !== "trim") return;
    expect(isFrameAligned(1988.888 + plan.trimMs, FPS)).toBe(true);
  });

  it("quantizes the timeline edge of a sped-up clip", () => {
    // `trimStart` converts the timeline delta into source ms via `speed`; what
    // has to land on the grid is the timeline edge, not the source window.
    for (const speed of [0.5, 2]) {
      const base = doc({
        a: videoElement({
          trackId: "v1",
          startTime: frameToMs(60, FPS),
          duration: 4000,
          trim: { startTime: 0, endTime: 4000 },
          sourceDuration: 8000,
          speed,
        }),
      });
      const plan = trim(base, { dxPx: 137 });
      expect(plan.kind).toBe("trim");
      if (plan.kind !== "trim") return;
      const next = trimClipStart(base, "a", plan.trimMs);
      expect(isFrameAligned(spanStart(next.elements.a), FPS)).toBe(true);
    }
  });

  it("declines a trim shorter than half a frame", () => {
    const base = doc({ a: alignedClip(60, 300) });
    expect(trim(base, { dxPx: framePx(ZOOMED, FPS) * 0.4 }).kind).toBe("none");
  });

  it("declines when the clip is missing", () => {
    expect(trim(doc({}), { dxPx: 100 }).kind).toBe("none");
  });

  it("lets a clamp win over the grid", () => {
    // Dragging the left edge past timeline zero stops at zero, which is itself
    // frame-aligned; the point is that the clamp decides, not the quantizer.
    const base = doc({ a: alignedClip(6, 300) });
    const plan = trim(base, { dxPx: -100_000 });
    expect(plan.kind).toBe("trim");
    if (plan.kind !== "trim") return;
    const next = trimClipStart(base, "a", plan.trimMs);
    expect(spanStart(next.elements.a)).toBe(0);
  });
});

describe("resolveTrim — snapping composes with quantization", () => {
  /** Aim at `targetMs` and overshoot by `overPx`, so the ask is zoom-relative. */
  function aimAt(
    base: TimelineDocument,
    edge: "start" | "end",
    targetMs: number,
    range: number,
    overPx = 2,
  ) {
    const element = base.elements.a;
    const edgeMs = edge === "start" ? spanStart(element) : spanEnd(element);
    const toward = targetMs >= edgeMs ? overPx : -overPx;
    return msToPxSigned(targetMs - edgeMs, range) + toward;
  }

  it("takes an off-grid neighbour's start verbatim", () => {
    // The point of the whole feature: a clip that predates frame alignment
    // cannot be met by quantization at all, because its edge is not on the grid.
    const base = doc({
      a: alignedClip(60, 120), // 1000ms .. 3000ms
      b: imageElement({ trackId: "v1", startTime: 3050.7, duration: 2000 }),
    });
    const plan = trimAt(base, "end", aimAt(base, "end", 3050.7, ZOOMED));
    expect(plan.kind).toBe("trim");
    if (plan.kind !== "trim") return;

    expect(plan.snapGuideMs).toBe(3050.7);
    const next = trimClipEnd(base, "a", plan.trimMs);
    expect(spanEnd(next.elements.a)).toBeCloseTo(3050.7, 9);
    // And it is deliberately *not* pulled back onto the grid afterwards.
    expect(isFrameAligned(spanEnd(next.elements.a), FPS)).toBe(false);
  });

  it("pulls the left edge onto the previous clip's end, leaving no seam", () => {
    const base = doc({
      a: alignedClip(120, 120), // 2000ms .. 4000ms
      b: imageElement({ trackId: "v1", startTime: 0, duration: 1961.4 }),
    });
    const plan = trimAt(base, "start", aimAt(base, "start", 1961.4, ZOOMED));
    expect(plan.kind).toBe("trim");
    if (plan.kind !== "trim") return;

    expect(plan.snapGuideMs).toBe(1961.4);
    const next = trimClipStart(base, "a", plan.trimMs);
    expect(spanStart(next.elements.a)).toBeCloseTo(1961.4, 9);
  });

  it("snaps to the playhead", () => {
    const base = doc({ a: alignedClip(60, 300) }); // 1000ms .. 6000ms
    const plan = trimAt(base, "end", aimAt(base, "end", 5953.3, ZOOMED), {
      playheadMs: 5953.3,
    });
    expect(plan).toMatchObject({ kind: "trim", snapGuideMs: 5953.3 });
  });

  it("snaps to timeline zero", () => {
    const base = doc({ a: alignedClip(3, 300) }); // starts at 50ms
    const plan = trimAt(base, "start", aimAt(base, "start", 0, ZOOMED));
    expect(plan).toMatchObject({ kind: "trim", snapGuideMs: 0 });
  });

  it("snaps to a clip on another track", () => {
    const base = doc({
      a: alignedClip(60, 120), // 1000ms .. 3000ms
      b: imageElement({ trackId: "v2", startTime: 3044.4, duration: 500 }),
    });
    const plan = trimAt(base, "end", aimAt(base, "end", 3044.4, ZOOMED));
    expect(plan).toMatchObject({ kind: "trim", snapGuideMs: 3044.4 });
  });

  it("keeps the snap tolerance in pixels, not milliseconds", () => {
    // Same distance in ms; snapping fires zoomed out and is irrelevant zoomed
    // in, where quantization has already chosen the same edge.
    const base = doc({
      a: imageElement({ trackId: "v1", startTime: 1000, duration: 2000 }),
      b: imageElement({ trackId: "v1", startTime: 3222.2, duration: 500 }),
    });

    const wide = trimAt(
      base,
      "end",
      aimAt(base, "end", 3222.2, WIDE, SNAP_TOLERANCE_PX - 1),
      { range: WIDE },
    );
    expect(wide).toMatchObject({ kind: "trim", snapGuideMs: 3222.2 });

    const zoomed = trimAt(
      base,
      "end",
      aimAt(base, "end", 3222.2, ZOOMED, SNAP_TOLERANCE_PX + 40),
    );
    expect(zoomed.kind).toBe("trim");
    if (zoomed.kind !== "trim") return;
    expect(zoomed.snapGuideMs).toBe(null);
    expect(isFrameAligned(3000 + zoomed.trimMs, FPS)).toBe(true);
  });

  it("does not snap the moving edge to the clip's own pinned edge", () => {
    // Otherwise a short clip's right edge would be dragged onto its own left
    // one and the clip would collapse. `excludeIds` is what prevents it.
    const base = doc({
      a: imageElement({ trackId: "v1", startTime: 1000, duration: 30 }),
    });
    const plan = trimAt(base, "end", aimAt(base, "end", 1000, ZOOMED));
    expect(plan.kind).toBe("trim");
    if (plan.kind !== "trim") return;
    expect(plan.snapGuideMs).toBe(null);
  });

  it("snaps the timeline edge of a sped-up clip", () => {
    // `trimMs` is a timeline delta; `clipEdit` converts it by `speed`. What has
    // to meet the neighbour is what the user sees, not the source window.
    for (const speed of [0.5, 2]) {
      const target = 1000 + 4000 / speed + 37.7;
      const base = doc({
        a: videoElement({
          trackId: "v1",
          startTime: frameToMs(60, FPS),
          duration: 4000,
          trim: { startTime: 0, endTime: 4000 },
          sourceDuration: 8000,
          speed,
        }),
        b: imageElement({ trackId: "v1", startTime: target, duration: 500 }),
      });
      const plan = trimAt(base, "end", aimAt(base, "end", target, ZOOMED));
      expect(plan.kind).toBe("trim");
      if (plan.kind !== "trim") return;

      expect(plan.snapGuideMs).toBeCloseTo(target, 9);
      const next = trimClipEnd(base, "a", plan.trimMs);
      expect(Math.abs(spanEnd(next.elements.a) - target)).toBeLessThanOrEqual(
        ADJACENCY_EPSILON_MS,
      );
    }
  });

  it("still declines a gesture that trims nothing", () => {
    const base = doc({
      a: alignedClip(60, 120),
      b: imageElement({ trackId: "v1", startTime: 3000, duration: 500 }),
    });
    // The right edge is already exactly on the neighbour, so the snap it finds
    // is where it already is. That must be no edit at all.
    expect(trimAt(base, "end", 0).kind).toBe("none");
  });
});

describe("confirmTrimGuide", () => {
  it("keeps the guide when the edge arrived", () => {
    const base = doc({
      a: alignedClip(60, 120), // ends at 3000ms
      b: imageElement({ trackId: "v1", startTime: 3050.7, duration: 2000 }),
    });
    const plan = trimAt(base, "end", msToPxSigned(50.7, ZOOMED) + 2);
    if (plan.kind !== "trim") throw new Error("expected a trim");
    const next = trimClipEnd(base, "a", plan.trimMs);
    expect(confirmTrimGuide(next, "a", "end", plan.snapGuideMs)).toBe(3050.7);
  });

  it("drops the guide when the source ran out first", () => {
    // A clip with nothing left at the tail cannot reach the neighbour it was
    // aimed at. The clamp in `clipEdit` decides, and the line goes with it.
    const base = doc({
      a: videoElement({
        trackId: "v1",
        startTime: 4000,
        duration: 2000,
        trim: { startTime: 0, endTime: 2000 },
        sourceDuration: 2000, // nothing left past the window
      }),
      b: imageElement({ trackId: "v1", startTime: 6040.4, duration: 500 }),
    });
    const plan = trimAt(base, "end", msToPxSigned(40.4, ZOOMED) + 2);
    if (plan.kind !== "trim") throw new Error("expected a trim");
    expect(plan.snapGuideMs).toBe(6040.4);

    const next = trimClipEnd(base, "a", plan.trimMs);
    expect(spanEnd(next.elements.a)).toBeLessThan(6040.4);
    expect(confirmTrimGuide(next, "a", "end", plan.snapGuideMs)).toBe(null);
  });

  it("has nothing to confirm when there was no snap", () => {
    const base = doc({ a: alignedClip(60, 120) });
    expect(confirmTrimGuide(base, "a", "end", null)).toBe(null);
  });

  it("drops the guide when the clip is gone", () => {
    expect(confirmTrimGuide(doc({}), "a", "end", 3000)).toBe(null);
  });
});

describe("the render-sample invariant", () => {
  it("puts every edited time on an instant renderTimeline samples", () => {
    // `renderTimeline.ts:47` computes `(currentFrame / fps) * 1000`. This is
    // the whole point of the feature: what the editor writes and what the
    // exporter samples must be the same double.
    const base = doc({ a: alignedClip(60, 120), b: alignedClip(300, 120) });
    const random = mulberry32(21);

    for (let i = 0; i < 200; i++) {
      const plan = move(base, { dxPx: (random() - 0.5) * 800 });
      if (plan.kind !== "move") continue;
      const next = moveClips(base, ["a"], plan.appliedMs, 0);
      const start = next.elements.a.startTime;
      const frame = msToFrame(start, FPS);
      expect(start).toBeCloseTo((frame / FPS) * 1000, 6);
    }
  });

  it("holds at every frame rate a project might use", () => {
    for (const fps of [24, 25, 30, 50, 60, 120]) {
      const base = doc({
        a: imageElement({
          trackId: "v1",
          startTime: frameToMs(60, fps),
          duration: frameToMs(120, fps),
        }),
      });
      const plan = move(base, { dxPx: 213, fps });
      expect(plan.kind).toBe("move");
      if (plan.kind !== "move") return;
      const start = spanStart(base.elements.a) + plan.appliedMs;
      expect(start).toBeCloseTo((msToFrame(start, fps) / fps) * 1000, 6);
    }
  });
});

describe("resolveMove — audio is not on the frame grid", () => {
  /** One frame, in pixels, at the zoom these tests use. */
  const CELL = framePx(ZOOMED, FPS);
  /** A drag too short to survive rounding to a frame — a third of one. */
  const SUB_FRAME_PX = CELL / 3;

  /** An audio clip on the audio row, aligned unless a test says otherwise. */
  function audioClip(startFrame: number, over = {}) {
    return audioElement({
      trackId: "a1",
      startTime: frameToMs(startFrame, FPS),
      duration: 2000,
      trim: { startTime: 0, endTime: 2000 },
      ...over,
    });
  }

  it("moves by less than a frame, where a picture clip does not move at all", () => {
    // The report, and the fix, in one comparison. The same gesture on the same
    // row of pixels: sound follows the pointer, picture waits for the next cell.
    const heard = move(doc({ a: audioClip(60) }), { dxPx: SUB_FRAME_PX });
    expect(heard.kind).toBe("move");
    if (heard.kind !== "move") return;
    expect(heard.appliedMs).not.toBe(0);

    const seen = move(doc({ a: alignedClip(60, 120) }), { dxPx: SUB_FRAME_PX });
    expect(seen.kind).toBe("none");
  });

  it("comes to rest between frames", () => {
    const base = doc({ a: audioClip(60) });
    const offGrid = [1, 2, 4, 5, 7, 8].map((thirds) => {
      const plan = move(base, { dxPx: (CELL * thirds) / 3 });
      if (plan.kind !== "move") return null;
      return isFrameAligned(spanStart(base.elements.a) + plan.appliedMs, FPS);
    });
    // Not "some of them are off-grid" — every one of these lands a third or two
    // thirds of a frame along, so none of them may be aligned.
    expect(offGrid).toEqual([false, false, false, false, false, false]);
  });

  it("lands on a whole millisecond", () => {
    const base = doc({ a: audioClip(60) });
    const random = mulberry32(23);
    for (let i = 0; i < 200; i++) {
      const dxPx = (random() - 0.5) * 600;
      const plan = move(base, { dxPx });
      if (plan.kind !== "move") continue;

      const next = moveClips(base, ["a"], plan.appliedMs, 0);
      const landed = spanStart(next.elements.a);
      expect(Number.isInteger(landed)).toBe(true);
      expect(landed).toBeGreaterThanOrEqual(0);
    }
  });

  it("is not dragged onto the grid on its way somewhere else", () => {
    // The mirror of "pulls a legacy off-grid clip onto the grid, once". An
    // audio clip the user placed at 1988.888 is where they put it; a drag moves
    // it, it does not correct it.
    const base = doc({ a: audioClip(0, { startTime: 1988.888 }) });
    const plan = move(base, { dxPx: CELL * 3 });
    expect(plan.kind).toBe("move");
    if (plan.kind !== "move") return;
    expect(isFrameAligned(1988.888 + plan.appliedMs, FPS)).toBe(false);
    // Whole milliseconds are counted from where it already was, so the phase it
    // arrived with survives the move.
    expect((1988.888 + plan.appliedMs) % 1).toBeCloseTo(0.888, 9);
  });

  it("still snaps to a neighbour's edge, exactly", () => {
    // Losing the grid must not lose the magnet: lining sound up with a cut is
    // the thing an audio drag most often means, and the edge is taken verbatim
    // rather than rounded to the nearest millisecond beside it.
    const neighbourEnd = 1988.888;
    const base = doc({
      a: audioClip(0, { startTime: 6000 }),
      n: audioElement({
        trackId: "a1",
        startTime: 988.888,
        duration: 1000,
        trim: { startTime: 0, endTime: 1000 },
      }),
    });
    const wanted = neighbourEnd - spanStart(base.elements.a);
    const plan = move(base, { dxPx: msToPxSigned(wanted, ZOOMED) + 3 });
    expect(plan).toMatchObject({ kind: "move", snapGuideMs: neighbourEnd });
    if (plan.kind !== "move") return;

    const next = moveClips(base, ["a"], plan.appliedMs, 0);
    expect(spanStart(next.elements.a)).toBe(spanEnd(base.elements.n));
  });

  it("keeps the grid when a picture clip is dragged along with it", () => {
    // One gesture is one delta, so the grid is all-or-nothing. A video and its
    // detached audio moving together must share a delta or lose sync, and it is
    // the video that has a say in what the delta may be.
    //
    // The audio deliberately starts off-grid — which, now that audio drags
    // freely, is its ordinary state rather than a legacy accident. Grabbing it
    // and quantizing *its* destination would drag the video off the grid with
    // it, so the delta is what gets quantized when the anchor is audio.
    const base = doc({
      v: videoElement({
        trackId: "v1",
        startTime: frameToMs(60, FPS),
        duration: 2000,
        trim: { startTime: 0, endTime: 2000 },
        audioDetached: true,
      }),
      a: audioClip(0, { startTime: 1013.4 }),
    });
    const offset = spanStart(base.elements.a) - spanStart(base.elements.v);

    for (const primaryId of ["v", "a"]) {
      const plan = move(base, {
        primaryId,
        dragIds: ["v", "a"],
        dxPx: CELL * 2.4,
      });
      expect(plan.kind).toBe("move");
      if (plan.kind !== "move") return;

      const next = moveClips(base, ["v", "a"], plan.appliedMs, 0);
      // The picture is on the grid whichever clip the pointer was holding.
      expect(isFrameAligned(spanStart(next.elements.v), FPS)).toBe(true);
      // The pair has not drifted apart, which is the whole reason they share
      // a delta.
      expect(
        spanStart(next.elements.a) - spanStart(next.elements.v),
      ).toBeCloseTo(offset, 9);
    }
  });

  it("travels a whole number of frames when audio anchors a mixed drag", () => {
    // The delta itself, stated directly: dragging by 2.4 cells with an
    // off-grid audio clip under the pointer moves everything exactly two
    // frames, not "two frames plus the audio's phase error".
    const base = doc({
      v: alignedClip(60, 120),
      a: audioClip(0, { startTime: 1013.4 }),
    });
    const plan = move(base, {
      primaryId: "a",
      dragIds: ["a", "v"],
      dxPx: CELL * 2.4,
    });
    expect(plan.kind).toBe("move");
    if (plan.kind !== "move") return;
    expect(plan.appliedMs).toBeCloseTo(frameToMs(2, FPS), 9);

    // ...and the audio keeps the phase it had, rather than being corrected.
    const next = moveClips(base, ["a", "v"], plan.appliedMs, 0);
    expect(isFrameAligned(spanStart(next.elements.a), FPS)).toBe(false);
  });

  it("draws no snap guide it is about to round away from", () => {
    // A mixed drag aims at an off-grid edge and then rounds the travel to a
    // whole frame, so the clip comes to rest beside the line rather than on it.
    // Drawing the line anyway is how a correct edit reads as a broken one.
    const base = doc({
      v: alignedClip(300, 60),
      a: audioClip(0, { startTime: 6013.4 }),
      n: audioElement({
        trackId: "a1",
        startTime: 988.888,
        duration: 1000,
        trim: { startTime: 0, endTime: 1000 },
      }),
    });
    const wanted = 1988.888 - spanStart(base.elements.a);
    const plan = move(base, {
      primaryId: "a",
      dragIds: ["a", "v"],
      dxPx: msToPxSigned(wanted, ZOOMED) + 3,
    });
    expect(plan.kind).toBe("move");
    if (plan.kind !== "move") return;

    expect(spanStart(base.elements.a) + plan.appliedMs).not.toBe(1988.888);
    expect(plan.snapGuideMs).toBe(null);
    // The picture is what the rounding was for.
    expect(isFrameAligned(spanStart(base.elements.v) + plan.appliedMs, FPS)).toBe(
      true,
    );
  });

  it("still draws the guide when audio drags alone and lands on the edge", () => {
    // The counterpart: nothing was rounded away, so the line is honest.
    const base = doc({
      a: audioClip(0, { startTime: 6000 }),
      n: audioElement({
        trackId: "a1",
        startTime: 988.888,
        duration: 1000,
        trim: { startTime: 0, endTime: 1000 },
      }),
    });
    const wanted = 1988.888 - spanStart(base.elements.a);
    const plan = move(base, { dxPx: msToPxSigned(wanted, ZOOMED) + 3 });
    expect(plan).toMatchObject({ kind: "move", snapGuideMs: 1988.888 });
  });

  it("does not push an audio anchor before zero", () => {
    // The whole-frame travel is clamped by taking the shortest journey that
    // still lands at or after zero, so the property survives the clamp.
    const base = doc({
      v: alignedClip(6, 12),
      a: audioClip(0, { startTime: 60.4 }),
    });
    const plan = move(base, {
      primaryId: "a",
      dragIds: ["a", "v"],
      dxPx: -10_000,
    });
    expect(plan.kind).toBe("move");
    if (plan.kind !== "move") return;

    expect(60.4 + plan.appliedMs).toBeGreaterThanOrEqual(0);
    expect(isFrameAligned(spanStart(base.elements.v) + plan.appliedMs, FPS)).toBe(
      true,
    );
  });

  it("still declines a gesture that moves nothing", () => {
    // The identity contract `withCheckpoint` relies on: no grid to round a
    // wiggle away means the millisecond floor has to do it instead, or an audio
    // clip would record an undo step for every pointer event.
    const base = doc({ a: audioClip(60) });
    expect(move(base, { dxPx: 0 }).kind).toBe("none");
    // A third of a pixel is a third of a millisecond at this zoom.
    expect(move(base, { dxPx: 0.3 }).kind).toBe("none");
  });

  it("holds the two rules apart across arbitrary drags", () => {
    const audio = doc({ a: audioClip(60) });
    const picture = doc({ a: alignedClip(60, 120) });
    const random = mulberry32(31);
    let everOffGrid = false;

    for (let i = 0; i < 200; i++) {
      const dxPx = (random() - 0.5) * 600;

      const heard = move(audio, { dxPx });
      if (heard.kind === "move") {
        const landed = spanStart(audio.elements.a) + heard.appliedMs;
        expect(Number.isInteger(landed)).toBe(true);
        everOffGrid ||= !isFrameAligned(landed, FPS);
      }

      const seen = move(picture, { dxPx });
      if (seen.kind === "move") {
        const landed = spanStart(picture.elements.a) + seen.appliedMs;
        expect(isFrameAligned(landed, FPS)).toBe(true);
      }
    }

    // Guards the assertion above from passing vacuously: if audio were still
    // quantized, every landing would be aligned and nothing here would fail.
    expect(everOffGrid).toBe(true);
  });
});
