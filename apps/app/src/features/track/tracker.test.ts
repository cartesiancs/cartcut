import { describe, expect, it } from "vitest";
import type { GrayImage } from "./gray";
import {
  flatImage,
  makeTexture,
  occlude,
  relight,
  shift,
} from "./testFixtures";
import {
  DEFAULT_TRACK_OPTIONS,
  finishTracker,
  startTracker,
  stepTracker,
  trackSequence,
  type TrackFrame,
} from "./tracker";

const WIDTH = 320;
const HEIGHT = 240;

/** A run of frames each moved `(dx, dy)` further than the last. */
function pan(
  base: GrayImage,
  count: number,
  dx: number,
  dy: number,
  decorate: (image: GrayImage, index: number) => GrayImage = (image) => image,
): TrackFrame[] {
  const frames: TrackFrame[] = [];
  for (let i = 0; i < count; i++) {
    frames.push({
      sourceMs: i * 16,
      image: decorate(shift(base, dx * i, dy * i), i),
    });
  }
  return frames;
}

describe("trackSequence", () => {
  it("recovers a sub-pixel pan to within a third of a pixel", () => {
    const base = makeTexture(WIDTH, HEIGHT);
    const frames = pan(base, 24, 1.3, -0.7);

    const state = trackSequence(frames, { x: 160, y: 120 });

    expect(state.status).toBe("completed");
    expect(state.samples).toHaveLength(24);

    for (let i = 0; i < state.samples.length; i++) {
      const sample = state.samples[i];
      expect(Math.abs(sample.x - (160 + 1.3 * i))).toBeLessThan(0.3);
      expect(Math.abs(sample.y - (120 - 0.7 * i))).toBeLessThan(0.3);
    }
  });

  it("does not drift over a long run", () => {
    // The point of the fixed reference patch: frame 120's error must be of the
    // same order as frame 5's, not 24 times it.
    const base = makeTexture(WIDTH, HEIGHT, 3);
    const frames = pan(base, 120, 0.37, 0.21);

    const state = trackSequence(frames, { x: 100, y: 90 });
    const last = state.samples[state.samples.length - 1];

    expect(state.status).toBe("completed");
    expect(Math.abs(last.x - (100 + 0.37 * 119))).toBeLessThan(0.4);
    expect(Math.abs(last.y - (90 + 0.21 * 119))).toBeLessThan(0.4);
  });

  it("survives a shot that brightens", () => {
    // NCC subtracts the mean and divides by the magnitude, so a gain and a lift
    // are invisible to it. SSD would have followed the exposure instead.
    const base = makeTexture(WIDTH, HEIGHT, 11);
    const frames = pan(base, 20, 1.1, 0.4, (image, index) =>
      relight(image, 1 - index * 0.01, index * 3),
    );

    const state = trackSequence(frames, { x: 150, y: 130 });
    const last = state.samples[state.samples.length - 1];

    expect(state.status).toBe("completed");
    expect(Math.abs(last.x - (150 + 1.1 * 19))).toBeLessThan(0.5);
    expect(Math.abs(last.y - (130 + 0.4 * 19))).toBeLessThan(0.5);
  });

  it("gives up, and says where, when the feature is covered", () => {
    const base = makeTexture(WIDTH, HEIGHT, 5);
    const frames = pan(base, 30, 1, 0, (image, index) =>
      index >= 10 ? occlude(image, 160 + index, 120, 30) : image,
    );

    const state = trackSequence(frames, { x: 160, y: 120 });

    expect(state.status).toBe("lost");
    expect(state.lostAtMs).not.toBeNull();
    // Stopped near the occlusion rather than at the end of the clip.
    expect(state.samples.length).toBeGreaterThan(8);
    expect(state.samples.length).toBeLessThan(18);
  });

  it("keeps no sample it did not believe", () => {
    // The tolerance exists to ride out a frame or two of noise, not to claim
    // those frames were tracked. Every kept sample has to meet the threshold,
    // or the track ends with `lostFrameTolerance − 1` keyframes on whatever the
    // search drifted onto while the feature was hidden.
    const base = makeTexture(WIDTH, HEIGHT, 5);
    const frames = pan(base, 30, 1, 0, (image, index) =>
      index >= 10 ? occlude(image, 160 + index, 120, 30) : image,
    );

    const state = trackSequence(frames, { x: 160, y: 120 });
    const last = state.samples[state.samples.length - 1];

    expect(state.status).toBe("lost");
    for (const sample of state.samples) {
      expect(sample.confidence).toBeGreaterThanOrEqual(
        DEFAULT_TRACK_OPTIONS.confidenceThreshold,
      );
    }
    expect(state.lostAtMs).toBe(last.sourceMs);
  });

  it("keeps the seed even when it loses the feature immediately", () => {
    const base = makeTexture(WIDTH, HEIGHT, 5);
    const frames = pan(base, 8, 1, 0, (image, index) =>
      index >= 1 ? occlude(image, 160, 120, 40) : image,
    );

    const state = trackSequence(frames, { x: 160, y: 120 });

    expect(state.status).toBe("lost");
    expect(state.samples).toHaveLength(1);
    expect(state.samples[0].confidence).toBe(1);
  });

  it("refuses a seed with no texture, before running anything", () => {
    const frames = pan(flatImage(WIDTH, HEIGHT), 10, 1, 1);

    const state = trackSequence(frames, { x: 160, y: 120 });

    expect(state.status).toBe("no-texture");
    expect(state.samples).toHaveLength(0);
  });

  it("seeds its first sample exactly where the user pointed", () => {
    const frames = pan(makeTexture(WIDTH, HEIGHT), 4, 2, 2);

    const state = trackSequence(frames, { x: 77.5, y: 42.25 });

    expect(state.samples[0]).toEqual({
      sourceMs: 0,
      x: 77.5,
      y: 42.25,
      confidence: 1,
    });
  });
});

describe("stepTracker", () => {
  it("declines by identity once the run is over", () => {
    const base = makeTexture(WIDTH, HEIGHT);
    const frames = pan(base, 3, 1, 1);

    const done = finishTracker(trackSequence(frames, { x: 160, y: 120 }));

    expect(stepTracker(done, frames[1])).toBe(done);
  });

  it("declines by identity on a frame of a different size", () => {
    const state = startTracker(
      { sourceMs: 0, image: makeTexture(WIDTH, HEIGHT) },
      { x: 160, y: 120 },
    );

    const odd: TrackFrame = { sourceMs: 16, image: makeTexture(160, 120, 2) };

    expect(stepTracker(state, odd)).toBe(state);
  });

  it("can be folded one frame at a time, matching the whole-sequence run", () => {
    // The panel folds this live to draw the path as it goes; the suite folds
    // the array. Both must be the same tracker, not two.
    const base = makeTexture(WIDTH, HEIGHT, 9);
    const frames = pan(base, 12, 0.9, 1.4);

    let stepped = startTracker(frames[0], { x: 140, y: 100 });
    for (let i = 1; i < frames.length; i++) {
      stepped = stepTracker(stepped, frames[i]);
    }
    stepped = finishTracker(stepped);

    const atOnce = trackSequence(frames, { x: 140, y: 100 });

    expect(stepped.samples).toEqual(atOnce.samples);
  });
});
