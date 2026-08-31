/**
 * The claim the whole feature rests on: what the editor writes is what the
 * exporter samples.
 *
 * `features/export/renderTimeline.ts` walks `currentFrame` from 0 and asks the
 * compositor what is visible at `(currentFrame / fps) * 1000`. Everything else
 * in this change — quantized drags, the lattice, the frame-based ruler — is
 * only worth anything if a clip the user aligned to frame `n` is first drawn on
 * iteration `n` of that loop, and for exactly as many iterations as it is long.
 *
 * These tests go through `isElementVisibleAtTime`, the predicate the compositor
 * actually calls, rather than re-deriving the arithmetic.
 */

import { describe, expect, it } from "vitest";
import { isElementVisibleAtTime } from "../element/time";
import {
  frameToMs,
  isFrameAligned,
  msToFrame,
  planFrameGrid,
} from "./frames";
import { resolveMove } from "./dragResolve";
import { moveClips, splitClip, trimClipStart } from "./clipOps";
import { spanOf } from "./geometry";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { TRACK_PITCH } from "./layout";
import { MAX_RANGE, maxRangeForFps } from "./zoom";
import { audioElement, imageElement, mulberry32 } from "../renderer/testing";
import { rebakeAnimations } from "../animation/keyframeOps";
import { bakeRateFor } from "../animation/keyframes";

const RATES = [24, 25, 30, 50, 60, 120];

function doc(elements: Record<string, any>): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0), createTrack("a1", "audio", 1)],
    elements,
  });
}

/** Exactly what `renderTimeline` computes for frame `n`. */
const sampleInstant = (frame: number, fps: number) => (frame / fps) * 1000;

/** Which frames of an export a clip is drawn on. */
function visibleFrames(
  element: any,
  fps: number,
  totalFrames: number,
): number[] {
  const frames: number[] = [];
  for (let frame = 0; frame < totalFrames; frame++) {
    if (isElementVisibleAtTime(sampleInstant(frame, fps), {} as any, element)) {
      frames.push(frame);
    }
  }
  return frames;
}

describe("a quantized edit lines up with the export", () => {
  it("draws the clip first on the frame it was aligned to", () => {
    for (const fps of RATES) {
      for (const startFrame of [0, 1, 7, 60, 137]) {
        const element = imageElement({
          trackId: "v1",
          startTime: frameToMs(startFrame, fps),
          duration: frameToMs(10, fps),
        });
        const frames = visibleFrames(element, fps, startFrame + 40);
        expect(frames[0]).toBe(startFrame);
      }
    }
  });

  it("draws it for exactly as many frames as it is long", () => {
    for (const fps of RATES) {
      for (const lengthFrames of [1, 2, 10, 47]) {
        const element = imageElement({
          trackId: "v1",
          startTime: frameToMs(30, fps),
          duration: frameToMs(lengthFrames, fps),
        });
        const frames = visibleFrames(element, fps, 30 + lengthFrames + 20);
        expect(frames.length).toBe(lengthFrames);
        expect(frames[frames.length - 1]).toBe(30 + lengthFrames - 1);
      }
    }
  });

  it("leaves no gap and no overlap between two halves of a cut", () => {
    // A frame that belongs to neither half is a frame of background in the
    // export; a frame claimed by both is a compositing order bug.
    const fps = 60;
    const base = doc({
      a: imageElement({
        trackId: "v1",
        startTime: frameToMs(10, fps),
        duration: frameToMs(60, fps),
      }),
    });
    const split = splitClip(base, "a", frameToMs(40, fps), "b");
    expect(split).not.toBe(base);

    const left = visibleFrames(split.elements.a, fps, 120);
    const right = visibleFrames(split.elements.b, fps, 120);

    expect(left.concat(right).sort((p, q) => p - q)).toEqual(
      Array.from({ length: 60 }, (_, i) => 10 + i),
    );
    expect(left.filter((f) => right.includes(f))).toEqual([]);
  });
});

describe("a drag survives the trip through the document", () => {
  it("keeps the picture on the grid when audio is dragged along with it", () => {
    // Audio is exempt from the grid (`frames.ts#isFrameLocked`), and this is
    // where that exemption has to stop: one gesture is one delta, so an audio
    // clip in the selection must not carry the picture off the instants the
    // exporter samples. Checked through `isElementVisibleAtTime` rather than by
    // asserting alignment, because being drawn on the right frames is the claim
    // alignment exists to serve.
    const fps = 60;
    const random = mulberry32(4242);
    const base = doc({
      v: imageElement({
        trackId: "v1",
        startTime: frameToMs(60, fps),
        duration: frameToMs(24, fps),
      }),
      a: audioElement({ trackId: "a1", startTime: 1988.888, duration: 2000 }),
    });
    const before = visibleFrames(base.elements.v, fps, 400);

    for (let i = 0; i < 100; i++) {
      const plan = resolveMove({
        base,
        primaryId: "a", // the *audio* is under the pointer — the harder direction
        dragIds: ["a", "v"],
        dxPx: (random() - 0.5) * 1200,
        dyPx: 0,
        free: false,
        range: MAX_RANGE,
        fps,
        playheadMs: -1_000_000,
        trackPitch: TRACK_PITCH,
      });
      if (plan.kind !== "move") continue;

      const next = moveClips(base, ["a", "v"], plan.appliedMs, 0);
      if (next === base) continue;

      // The picture lands a whole number of frames from where it was, and is
      // drawn on exactly as many export frames as before.
      const after = visibleFrames(next.elements.v, fps, 400);
      expect(after.length).toBe(before.length);
      expect(after[0] - before[0]).toBe(
        msToFrame(next.elements.v.startTime, fps) - 60,
      );
      expect(isFrameAligned(next.elements.v.startTime, fps)).toBe(true);
    }
  });

  it("stays on the grid after moveClips has applied it", () => {
    // `resolveMove` produces an exact target, but it reaches the element as
    // `startTime + (target - startTime)`, which IEEE-754 does not promise
    // equals `target`. This is where that would show up.
    const random = mulberry32(99);
    for (const fps of RATES) {
      const base = doc({
        a: imageElement({
          trackId: "v1",
          startTime: frameToMs(60, fps),
          duration: frameToMs(120, fps),
        }),
      });
      for (let i = 0; i < 100; i++) {
        const plan = resolveMove({
          base,
          primaryId: "a",
          dragIds: ["a"],
          dxPx: (random() - 0.5) * 1200,
          dyPx: 0,
          free: false,
          range: MAX_RANGE,
          fps,
          playheadMs: -1_000_000,
          trackPitch: TRACK_PITCH,
        });
        if (plan.kind !== "move") continue;

        const next = moveClips(base, ["a"], plan.appliedMs, 0);
        if (next === base) continue;

        const start = next.elements.a.startTime;
        expect(isFrameAligned(start, fps)).toBe(true);

        // And it is still drawn on its own frame, which is the point.
        const frame = msToFrame(start, fps);
        expect(
          isElementVisibleAtTime(
            sampleInstant(frame, fps),
            {} as any,
            next.elements.a as any,
          ),
        ).toBe(true);
      }
    }
  });

  it("keeps a trimmed edge on the grid", () => {
    const fps = 60;
    const base = doc({
      a: imageElement({
        trackId: "v1",
        startTime: frameToMs(60, fps),
        duration: frameToMs(120, fps),
      }),
    });
    const next = trimClipStart(base, "a", frameToMs(7, fps));
    expect(next).not.toBe(base);
    expect(isFrameAligned(spanOf(next.elements.a).start, fps)).toBe(true);
  });
});

describe("the last ULP", () => {
  /**
   * A real placement, found by search rather than invented: dragging a clip
   * from 455065.7043233514ms onto frame 6941 leaves it at 115683.33333333337,
   * which is 2.9e-11 ms *above* the instant the exporter samples for that
   * frame. Under a strict `t >= start` the clip is invisible on its own first
   * frame and the export is one frame short.
   */
  const fps = 60;
  const originalStart = 455065.7043233514;
  const targetFrame = 6941;
  const target = sampleInstant(targetFrame, fps);
  const landed = originalStart + (target - originalStart);

  it("really does land above the sampled instant", () => {
    expect(landed).toBeGreaterThan(target);
    expect(target >= landed).toBe(false);
  });

  it("is still drawn on its own frame", () => {
    const element = imageElement({
      trackId: "v1",
      startTime: landed,
      duration: frameToMs(10, fps),
    });
    expect(
      isElementVisibleAtTime(target, {} as any, element as any),
    ).toBe(true);
  });

  it("does not gain a frame at the other end", () => {
    // The slack shifts both edges, so the window's length is unchanged — a
    // clip cannot quietly claim one more frame than it is long.
    const element = imageElement({
      trackId: "v1",
      startTime: landed,
      duration: frameToMs(10, fps),
    });
    const frames = visibleFrames(element, fps, targetFrame + 40);
    expect(frames.length).toBe(10);
    expect(frames[0]).toBe(targetFrame);
  });
});

/**
 * What a frame-rate change does, and — more to the point — what it does not.
 *
 * A rate change is a change of grid, not a re-cut. Every clip keeps the
 * milliseconds it was authored with, so a project edited at 60 and switched to
 * 30 has clips off the new grid until they are next touched. That is the
 * behaviour every NLE has, and it is the only one that cannot lose work; the
 * alternative rewrites every boundary in the project on a settings change.
 */
describe("changing the project frame rate", () => {
  it("leaves every clip exactly where it was", () => {
    // `setProjectFps` puts one transform on the document — `rebakeAnimations` —
    // and this is what that transform is allowed to touch. Anything that moved
    // a `startTime`, a `duration` or a `trim` would be a re-cut the user never
    // asked for and cannot see coming.
    const before = doc({
      a: imageElement({ trackId: "v1", startTime: 1000, duration: 2000 }),
      b: imageElement({
        trackId: "v1",
        startTime: frameToMs(61, 60),
        duration: 1500,
      }),
    });

    for (const fps of RATES) {
      const after = rebakeAnimations(before, bakeRateFor(fps));
      for (const id of ["a", "b"]) {
        const was = before.elements[id] as any;
        const now = after.elements[id] as any;
        expect(now.startTime).toBe(was.startTime);
        expect(now.duration).toBe(was.duration);
        expect(now.trim).toEqual(was.trim);
        expect(spanOf(now)).toEqual(spanOf(was));
      }
    }
  });

  it("does not pretend a clip is aligned to a grid it was not authored on", () => {
    // 1016.6666…ms is frame 61 at 60fps and lands mid-frame at 30 and 24.
    const at60 = frameToMs(61, 60);
    expect(isFrameAligned(at60, 60)).toBe(true);
    expect(isFrameAligned(at60, 30)).toBe(false);
    expect(isFrameAligned(at60, 24)).toBe(false);
    // 120 is a multiple of 60, so a 60fps edit is already on its grid.
    expect(isFrameAligned(at60, 120)).toBe(true);
  });

  it("pulls an off-grid clip onto the new grid the next time it is dragged", () => {
    // Which is what makes the non-destructive choice liveable: the correction
    // happens under the user's hand, where they can see it.
    const authoredAt60 = frameToMs(61, 60);
    const base = doc({
      a: imageElement({
        trackId: "v1",
        startTime: authoredAt60,
        duration: 2000,
      }),
    });

    for (const fps of [24, 30, 120]) {
      const plan = resolveMove({
        base,
        primaryId: "a",
        dragIds: ["a"],
        // A nudge of a few pixels: enough to be a real gesture, not enough to
        // reach a neighbouring clip's edge and be captured by edge snapping.
        dxPx: 3,
        dyPx: 0,
        free: false,
        range: MAX_RANGE,
        fps,
        playheadMs: -1_000_000,
        trackPitch: TRACK_PITCH,
      });
      if (plan.kind !== "move") {
        continue;
      }
      const next = moveClips(base, ["a"], plan.appliedMs, 0);
      expect(next).not.toBe(base);
      expect(isFrameAligned((next.elements.a as any).startTime, fps)).toBe(true);
    }
  });

  it("still draws a clip on every export frame it covers, at 120fps", () => {
    const fps = 120;
    const start = frameToMs(37, fps);
    const element = imageElement({
      trackId: "v1",
      startTime: start,
      duration: frameToMs(48, fps),
    });
    const frames = visibleFrames(element, fps, 200);
    expect(frames[0]).toBe(37);
    expect(frames.length).toBe(48);
    expect(frames[frames.length - 1]).toBe(37 + 47);
  });

  it("keeps the frame grid drawable at the rate's own zoom ceiling", () => {
    // The ceiling moves with the rate precisely so this stays true; a fixed 60
    // would put a 120fps frame at 25px and a 240fps one at 12.5.
    for (const fps of [...RATES, 240]) {
      const grid = planFrameGrid({
        range: maxRangeForFps(fps),
        hScroll: 0,
        x0: 0,
        x1: 500,
        fps,
      });
      expect(grid.length).toBeGreaterThan(1);
      expect(grid[1] - grid[0]).toBeGreaterThanOrEqual(40);
    }
  });
});
