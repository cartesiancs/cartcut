import { describe, it, expect } from "vitest";
import {
  PRELOAD_AHEAD_MS,
  PRELOAD_BEHIND_MS,
  RELEASE_AHEAD_MS,
  RELEASE_BEHIND_MS,
  decodersFor,
  loadWindow,
  releaseWindow,
  spanOverlaps,
} from "./decoderWindow";
import { audioElement, imageElement, videoElement } from "../renderer/testing";

function clip(startTime: number, duration: number, over = {}) {
  return videoElement({
    startTime,
    duration,
    speed: 1,
    trim: { startTime: 0, endTime: duration },
    sourceDuration: 600_000,
    trackId: "v1",
    ...over,
  });
}

describe("the windows", () => {
  it("puts the load window inside the release window", () => {
    for (const cursor of [0, 1000, 60_000, 146_000]) {
      const lw = loadWindow(cursor);
      const rw = releaseWindow(cursor);
      expect(rw.start).toBeLessThanOrEqual(lw.start);
      expect(rw.end).toBeGreaterThanOrEqual(lw.end);
    }
  });

  // The gap between them is the whole point: without it a playhead resting on a
  // clip boundary would load and release the same decoder on alternate frames.
  it("leaves hysteresis on both sides", () => {
    expect(RELEASE_BEHIND_MS).toBeGreaterThan(PRELOAD_BEHIND_MS);
    expect(RELEASE_AHEAD_MS).toBeGreaterThan(PRELOAD_AHEAD_MS);
  });

  it("leads the playhead rather than centring on it", () => {
    // Playback runs forwards, so what is coming matters more than what is gone.
    expect(PRELOAD_AHEAD_MS).toBeGreaterThan(PRELOAD_BEHIND_MS);
  });
});

describe("spanOverlaps", () => {
  it("is false for a clip that ends exactly where the window starts", () => {
    expect(spanOverlaps(clip(0, 1000), { start: 1000, end: 2000 })).toBe(false);
  });

  it("is false for a clip that starts exactly where the window ends", () => {
    expect(spanOverlaps(clip(2000, 1000), { start: 0, end: 2000 })).toBe(false);
  });

  it("is true for a clip that merely touches the interior", () => {
    expect(spanOverlaps(clip(1999, 1000), { start: 0, end: 2000 })).toBe(true);
  });

  // `spanOf` divides by speed, so a retimed clip occupies less timeline than its
  // duration suggests and the window has to agree with the compositor about it.
  it("uses the timeline span, not the source duration", () => {
    const fast = clip(0, 8000, { speed: 4 });
    expect(spanOverlaps(fast, { start: 3000, end: 4000 })).toBe(false);
    expect(spanOverlaps(fast, { start: 1000, end: 1500 })).toBe(true);
  });
});

describe("decodersFor", () => {
  it("keeps only video", () => {
    const t = {
      v: clip(0, 1000),
      i: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }),
      a: audioElement({ trackId: "a1", startTime: 0, duration: 1000 }),
    };
    const { load, keep } = decodersFor(t as any, 0);
    expect([...load]).toEqual(["v"]);
    expect([...keep]).toEqual(["v"]);
  });

  /**
   * The shape of the project that exposed the problem: many clips, few of them
   * anywhere near the playhead.
   */
  it("holds a handful of decoders for a long timeline", () => {
    const t: Record<string, any> = {};
    for (let i = 0; i < 12; i++) {
      t[`c${i}`] = clip(i * 12_000, 12_000);
    }

    const { load, keep } = decodersFor(t, 60_000);

    // Twelve clips spanning 144s; at 60s only the neighbours matter.
    expect(load.size).toBeLessThanOrEqual(2);
    expect(keep.size).toBeLessThanOrEqual(3);
    expect(load.has("c5")).toBe(true); // 60_000..72_000 — the one under the cursor
  });

  it("loads the next clip before the playhead reaches it", () => {
    const t = { a: clip(0, 5000), b: clip(5000, 5000) };
    // One second before the cut, `b` has not started yet but must be decoding.
    const { load } = decodersFor(t as any, 4000);
    expect(load.has("b")).toBe(true);
  });

  it("still holds the clip just left behind", () => {
    const t = { a: clip(0, 5000), b: clip(5000, 5000) };
    const { load, keep } = decodersFor(t as any, 5500);
    expect(load.has("a")).toBe(true);
    expect(keep.has("a")).toBe(true);
  });

  it("load is always a subset of keep", () => {
    const t: Record<string, any> = {};
    for (let i = 0; i < 12; i++) {
      t[`c${i}`] = clip(i * 3000, 3000);
    }
    for (let cursor = 0; cursor <= 40_000; cursor += 250) {
      const { load, keep } = decodersFor(t, cursor);
      for (const id of load) {
        expect(keep.has(id)).toBe(true);
      }
    }
  });

  /**
   * The property the hysteresis exists for, stated as a measurement: sweeping
   * the playhead across a cut must never ask for a decoder that was released on
   * the previous tick.
   */
  it("never releases a clip it is about to reload", () => {
    const t = { a: clip(0, 5000), b: clip(5000, 5000) };
    let held = new Set<string>();

    for (let cursor = 0; cursor <= 12_000; cursor += 100) {
      const { load, keep } = decodersFor(t as any, cursor);
      const next = new Set([...held].filter((id) => keep.has(id)));
      for (const id of load) {
        // Anything newly loaded must not have been dropped this same tick.
        expect(held.has(id) && !next.has(id)).toBe(false);
        next.add(id);
      }
      held = next;
    }
  });
});
