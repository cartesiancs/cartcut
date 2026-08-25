import { describe, it, expect } from "vitest";
import { setClipSpeed, MIN_SPEED, MAX_SPEED } from "./speedOps";
import { assertTrimInvariant, spanOf, speedOf } from "./geometry";
import { createTrack, normalizeDocument, SCHEMA_VERSION } from "./tracks";
import { videoElement, imageElement, audioElement } from "../renderer/testing";

function doc(elements: Record<string, any>, tracks = [["v1", "video"]] as any) {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: tracks.map(([id, kind]: any, index: number) =>
      createTrack(id, kind, index),
    ),
    elements,
  });
}

/** A ten-second video clip starting at `startTime`, on `v1`. */
function clip(startTime: number, durationMs = 10_000, over: any = {}) {
  return videoElement({
    trackId: "v1",
    startTime,
    duration: durationMs,
    sourceDuration: durationMs,
    trim: { startTime: 0, endTime: durationMs },
    speed: 1,
    ...over,
  });
}

describe("setClipSpeed", () => {
  it("halves the timeline span at 2x without touching the source window", () => {
    const before = doc({ a: clip(0) });
    const after = setClipSpeed(before, "a", 2);

    expect(spanOf(after.elements.a).length).toBe(5_000);
    // The source window is untouched: none of the footage is lost.
    expect(after.elements.a.duration).toBe(10_000);
    expect((after.elements.a as any).trim).toEqual({
      startTime: 0,
      endTime: 10_000,
    });
    expect(speedOf(after.elements.a)).toBe(2);
  });

  it("keeps the trim invariant, which is the one speed must not break", () => {
    const after = setClipSpeed(doc({ a: clip(0) }), "a", 0.5);
    expect(() => assertTrimInvariant(after.elements.a)).not.toThrow();
  });

  it("doubles the span at 0.5x", () => {
    const after = setClipSpeed(doc({ a: clip(0) }), "a", 0.5);
    expect(spanOf(after.elements.a).length).toBe(20_000);
  });

  // ------------------------------------------------------- decline by identity

  it("returns the input by identity for a missing clip", () => {
    const before = doc({ a: clip(0) });
    expect(setClipSpeed(before, "nope", 2)).toBe(before);
  });

  it("returns the input by identity for a clip with no source window", () => {
    const before = doc({ a: imageElement({ trackId: "v1" }) });
    expect(setClipSpeed(before, "a", 2)).toBe(before);
  });

  it("returns the input by identity when the speed is unchanged", () => {
    const before = doc({ a: clip(0) });
    expect(setClipSpeed(before, "a", 1)).toBe(before);
  });

  it("returns the input by identity for a speed out of range", () => {
    const before = doc({ a: clip(0) });
    expect(setClipSpeed(before, "a", MIN_SPEED / 2)).toBe(before);
    expect(setClipSpeed(before, "a", MAX_SPEED * 2)).toBe(before);
    expect(setClipSpeed(before, "a", 0)).toBe(before);
    expect(setClipSpeed(before, "a", -1)).toBe(before);
    expect(setClipSpeed(before, "a", Number.NaN)).toBe(before);
  });

  it("returns the input by identity when slowing down would overlap the next clip", () => {
    // `a` runs 0-10000, `b` starts right after. At 0.5x, `a` would run to
    // 20000 and swallow `b`.
    const before = doc({ a: clip(0), b: clip(10_000) });
    expect(setClipSpeed(before, "a", 0.5, { ripple: false })).toBe(before);
  });

  it("speeds a clip up without ripple when the gap it leaves is free", () => {
    const before = doc({ a: clip(0), b: clip(10_000) });
    const after = setClipSpeed(before, "a", 2, { ripple: false });

    expect(after).not.toBe(before);
    expect(spanOf(after.elements.a).length).toBe(5_000);
    // Without ripple the later clip stays exactly where it was.
    expect(after.elements.b.startTime).toBe(10_000);
  });

  // -------------------------------------------------------------------- ripple

  it("pushes later clips on the same track along when slowing down", () => {
    const before = doc({ a: clip(0), b: clip(10_000) });
    const after = setClipSpeed(before, "a", 0.5, { ripple: true });

    expect(spanOf(after.elements.a).length).toBe(20_000);
    // `b` moved by exactly what `a` grew.
    expect(after.elements.b.startTime).toBe(20_000);
  });

  it("closes the gap when speeding up", () => {
    const before = doc({ a: clip(0), b: clip(10_000) });
    const after = setClipSpeed(before, "a", 2, { ripple: true });

    expect(after.elements.b.startTime).toBe(5_000);
  });

  it("is lane-local: a clip on another track does not move", () => {
    const before = doc(
      { a: clip(0), other: clip(10_000, 10_000, { trackId: "v2" }) },
      [
        ["v1", "video"],
        ["v2", "video"],
      ],
    );
    const after = setClipSpeed(before, "a", 0.5, { ripple: true });

    expect(after.elements.other.startTime).toBe(10_000);
  });

  it("leaves earlier clips alone", () => {
    const before = doc({ early: clip(0), a: clip(10_000) });
    const after = setClipSpeed(before, "a", 0.5, { ripple: true });

    expect(after.elements.early.startTime).toBe(0);
    expect(after.elements.a.startTime).toBe(10_000);
  });

  it("works on audio, which carries a source window too", () => {
    const before = doc(
      {
        a: audioElement({
          trackId: "a1",
          startTime: 0,
          duration: 8_000,
          sourceDuration: 8_000,
          trim: { startTime: 0, endTime: 8_000 },
          speed: 1,
        }),
      },
      [["a1", "audio"]],
    );
    const after = setClipSpeed(before, "a", 2);
    expect(spanOf(after.elements.a).length).toBe(4_000);
  });

  it("can be set back to 1", () => {
    const fast = setClipSpeed(doc({ a: clip(0) }), "a", 2);
    const back = setClipSpeed(fast, "a", 1);

    expect(speedOf(back.elements.a)).toBe(1);
    expect(spanOf(back.elements.a).length).toBe(10_000);
  });
});
