/**
 * Reading a clip's level, and turning it into something that can be played.
 *
 * Two exact values carry more weight than the arithmetic around them, and both
 * are asserted here rather than trusted:
 *
 *   - `gainOf` at 0 dB is exactly `1`. That is what lets `audioFilterFor` drop
 *     the `volume=` stage entirely, which in turn is what keeps every FFmpeg
 *     command for a project nobody has mixed byte-identical to the ones from
 *     before this field existed. If it drifts to 0.999999, every existing
 *     export changes and the pinned filter strings all break at once.
 *   - `gainOf` at the floor is exactly `0`, not the arithmetic 0.001. When the
 *     user pulls a fader to the bottom they mean silence, and 0.1% of a loud
 *     source is plainly audible.
 *
 * The defaulting matters as much as the conversion. Nothing migrates a project
 * on load, so "field absent" is the normal state for every clip in every file
 * written before this feature — it has to be indistinguishable from 0 dB
 * everywhere, or opening an old project changes how it sounds.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_VOLUME_DB,
  MAX_VOLUME_DB,
  MIN_VOLUME_DB,
  audioTwinOf,
  clampVolumeDb,
  gainOf,
  volumeDbOf,
} from "./audio";
import { audioElement, textElement, videoElement } from "../renderer/testing";

describe("clampVolumeDb", () => {
  it("passes a level inside the range through untouched", () => {
    expect(clampVolumeDb(-6)).toBe(-6);
    expect(clampVolumeDb(MIN_VOLUME_DB)).toBe(MIN_VOLUME_DB);
    expect(clampVolumeDb(MAX_VOLUME_DB)).toBe(MAX_VOLUME_DB);
  });

  it("pins a level outside the range to the nearest bound", () => {
    // The ceiling is not cosmetic: above 0 dB the preview caps at unity gain
    // and the export does not, so the two would disagree without saying so.
    expect(clampVolumeDb(5)).toBe(0);
    expect(clampVolumeDb(-100)).toBe(-60);
  });

  it("treats a value that is not a number at all as the default", () => {
    expect(clampVolumeDb(NaN)).toBe(DEFAULT_VOLUME_DB);
    expect(clampVolumeDb(Infinity)).toBe(DEFAULT_VOLUME_DB);
    expect(clampVolumeDb(-Infinity)).toBe(DEFAULT_VOLUME_DB);
  });
});

describe("volumeDbOf", () => {
  it("reads an authored level", () => {
    expect(volumeDbOf(audioElement({ volumeDb: -6 }))).toBe(-6);
    expect(volumeDbOf(videoElement({ volumeDb: -12 }))).toBe(-12);
  });

  it("defaults a clip that has never been touched to unity", () => {
    // The case every clip in every pre-feature project is in.
    expect(volumeDbOf(audioElement({}))).toBe(0);
    expect(volumeDbOf(videoElement({}))).toBe(0);
  });

  it("defaults rather than propagating a value it cannot use", () => {
    // A hand-edited project file, or an element caught mid-undo.
    expect(volumeDbOf(null)).toBe(0);
    expect(volumeDbOf(undefined)).toBe(0);
    expect(volumeDbOf(audioElement({ volumeDb: "-6" as any }))).toBe(0);
    expect(volumeDbOf(audioElement({ volumeDb: NaN }))).toBe(0);
  });

  it("clamps an out-of-range level instead of passing it on", () => {
    // Clamping on *read* is what keeps the preview and the export agreeing
    // even about garbage input, since both go through this function.
    expect(volumeDbOf(audioElement({ volumeDb: 12 }))).toBe(0);
    expect(volumeDbOf(audioElement({ volumeDb: -200 }))).toBe(-60);
  });
});

describe("gainOf", () => {
  it("is exactly 1 at unity", () => {
    // Load-bearing. `audioFilterFor` omits its stage on `gain !== 1`, so this
    // being 0.999999 would rewrite every export command in the app.
    expect(gainOf(audioElement({}))).toBe(1);
    expect(gainOf(audioElement({ volumeDb: 0 }))).toBe(1);
    expect(gainOf(videoElement({}))).toBe(1);
  });

  it("is exactly 0 at the floor, not the arithmetic 0.001", () => {
    expect(gainOf(audioElement({ volumeDb: MIN_VOLUME_DB }))).toBe(0);
    // Below the floor is clamped to it, and is still silence.
    expect(gainOf(audioElement({ volumeDb: -200 }))).toBe(0);
  });

  it("converts decibels to a linear multiplier", () => {
    // -6 dB is the familiar "half the amplitude" point.
    expect(gainOf(audioElement({ volumeDb: -6 }))).toBe(0.501187);
    expect(gainOf(audioElement({ volumeDb: -20 }))).toBe(0.1);
  });

  it("rises monotonically across the range", () => {
    const levels = [-60, -48, -36, -24, -12, -6, -3, 0];
    const gains = levels.map((volumeDb) => gainOf(audioElement({ volumeDb })));
    for (let i = 1; i < gains.length; i += 1) {
      expect(gains[i]).toBeGreaterThan(gains[i - 1]);
    }
    expect(gains.at(0)).toBe(0);
    expect(gains.at(-1)).toBe(1);
  });

  it("stays inside 0..1 for every level", () => {
    for (let db = -70; db <= 10; db += 1) {
      const gain = gainOf(audioElement({ volumeDb: db }));
      expect(gain).toBeGreaterThanOrEqual(0);
      expect(gain).toBeLessThanOrEqual(1);
    }
  });

  it("returns the same double every call", () => {
    // `applyIntent` writes `handle.volume` only when it differs from the
    // intent, and it recomputes this every animation frame for every loaded
    // clip. An unrounded value that varied in its last bits would make that
    // guard fire forever.
    const element = audioElement({ volumeDb: -13.7 });
    const first = gainOf(element);
    for (let i = 0; i < 10; i += 1) {
      expect(gainOf(element)).toBe(first);
    }
  });

  it("leaves a clip that makes no sound at unity", () => {
    // Not silence: a text clip has no level, and reporting 0 would read as
    // "turned down" to anything that looked.
    expect(gainOf(textElement({}))).toBe(1);
  });
});

describe("audioTwinOf", () => {
  it("carries the level onto the detached clip", () => {
    // The level is a property of the sound, so it goes where the sound goes.
    const twin = audioTwinOf(videoElement({ volumeDb: -9 }) as any);
    expect(twin.volumeDb).toBe(-9);
    expect(gainOf(twin)).toBe(gainOf(videoElement({ volumeDb: -9 })));
  });

  it("leaves the field absent when the video never had one", () => {
    // `JSON.stringify` drops an undefined field, so a detached clip stays
    // indistinguishable from an imported one in the saved project.
    const twin = audioTwinOf(videoElement({}) as any);
    expect(twin.volumeDb).toBeUndefined();
    expect(volumeDbOf(twin)).toBe(0);
  });
});
