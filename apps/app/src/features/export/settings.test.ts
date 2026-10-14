import { describe, expect, it } from "vitest";
import {
  AUDIO_SAMPLE_RATES,
  CODEC_CONTAINERS,
  CONTAINERS,
  CONTAINER_AUDIO_CODECS,
  CONTAINER_VIDEO_CODECS,
  CRF_RANGE,
  DEFAULT_EXPORT_SETTINGS,
  EXPORT_PRESETS,
  GIF_DEFAULT_FPS,
  GIF_DEFAULT_WIDTH,
  PRESET_NAMES,
  VIDEO_CODECS,
  describeExportSettings,
  detectPreset,
  normalizeExportSettings,
  type ExportSettings,
} from "./settings";

describe("the compatibility matrix", () => {
  it("gives every video codec somewhere to live", () => {
    for (const codec of VIDEO_CODECS) {
      expect(CODEC_CONTAINERS[codec].length).toBeGreaterThan(0);
    }
  });

  it("gives every container a video codec, and every one but GIF an audio codec", () => {
    for (const container of CONTAINERS) {
      expect(CONTAINER_VIDEO_CODECS[container].length).toBeGreaterThan(0);
      if (container === "gif") {
        // A GIF has no sound to encode.
        expect(CONTAINER_AUDIO_CODECS[container]).toEqual([]);
      } else {
        expect(CONTAINER_AUDIO_CODECS[container].length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps CODEC_CONTAINERS and CONTAINER_VIDEO_CODECS mutual inverses", () => {
    for (const codec of VIDEO_CODECS) {
      for (const container of CODEC_CONTAINERS[codec]) {
        expect(CONTAINER_VIDEO_CODECS[container]).toContain(codec);
      }
    }
    for (const container of CONTAINERS) {
      for (const codec of CONTAINER_VIDEO_CODECS[container]) {
        expect(CODEC_CONTAINERS[codec]).toContain(container);
      }
    }
  });

  it("offers only sample rates each audio codec actually accepts", () => {
    for (const container of CONTAINERS) {
      for (const audioCodec of CONTAINER_AUDIO_CODECS[container]) {
        expect(AUDIO_SAMPLE_RATES[audioCodec].length).toBeGreaterThan(0);
      }
    }
  });
});

describe("normalizeExportSettings", () => {
  it("leaves every shipped preset untouched", () => {
    for (const name of PRESET_NAMES) {
      expect(normalizeExportSettings(EXPORT_PRESETS[name])).toEqual(
        EXPORT_PRESETS[name],
      );
    }
  });

  it("falls back to the defaults for junk input", () => {
    expect(normalizeExportSettings(undefined)).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(normalizeExportSettings(null)).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(normalizeExportSettings({})).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(
      normalizeExportSettings({ videoCodec: "av1" as any }),
    ).toEqual(DEFAULT_EXPORT_SETTINGS);
  });

  it("drags the container along when the video codec cannot live there", () => {
    expect(
      normalizeExportSettings({ videoCodec: "vp9", container: "mp4" }).container,
    ).toBe("webm");
    expect(
      normalizeExportSettings({ videoCodec: "prores", container: "mp4" })
        .container,
    ).toBe("mov");
  });

  it("keeps a container the codec does support", () => {
    expect(
      normalizeExportSettings({ videoCodec: "h264", container: "mov" }).container,
    ).toBe("mov");
  });

  it("swaps the audio codec when the container will not carry it", () => {
    const webm = normalizeExportSettings({
      videoCodec: "vp9",
      audioCodec: "aac",
    });
    expect(webm.audioCodec).toBe("opus");

    const backToMp4 = normalizeExportSettings({
      ...webm,
      videoCodec: "h264",
      container: "mp4",
    });
    expect(backToMp4.audioCodec).toBe("aac");
  });

  it("pins Opus to 48 kHz however the sample rate was asked for", () => {
    expect(
      normalizeExportSettings({
        videoCodec: "vp9",
        audioCodec: "opus",
        sampleRate: 44100,
      }).sampleRate,
    ).toBe(48000);
  });

  it("clamps CRF to the range of the chosen codec", () => {
    expect(normalizeExportSettings({ videoCodec: "vp9", crf: 63 }).crf).toBe(63);
    expect(normalizeExportSettings({ videoCodec: "h264", crf: 63 }).crf).toBe(
      CRF_RANGE.h264.max,
    );
    expect(normalizeExportSettings({ videoCodec: "h264", crf: -5 }).crf).toBe(
      CRF_RANGE.h264.min,
    );
    expect(
      normalizeExportSettings({ videoCodec: "h264", crf: NaN }).crf,
    ).toBe(DEFAULT_EXPORT_SETTINGS.crf);
  });

  it("keeps the rate settings through ProRes and GIF, which ignore them", () => {
    // Pinning them used to send h264 -> ProRes -> h264 back as CRF 0, lossless.
    for (const codec of ["prores", "gif"] as const) {
      const h264 = normalizeExportSettings({ videoCodec: "h264", qualityMode: "crf", crf: 21 });
      const away = normalizeExportSettings({ ...h264, videoCodec: codec });
      const back = normalizeExportSettings({ ...away, videoCodec: "h264", container: "mp4" });
      expect(back.qualityMode).toBe("crf");
      expect(back.crf).toBe(21);
    }
    expect(normalizeExportSettings({ videoCodec: "prores", qualityMode: "crf" }).container).toBe("mov");
  });

  it("clamps the ProRes profile to the six that exist", () => {
    expect(
      normalizeExportSettings({ videoCodec: "prores", proresProfile: 9 })
        .proresProfile,
    ).toBe(5);
    expect(
      normalizeExportSettings({ videoCodec: "prores", proresProfile: -1 })
        .proresProfile,
    ).toBe(0);
  });

  it("repairs nonsense bitrates and channel counts", () => {
    expect(normalizeExportSettings({ videoBitrate: 0 }).videoBitrate).toBe(
      DEFAULT_EXPORT_SETTINGS.videoBitrate,
    );
    expect(normalizeExportSettings({ videoBitrate: -1 }).videoBitrate).toBe(
      DEFAULT_EXPORT_SETTINGS.videoBitrate,
    );
    expect(normalizeExportSettings({ audioBitrate: NaN }).audioBitrate).toBe(
      DEFAULT_EXPORT_SETTINGS.audioBitrate,
    );
    expect(normalizeExportSettings({ channels: 1 }).channels).toBe(1);
    expect(normalizeExportSettings({ channels: 7 as any }).channels).toBe(2);
  });

  it("is idempotent", () => {
    const once = normalizeExportSettings({
      videoCodec: "vp9",
      container: "mp4",
      audioCodec: "aac",
      sampleRate: 44100,
      crf: 99,
    });
    expect(normalizeExportSettings(once)).toEqual(once);
  });
});

describe("detectPreset", () => {
  it("round-trips each shipped preset", () => {
    for (const name of PRESET_NAMES) {
      expect(detectPreset(EXPORT_PRESETS[name])).toBe(name);
    }
  });

  it("reports custom as soon as any single field differs", () => {
    const base = EXPORT_PRESETS.medium;
    const alternatives: Partial<ExportSettings>[] = [
      { container: "mov" },
      { videoCodec: "h265" },
      { qualityMode: "bitrate" },
      { crf: 24 },
      { preset: "slow" },
      { videoBitrate: 6000 },
      { proresProfile: 2 },
      { audioCodec: "mp3" },
      { audioBitrate: 256 },
      { sampleRate: 44100 },
      { channels: 1 },
    ];

    for (const patch of alternatives) {
      // Normalizing keeps the variant legal, so anything still reported as a
      // preset here would be a genuine collision rather than a repair artifact.
      const variant = normalizeExportSettings({ ...base, ...patch });
      if (JSON.stringify(variant) === JSON.stringify(base)) {
        continue;
      }
      expect(detectPreset(variant)).toBe("custom");
    }
  });
});

describe("describeExportSettings", () => {
  it("summarises a constant-quality H.264 export", () => {
    expect(describeExportSettings(EXPORT_PRESETS.medium)).toBe(
      "H.264 MP4 CRF 23 AAC 192k",
    );
  });

  it("shows the bitrate instead when that is the mode", () => {
    const settings = normalizeExportSettings({
      ...EXPORT_PRESETS.medium,
      qualityMode: "bitrate",
    });
    expect(describeExportSettings(settings)).toBe("H.264 MP4 5000k AAC 192k");
  });

  it("names the ProRes profile and drops the bitrate for PCM", () => {
    const settings = normalizeExportSettings({
      videoCodec: "prores",
      proresProfile: 3,
      audioCodec: "pcm_s16le",
    });
    expect(describeExportSettings(settings)).toBe(
      "ProRes MOV 422 HQ PCM (16-bit)",
    );
  });
});

describe("GIF", () => {
  it("follows the GIF codec to the GIF container with its own defaults", () => {
    const gif = normalizeExportSettings({ videoCodec: "gif" });
    expect(gif.container).toBe("gif");
    expect(gif.gifFps).toBe(GIF_DEFAULT_FPS);
    expect(gif.gifWidth).toBe(GIF_DEFAULT_WIDTH);
  });

  it("keeps the audio settings as they were, unused, for the way back", () => {
    const gif = normalizeExportSettings({
      videoCodec: "gif",
      audioCodec: "mp3",
      sampleRate: 44100,
    });
    expect(gif.audioCodec).toBe("mp3");
    const back = normalizeExportSettings({ ...gif, videoCodec: "h264", container: "mp4" });
    expect(back.audioCodec).toBe("mp3");
    expect(back.sampleRate).toBe(44100);
  });

  it("stores the GIF options only while the container is GIF", () => {
    // A project that never exported a GIF has to save byte-identically to one
    // written before GIF existed, so the keys are not merely undefined.
    expect(Object.keys(DEFAULT_EXPORT_SETTINGS)).not.toContain("gifFps");
    const gif = normalizeExportSettings({ videoCodec: "gif", gifFps: 25, gifWidth: 640 });
    expect(gif).toMatchObject({ gifFps: 25, gifWidth: 640 });
    const back = normalizeExportSettings({ ...gif, videoCodec: "vp9" });
    expect(Object.keys(back)).not.toContain("gifFps");
    expect(Object.keys(back)).not.toContain("gifWidth");
  });

  it("snaps a frame rate or width it does not offer to the default", () => {
    const gif = normalizeExportSettings({ videoCodec: "gif", gifFps: 60, gifWidth: 333 });
    expect(gif.gifFps).toBe(GIF_DEFAULT_FPS);
    expect(gif.gifWidth).toBe(GIF_DEFAULT_WIDTH);
    expect(normalizeExportSettings({ videoCodec: "gif", gifWidth: 0 }).gifWidth).toBe(0);
  });

  it("is idempotent and is never a preset", () => {
    const gif = normalizeExportSettings({ videoCodec: "gif", gifFps: 10 });
    expect(normalizeExportSettings(gif)).toEqual(gif);
    expect(detectPreset(gif)).toBe("custom");
  });

  it("summarises size and rate, and no sound", () => {
    expect(describeExportSettings(normalizeExportSettings({ videoCodec: "gif" }))).toBe(
      "GIF 480px 15 fps",
    );
    expect(
      describeExportSettings(normalizeExportSettings({ videoCodec: "gif", gifWidth: 0, gifFps: 30 })),
    ).toBe("GIF Original 30 fps");
  });
});
