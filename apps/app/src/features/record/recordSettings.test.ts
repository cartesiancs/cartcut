import { describe, expect, it } from "vitest";

import {
  applyRecordSettings,
  DEFAULT_RECORD_SETTINGS,
  effectiveSystemAudio,
  MAX_RECORD_FPS,
  normalizeRecordFps,
  normalizeRecordSettings,
  systemAudioSupported,
  type RecordSettings,
} from "./recordSettings";

describe("normalizeRecordSettings", () => {
  it("reads nothing at all as the defaults", () => {
    expect(normalizeRecordSettings(undefined)).toEqual(DEFAULT_RECORD_SETTINGS);
    expect(normalizeRecordSettings(null)).toEqual(DEFAULT_RECORD_SETTINGS);
    expect(normalizeRecordSettings({})).toEqual(DEFAULT_RECORD_SETTINGS);
  });

  // The guard runs on whatever is on disk, including a file written by hand or
  // by a build that spelled a value differently. It must never throw.
  it("survives every wrong type without throwing", () => {
    const settings = normalizeRecordSettings({
      screenSourceId: 42,
      cameraDeviceId: null,
      micDeviceId: { id: "x" },
      systemAudio: "yes",
      quality: "4k",
      fps: "thirty",
      bubbleCorner: "middle",
      bubbleShape: [],
      bubbleSize: 3,
      autoZoom: true,
      drawing: 1,
      clickHighlight: "off",
    });

    expect(settings).toEqual(DEFAULT_RECORD_SETTINGS);
  });

  it("keeps the fields it can read and defaults only the rest", () => {
    const settings = normalizeRecordSettings({
      cameraDeviceId: "cam-1",
      quality: "720p",
      fps: 60,
      autoZoom: "strong",
      bubbleShape: "nonsense",
    });

    expect(settings.cameraDeviceId).toBe("cam-1");
    expect(settings.quality).toBe("720p");
    expect(settings.fps).toBe(60);
    expect(settings.autoZoom).toBe("strong");
    expect(settings.bubbleShape).toBe(DEFAULT_RECORD_SETTINGS.bubbleShape);
  });
});

describe("normalizeRecordFps", () => {
  it("rounds to whole frames", () => {
    expect(normalizeRecordFps(29.7)).toBe(30);
  });

  // Integers only, for the reason `frames.ts` gives about the NTSC family.
  it("refuses a rate outside the band rather than clamping to it", () => {
    expect(normalizeRecordFps(0)).toBe(DEFAULT_RECORD_SETTINGS.fps);
    expect(normalizeRecordFps(MAX_RECORD_FPS + 1)).toBe(
      DEFAULT_RECORD_SETTINGS.fps,
    );
    expect(normalizeRecordFps(Number.NaN)).toBe(DEFAULT_RECORD_SETTINGS.fps);
  });
});

describe("applyRecordSettings", () => {
  const base: RecordSettings = {
    ...DEFAULT_RECORD_SETTINGS,
    cameraDeviceId: "cam-1",
    fps: 30,
  };

  // The decline contract every pure op in this codebase follows: no change
  // means the input object, by identity, so the tray rebuilds no menu.
  it("returns its input by identity when nothing changed", () => {
    expect(applyRecordSettings(base, {})).toBe(base);
    expect(applyRecordSettings(base, { fps: 30 })).toBe(base);
    expect(applyRecordSettings(base, { cameraDeviceId: "cam-1" })).toBe(base);
  });

  it("returns a new object when something did", () => {
    const next = applyRecordSettings(base, { fps: 60 });
    expect(next).not.toBe(base);
    expect(next.fps).toBe(60);
    expect(base.fps).toBe(30);
  });

  it("ignores undefined rather than treating it as a value", () => {
    expect(applyRecordSettings(base, { cameraDeviceId: undefined })).toBe(base);
  });

  // A bad write leaves the good setting alone. Resetting to the default would
  // lose a working camera because something sent a typo.
  it("keeps the current value when the patch is unusable", () => {
    expect(applyRecordSettings(base, { fps: 500 })).toBe(base);
    expect(applyRecordSettings(base, { fps: 29.5 } as any)).toBe(base);
    expect(applyRecordSettings(base, { quality: "8k" } as any)).toBe(base);
    expect(applyRecordSettings(base, { autoZoom: "medium" } as any)).toBe(base);
  });

  it("accepts an empty device id, which is how a source is turned off", () => {
    const next = applyRecordSettings(base, { cameraDeviceId: "" });
    expect(next.cameraDeviceId).toBe("");
  });
});

describe("system audio", () => {
  // Electron 33's `Streams.audio`: "currently only supported on Windows".
  it("is capturable on Windows and nowhere else", () => {
    expect(systemAudioSupported("win32")).toBe(true);
    expect(systemAudioSupported("darwin")).toBe(false);
    expect(systemAudioSupported("linux")).toBe(false);
  });

  // The preference is stored on every platform so it survives a move between
  // machines; only what actually gets captured is gated.
  it("stays stored on macOS but does not take effect", () => {
    const wanted: RecordSettings = {
      ...DEFAULT_RECORD_SETTINGS,
      systemAudio: true,
    };
    expect(effectiveSystemAudio(wanted, "darwin")).toBe(false);
    expect(effectiveSystemAudio(wanted, "win32")).toBe(true);
  });
});
