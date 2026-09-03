import { describe, expect, it } from "vitest";

import { alignAudioToVideo, MAX_ALIGN_MS, relativeOffsets } from "./trackAlign";

describe("alignAudioToVideo", () => {
  it("pads silence when the microphone started late", () => {
    const plan = alignAudioToVideo(1000, 1120, 48_000);

    expect(plan.offsetMs).toBe(120);
    expect(plan.padFrames).toBe(Math.round(0.12 * 48_000));
    expect(plan.trimFrames).toBe(0);
  });

  it("trims the front when the microphone started early", () => {
    const plan = alignAudioToVideo(1000, 940, 48_000);

    expect(plan.offsetMs).toBe(-60);
    expect(plan.trimFrames).toBe(Math.round(0.06 * 48_000));
    expect(plan.padFrames).toBe(0);
  });

  it("corrects nothing when they started together", () => {
    const plan = alignAudioToVideo(1000, 1000, 48_000);
    expect(plan).toMatchObject({ padFrames: 0, trimFrames: 0, clamped: false });
  });

  it("never pads and trims at once", () => {
    for (const audioT0 of [500, 900, 1000, 1100, 4000]) {
      const plan = alignAudioToVideo(1000, audioT0, 48_000);
      expect(plan.padFrames === 0 || plan.trimFrames === 0).toBe(true);
    }
  });

  // Past five seconds the two readings are not "slightly apart" — they are
  // evidence something never started, and padding would hide that.
  it("refuses a wild offset and says so", () => {
    const plan = alignAudioToVideo(0, MAX_ALIGN_MS + 1, 48_000);

    expect(plan.clamped).toBe(true);
    expect(plan.padFrames).toBe(0);
    expect(plan.trimFrames).toBe(0);
    expect(plan.offsetMs).toBe(MAX_ALIGN_MS + 1);
  });

  it("falls back to 48kHz for an unreadable sample rate", () => {
    expect(alignAudioToVideo(0, 100, 0).padFrames).toBe(4800);
    expect(alignAudioToVideo(0, 100, Number.NaN).padFrames).toBe(4800);
  });

  it("corrects nothing when either clock reading is missing", () => {
    expect(alignAudioToVideo(Number.NaN, 100, 48_000)).toMatchObject({
      padFrames: 0,
      trimFrames: 0,
    });
  });
});

describe("relativeOffsets", () => {
  it("measures everything from the earliest start", () => {
    expect(
      relativeOffsets({ screen: 1000, camera: 1350, mic: 1080 }),
    ).toEqual({ screen: 0, camera: 350, mic: 80 });
  });

  // A source that never started has no offset. Calling it simultaneous would
  // put its first frame at the top of the recording.
  it("drops a source that never reported a start", () => {
    const offsets = relativeOffsets({
      screen: 1000,
      camera: Number.NaN,
      mic: 1200,
    });

    expect(offsets).toEqual({ screen: 0, mic: 200 });
    expect("camera" in offsets).toBe(false);
  });

  it("answers nothing for nothing", () => {
    expect(relativeOffsets({})).toEqual({});
  });
});
