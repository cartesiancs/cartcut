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
import { frameToMs, isFrameAligned, msToFrame } from "./frames";
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
import { MAX_RANGE } from "./zoom";
import { imageElement, mulberry32 } from "../renderer/testing";

const RATES = [24, 25, 30, 60];

function doc(elements: Record<string, any>): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
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
