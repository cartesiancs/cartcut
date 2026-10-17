import { describe, expect, it } from "vitest";
import { EXPORT_PRESETS, type ExportSettings } from "../settings";
import {
  encodePlanFor,
  h264BitrateForCrf,
  isWebExportable,
  packetBounds,
  webExportSettings,
} from "./encodeSettings";

const medium = EXPORT_PRESETS.medium;
const hd_ = (patch: Partial<ExportSettings>) => [with_(patch), hd] as const;
const with_ = (patch: Partial<ExportSettings>): ExportSettings => ({ ...medium, ...patch });
const hd = { width: 1920, height: 1080, fps: 30 };

describe("webExportSettings", () => {
  it("keeps every preset as it is: all three are H.264 + AAC in MP4", () => {
    for (const preset of Object.values(EXPORT_PRESETS)) {
      expect(webExportSettings(preset)).toEqual(preset);
      expect(isWebExportable(preset)).toBe(true);
    }
  });

  it("keeps VP9 + Opus in WebM", () => {
    const webm = with_({ container: "webm", videoCodec: "vp9", audioCodec: "opus", sampleRate: 48000 });
    expect(webExportSettings(webm)).toEqual(webm);
    expect(isWebExportable(webm)).toBe(true);
  });

  it("reads what a browser cannot write as the nearest thing it can", () => {
    const prores = with_({ container: "mov", videoCodec: "prores", audioCodec: "pcm_s16le" });
    expect(webExportSettings(prores)).toMatchObject({
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
    });
    expect(isWebExportable(prores)).toBe(false);

    const hevc = with_({ container: "mp4", videoCodec: "h265", audioCodec: "mp3" });
    expect(webExportSettings(hevc)).toMatchObject({ videoCodec: "h264", audioCodec: "aac" });

    const vorbis = with_({ container: "webm", videoCodec: "vp9", audioCodec: "vorbis", sampleRate: 44100 });
    expect(webExportSettings(vorbis)).toMatchObject({ audioCodec: "opus", sampleRate: 48000 });
  });

  it("turns a GIF into an MP4 and drops the GIF-only keys", () => {
    const gif = with_({ container: "gif", videoCodec: "gif", gifFps: 15, gifWidth: 480 });
    const read = webExportSettings(gif);
    expect(read).toMatchObject({ container: "mp4", videoCodec: "h264" });
    expect("gifFps" in read).toBe(false);
    expect("gifWidth" in read).toBe(false);
  });

  it("does not touch rate control, bitrates or channels", () => {
    const custom = with_({ qualityMode: "bitrate", videoBitrate: 8000, audioBitrate: 256, channels: 1 });
    expect(webExportSettings(custom)).toEqual(custom);
  });
});

describe("encodePlanFor", () => {
  it("turns an H.264 CRF into a bitrate, never a quantizer, so the hardware encoder takes it", () => {
    const plan = encodePlanFor(...hd_({ qualityMode: "crf", crf: 23, videoBitrate: 6000 }));
    expect(plan.video.quantizer).toBeUndefined();
    expect(plan.video.bitrate).toBe(h264BitrateForCrf(23, hd));
    expect(plan).toMatchObject({ container: "mp4", extension: "mp4", mimeType: "video/mp4" });
  });

  it("spends twice the rate for six CRF steps down, and keeps it in bounds", () => {
    expect(h264BitrateForCrf(23, hd)).toBe(6_220_800);
    expect(h264BitrateForCrf(17, hd) / h264BitrateForCrf(23, hd)).toBeCloseTo(2, 5);
    expect(h264BitrateForCrf(51, { width: 320, height: 240, fps: 10 })).toBe(500_000);
    expect(h264BitrateForCrf(0, { width: 7680, height: 4320, fps: 240 })).toBe(200_000_000);
  });

  it("targets a bitrate with no quantizer when asked to", () => {
    const plan = encodePlanFor(...hd_({ qualityMode: "bitrate", videoBitrate: 2500 }));
    expect(plan.video.quantizer).toBeUndefined();
    expect(plan.video.bitrate).toBe(2_500_000);
  });

  it("writes WebM with VP9 and Opus", () => {
    const plan = encodePlanFor(
      with_({ container: "webm", videoCodec: "vp9", audioCodec: "opus", sampleRate: 48000, crf: 31 }),
      hd,
    );
    expect(plan).toMatchObject({ container: "webm", extension: "webm", mimeType: "video/webm" });
    expect(plan.video).toMatchObject({ codec: "vp9", quantizer: 31 });
    expect(plan.audio).toMatchObject({ codec: "opus", sampleRate: 48000 });
  });

  it("carries the audio settings in bits per second", () => {
    expect(encodePlanFor(medium, hd).audio).toEqual({
      codec: "aac",
      bitrate: 192_000,
      sampleRate: 48000,
      channels: 2,
    });
  });

  it("asks for hardware only when the setting does", () => {
    expect(encodePlanFor(medium, hd).video.hardwareAcceleration).toBe("no-preference");
    expect(encodePlanFor(...hd_({ hardwareAccel: true })).video.hardwareAcceleration).toBe(
      "prefer-hardware",
    );
  });
});

describe("packetBounds", () => {
  it("bounds every frame and every audio codec frame with room to spare", () => {
    const bounds = packetBounds(600, 10, 48000);
    expect(bounds.video).toBeGreaterThanOrEqual(600);
    // AAC: 469 packets of 1024 samples in ten seconds; Opus: 500 of 960.
    expect(bounds.audio).toBeGreaterThanOrEqual(500);
  });
});
