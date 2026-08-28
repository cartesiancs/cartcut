import { describe, expect, it } from "vitest";
import { SNAP_TOLERANCE_PX, resolveMove, resolveTrim } from "./dragResolve";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { imageElement, videoElement, mulberry32 } from "../renderer/testing";
import { msToPxSigned, pxToMsSigned, spanEnd, spanStart } from "./geometry";
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
    tracks: [createTrack("v1", "video", 0), createTrack("v2", "video", 1)],
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
      ...over,
    });
  }

  it("reproduces the old integer rounding when quantization is off", () => {
    const base = doc({ a: imageElement({ trackId: "v1", startTime: 1000 }) });
    const plan = trim(base, { dxPx: 13, range: WIDE, quantize: false });
    expect(plan).toEqual({
      kind: "trim",
      trimMs: Math.round(pxToMsSigned(13, WIDE)),
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
