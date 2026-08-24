import { describe, expect, it } from "vitest";

// Reaching across the rootDir boundary is safe here and nowhere else: test files
// are excluded from the Electron tsc pass, so importing the renderer copy cannot
// widen `rootDir` and relocate the build.
import * as renderer from "../../apps/app/src/features/export/settings";
import * as main from "./exportSettings";

import {
  AUDIO_CODECS,
  DEFAULT_EXPORT_SETTINGS,
  LEGACY_EXPORT_SETTINGS,
  VIDEO_CODECS,
  audioOutputArgs,
  containerOutputArgs,
  normalizeExportSettings,
  pixelFormatFor,
  resolveExportSettings,
  videoOutputArgs,
} from "./exportSettings";

/** Reads the value FFmpeg would see for a flag, or undefined if it is absent. */
const valueOf = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

describe("the main-process mirror", () => {
  it("matches the renderer's settings vocabulary exactly", () => {
    expect(main.DEFAULT_EXPORT_SETTINGS).toEqual(renderer.DEFAULT_EXPORT_SETTINGS);
    expect(main.EXPORT_PRESETS).toEqual(renderer.EXPORT_PRESETS);
    expect(main.CODEC_CONTAINERS).toEqual(renderer.CODEC_CONTAINERS);
    expect(main.CONTAINER_VIDEO_CODECS).toEqual(renderer.CONTAINER_VIDEO_CODECS);
    expect(main.CONTAINER_AUDIO_CODECS).toEqual(renderer.CONTAINER_AUDIO_CODECS);
    expect(main.AUDIO_SAMPLE_RATES).toEqual(renderer.AUDIO_SAMPLE_RATES);
    expect(main.CRF_RANGE).toEqual(renderer.CRF_RANGE);
    expect(main.CODEC_SUPPORTS_CRF).toEqual(renderer.CODEC_SUPPORTS_CRF);
    expect(main.CONTAINERS).toEqual(renderer.CONTAINERS);
    expect(main.VIDEO_CODECS).toEqual(renderer.VIDEO_CODECS);
    expect(main.AUDIO_CODECS).toEqual(renderer.AUDIO_CODECS);
    expect(main.ENCODE_PRESETS).toEqual(renderer.ENCODE_PRESETS);
  });

  it("normalizes identically to the renderer copy", () => {
    const inputs: any[] = [
      undefined,
      {},
      { videoCodec: "vp9", container: "mp4", audioCodec: "aac" },
      { videoCodec: "prores", qualityMode: "crf", proresProfile: 9 },
      { videoCodec: "h264", crf: 99, channels: 1, sampleRate: 12345 },
      { videoCodec: "av1", preset: "turbo" },
    ];

    for (const input of inputs) {
      expect(main.normalizeExportSettings(input)).toEqual(
        renderer.normalizeExportSettings(input),
      );
    }
  });

  it("has an encoder name for every codec it offers", () => {
    for (const codec of VIDEO_CODECS) {
      expect(main.VIDEO_ENCODERS[codec]).toBeTruthy();
    }
    for (const codec of AUDIO_CODECS) {
      expect(main.AUDIO_ENCODERS[codec]).toBeTruthy();
    }
  });

  it("maps every encode preset onto a VP9 cpu-used level", () => {
    for (const preset of main.ENCODE_PRESETS) {
      expect(main.VP9_CPU_USED[preset]).toBeTypeOf("number");
    }
  });
});

describe("resolveExportSettings", () => {
  it("reads a legacy options object as bitrate-mode H.264", () => {
    const settings = resolveExportSettings({
      videoDuration: 10,
      videoBitrate: 4000,
      videoDestination: "/tmp/out.mp4",
    });

    expect(settings.videoCodec).toBe("h264");
    expect(settings.qualityMode).toBe("bitrate");
    expect(settings.videoBitrate).toBe(4000);
    expect(settings.container).toBe("mp4");
    expect(settings.audioCodec).toBe(LEGACY_EXPORT_SETTINGS.audioCodec);
    expect(settings.sampleRate).toBe(LEGACY_EXPORT_SETTINGS.sampleRate);
  });

  it("infers the legacy container from the destination extension", () => {
    expect(
      resolveExportSettings({ videoDestination: "/tmp/out.mov" }).container,
    ).toBe("mov");
    // An unknown extension is not a reason to guess; fall back to the legacy mp4.
    expect(
      resolveExportSettings({ videoDestination: "/tmp/out.mkv" }).container,
    ).toBe("mp4");
    expect(resolveExportSettings({}).container).toBe("mp4");
  });

  it("prefers exportSettings.videoBitrate over the legacy mirror", () => {
    const settings = resolveExportSettings({
      videoBitrate: 4000,
      exportSettings: { qualityMode: "bitrate", videoBitrate: 9000 },
    });
    expect(settings.videoBitrate).toBe(9000);
  });

  it("falls back to the legacy mirror when the settings omit a bitrate", () => {
    const settings = resolveExportSettings({
      videoBitrate: 4000,
      exportSettings: { qualityMode: "bitrate" },
    });
    expect(settings.videoBitrate).toBe(4000);
  });

  it("uses the modern defaults once exportSettings is present at all", () => {
    expect(resolveExportSettings({ exportSettings: {} })).toEqual(
      DEFAULT_EXPORT_SETTINGS,
    );
  });

  it("repairs an illegal stored combination rather than trusting it", () => {
    const settings = resolveExportSettings({
      exportSettings: { videoCodec: "vp9", container: "mp4", audioCodec: "aac" },
    });
    expect(settings.container).toBe("webm");
    expect(settings.audioCodec).toBe("opus");
  });
});

describe("videoOutputArgs", () => {
  it("emits a CRF and no bitrate in constant-quality mode", () => {
    const args = videoOutputArgs(
      normalizeExportSettings({ videoCodec: "h264", qualityMode: "crf", crf: 20 }),
    );
    expect(args.slice(0, 2)).toEqual(["-c:v", "libx264"]);
    expect(valueOf(args, "-crf")).toBe("20");
    expect(args).not.toContain("-b:v");
    expect(valueOf(args, "-preset")).toBe("medium");
    expect(valueOf(args, "-pix_fmt")).toBe("yuv420p");
  });

  it("emits a bitrate and no CRF in target-bitrate mode", () => {
    const args = videoOutputArgs(
      normalizeExportSettings({
        videoCodec: "h264",
        qualityMode: "bitrate",
        videoBitrate: 8000,
      }),
    );
    expect(valueOf(args, "-b:v")).toBe("8000k");
    expect(args).not.toContain("-crf");
  });

  it("tags H.265 as hvc1 so QuickTime will play it", () => {
    const mp4 = videoOutputArgs(
      normalizeExportSettings({ videoCodec: "h265", container: "mp4" }),
    );
    expect(mp4.slice(0, 2)).toEqual(["-c:v", "libx265"]);
    expect(valueOf(mp4, "-tag:v")).toBe("hvc1");

    const mov = videoOutputArgs(
      normalizeExportSettings({ videoCodec: "h265", container: "mov" }),
    );
    expect(valueOf(mov, "-tag:v")).toBe("hvc1");
  });

  it("never tags a codec that is not H.265", () => {
    const args = videoOutputArgs(normalizeExportSettings({ videoCodec: "h264" }));
    expect(args).not.toContain("-tag:v");
  });

  it("pins VP9's bitrate to zero so -crf stays constant quality", () => {
    const args = videoOutputArgs(
      normalizeExportSettings({
        videoCodec: "vp9",
        qualityMode: "crf",
        crf: 31,
        preset: "medium",
      }),
    );
    expect(args.slice(0, 2)).toEqual(["-c:v", "libvpx-vp9"]);
    expect(valueOf(args, "-crf")).toBe("31");
    expect(valueOf(args, "-b:v")).toBe("0");
    // libvpx rejects -preset outright; the same axis is -cpu-used.
    expect(args).not.toContain("-preset");
    expect(valueOf(args, "-cpu-used")).toBe("3");
    expect(valueOf(args, "-deadline")).toBe("good");
  });

  it("gives ProRes a profile and no rate control at all", () => {
    const args = videoOutputArgs(
      normalizeExportSettings({ videoCodec: "prores", proresProfile: 3 }),
    );
    expect(args.slice(0, 2)).toEqual(["-c:v", "prores_ks"]);
    expect(valueOf(args, "-profile:v")).toBe("3");
    expect(args).not.toContain("-crf");
    expect(args).not.toContain("-b:v");
    expect(args).not.toContain("-preset");
  });

  it("picks a ProRes pixel format that can carry alpha only when the profile can", () => {
    expect(
      pixelFormatFor(
        normalizeExportSettings({ videoCodec: "prores", proresProfile: 3 }),
      ),
    ).toBe("yuv422p10le");
    expect(
      pixelFormatFor(
        normalizeExportSettings({ videoCodec: "prores", proresProfile: 4 }),
      ),
    ).toBe("yuva444p10le");
    expect(
      pixelFormatFor(
        normalizeExportSettings({ videoCodec: "prores", proresProfile: 5 }),
      ),
    ).toBe("yuva444p10le");
  });
});

describe("audioOutputArgs", () => {
  it("carries codec, bitrate, sample rate and channels", () => {
    const args = audioOutputArgs(
      normalizeExportSettings({
        audioCodec: "aac",
        audioBitrate: 192,
        sampleRate: 48000,
        channels: 2,
      }),
    );
    expect(args).toEqual([
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-ac",
      "2",
    ]);
  });

  it("omits the bitrate for PCM, which is uncompressed", () => {
    const args = audioOutputArgs(
      normalizeExportSettings({
        videoCodec: "prores",
        audioCodec: "pcm_s16le",
      }),
    );
    expect(args.slice(0, 2)).toEqual(["-c:a", "pcm_s16le"]);
    expect(args).not.toContain("-b:a");
  });

  it("uses the libopus / libvorbis encoder names for webm", () => {
    expect(
      audioOutputArgs(
        normalizeExportSettings({ videoCodec: "vp9", audioCodec: "opus" }),
      ).slice(0, 2),
    ).toEqual(["-c:a", "libopus"]);
    expect(
      audioOutputArgs(
        normalizeExportSettings({ videoCodec: "vp9", audioCodec: "vorbis" }),
      ).slice(0, 2),
    ).toEqual(["-c:a", "libvorbis"]);
  });
});

describe("containerOutputArgs", () => {
  it("front-loads the moov atom for the ISOBMFF containers only", () => {
    expect(
      containerOutputArgs(normalizeExportSettings({ container: "mp4" })),
    ).toEqual(["-movflags", "+faststart", "-f", "mp4"]);
    expect(
      containerOutputArgs(
        normalizeExportSettings({ videoCodec: "prores", container: "mov" }),
      ),
    ).toEqual(["-movflags", "+faststart", "-f", "mov"]);
    expect(
      containerOutputArgs(normalizeExportSettings({ videoCodec: "vp9" })),
    ).toEqual(["-f", "webm"]);
  });
});
