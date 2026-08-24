/**
 * Export settings, as the main process sees them, plus the mapping from those
 * settings onto FFmpeg flags.
 *
 * The vocabulary below is a **deliberate copy** of
 * `apps/app/src/features/export/settings.ts`. Importing that file would pull the
 * renderer tree into the Electron `tsc` build: `.tsconfig/tsconfig.json` pins
 * `rootDir: ../electron`, so a single cross-boundary import widens it, the whole
 * build relocates from `main/` to `main/electron/`, and `package.json`'s
 * `"main": "main/main.js"` stops resolving. This is the same reason
 * `ffmpegArgs.ts` restates the geometry formulas rather than importing them.
 *
 * `exportSettings.test.ts` imports **both** sides and asserts the tables are
 * identical, so the pair cannot drift apart silently. Test files are excluded
 * from the Electron tsc pass, so they may reach across freely.
 */

export const CONTAINERS = ["mp4", "mov", "webm"] as const;
export type Container = (typeof CONTAINERS)[number];

export const VIDEO_CODECS = ["h264", "h265", "vp9", "prores"] as const;
export type VideoCodec = (typeof VIDEO_CODECS)[number];

export const AUDIO_CODECS = ["aac", "mp3", "opus", "vorbis", "pcm_s16le"] as const;
export type AudioCodec = (typeof AUDIO_CODECS)[number];

export const ENCODE_PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
] as const;
export type EncodePreset = (typeof ENCODE_PRESETS)[number];

export type QualityMode = "crf" | "bitrate";

export type ExportSettings = {
  container: Container;
  videoCodec: VideoCodec;
  qualityMode: QualityMode;
  crf: number;
  preset: EncodePreset;
  videoBitrate: number;
  proresProfile: number;
  audioCodec: AudioCodec;
  audioBitrate: number;
  sampleRate: number;
  channels: 1 | 2;
};

export const CODEC_CONTAINERS: Record<VideoCodec, readonly Container[]> = {
  h264: ["mp4", "mov"],
  h265: ["mp4", "mov"],
  vp9: ["webm"],
  prores: ["mov"],
};

export const CONTAINER_VIDEO_CODECS: Record<Container, readonly VideoCodec[]> = {
  mp4: ["h264", "h265"],
  mov: ["h264", "h265", "prores"],
  webm: ["vp9"],
};

export const CONTAINER_AUDIO_CODECS: Record<Container, readonly AudioCodec[]> = {
  mp4: ["aac", "mp3"],
  mov: ["aac", "pcm_s16le"],
  webm: ["opus", "vorbis"],
};

export const AUDIO_SAMPLE_RATES: Record<AudioCodec, readonly number[]> = {
  aac: [44100, 48000],
  mp3: [44100, 48000],
  opus: [48000],
  vorbis: [44100, 48000],
  pcm_s16le: [44100, 48000],
};

export const CRF_RANGE: Record<
  VideoCodec,
  { min: number; max: number; default: number }
> = {
  h264: { min: 0, max: 51, default: 23 },
  h265: { min: 0, max: 51, default: 28 },
  vp9: { min: 0, max: 63, default: 31 },
  prores: { min: 0, max: 0, default: 0 },
};

export const CODEC_SUPPORTS_CRF: Record<VideoCodec, boolean> = {
  h264: true,
  h265: true,
  vp9: true,
  prores: false,
};

export const PRESET_NAMES = ["high", "medium", "low"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export const EXPORT_PRESETS: Record<PresetName, ExportSettings> = {
  high: {
    container: "mp4",
    videoCodec: "h264",
    qualityMode: "crf",
    crf: 18,
    preset: "slow",
    videoBitrate: 12000,
    proresProfile: 3,
    audioCodec: "aac",
    audioBitrate: 320,
    sampleRate: 48000,
    channels: 2,
  },
  medium: {
    container: "mp4",
    videoCodec: "h264",
    qualityMode: "crf",
    crf: 23,
    preset: "medium",
    videoBitrate: 5000,
    proresProfile: 3,
    audioCodec: "aac",
    audioBitrate: 192,
    sampleRate: 48000,
    channels: 2,
  },
  low: {
    container: "mp4",
    videoCodec: "h264",
    qualityMode: "crf",
    crf: 28,
    preset: "veryfast",
    videoBitrate: 2500,
    proresProfile: 3,
    audioCodec: "aac",
    audioBitrate: 128,
    sampleRate: 44100,
    channels: 2,
  },
};

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = EXPORT_PRESETS.medium;

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function positive(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/** See the renderer copy for the rationale behind the resolution order. */
export function normalizeExportSettings(
  input: Partial<ExportSettings> | undefined | null,
  base: ExportSettings = DEFAULT_EXPORT_SETTINGS,
): ExportSettings {
  const raw = { ...base, ...(input ?? {}) };

  const videoCodec = pick(raw.videoCodec, VIDEO_CODECS, base.videoCodec);

  const allowedContainers = CODEC_CONTAINERS[videoCodec];
  const container = allowedContainers.includes(raw.container as Container)
    ? (raw.container as Container)
    : allowedContainers[0];

  const allowedAudio = CONTAINER_AUDIO_CODECS[container];
  const audioCodec = allowedAudio.includes(raw.audioCodec as AudioCodec)
    ? (raw.audioCodec as AudioCodec)
    : allowedAudio[0];

  const allowedRates = AUDIO_SAMPLE_RATES[audioCodec];
  const sampleRate = allowedRates.includes(Number(raw.sampleRate))
    ? Number(raw.sampleRate)
    : allowedRates[0];

  const range = CRF_RANGE[videoCodec];

  const qualityMode: QualityMode = !CODEC_SUPPORTS_CRF[videoCodec]
    ? "bitrate"
    : raw.qualityMode === "crf"
      ? "crf"
      : "bitrate";

  return {
    container,
    videoCodec,
    qualityMode,
    crf: clampInt(raw.crf, range.min, range.max, range.default),
    preset: pick(raw.preset, ENCODE_PRESETS, base.preset),
    videoBitrate: positive(raw.videoBitrate, base.videoBitrate),
    proresProfile: clampInt(raw.proresProfile, 0, 5, base.proresProfile),
    audioCodec,
    audioBitrate: positive(raw.audioBitrate, base.audioBitrate),
    sampleRate,
    channels: Number(raw.channels) === 1 ? 1 : 2,
  };
}

// ---------------------------------------------------------------------------
// FFmpeg mapping — the part that has no counterpart on the renderer side.
// ---------------------------------------------------------------------------

export const VIDEO_ENCODERS: Record<VideoCodec, string> = {
  h264: "libx264",
  h265: "libx265",
  vp9: "libvpx-vp9",
  prores: "prores_ks",
};

export const AUDIO_ENCODERS: Record<AudioCodec, string> = {
  aac: "aac",
  mp3: "libmp3lame",
  opus: "libopus",
  vorbis: "libvorbis",
  pcm_s16le: "pcm_s16le",
};

/** libvpx has no `-preset`; the same axis is `-cpu-used`, and it runs backwards. */
export const VP9_CPU_USED: Record<EncodePreset, number> = {
  ultrafast: 8,
  superfast: 7,
  veryfast: 6,
  faster: 5,
  fast: 4,
  medium: 3,
  slow: 2,
  slower: 1,
  veryslow: 0,
};

/**
 * What an options object that predates this feature meant.
 *
 * The HTTP/offscreen path (`electron/server/controllers/render.ts`) still builds
 * the flat `{videoDuration, videoBitrate, videoDestination}` shape, so "no
 * exportSettings" has to keep meaning "H.264 at the given bitrate" rather than
 * "whatever the UI now defaults to".
 */
export const LEGACY_EXPORT_SETTINGS: ExportSettings = {
  container: "mp4",
  videoCodec: "h264",
  qualityMode: "bitrate",
  crf: 23,
  preset: "medium",
  videoBitrate: 5000,
  proresProfile: 3,
  audioCodec: "aac",
  audioBitrate: 128,
  sampleRate: 44100,
  channels: 2,
};

function containerFromPath(destination: unknown): Container | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(String(destination ?? ""));
  const extension = match?.[1]?.toLowerCase();
  return CONTAINERS.includes(extension as Container)
    ? (extension as Container)
    : undefined;
}

/** Reads settings off an options object of either the current or the legacy shape. */
export function resolveExportSettings(options: any): ExportSettings {
  const raw = options?.exportSettings;

  const base: ExportSettings = raw
    ? DEFAULT_EXPORT_SETTINGS
    : {
        ...LEGACY_EXPORT_SETTINGS,
        container:
          containerFromPath(options?.videoDestination) ??
          LEGACY_EXPORT_SETTINGS.container,
      };

  return normalizeExportSettings(
    {
      ...(raw ?? {}),
      videoBitrate:
        raw?.videoBitrate ?? options?.videoBitrate ?? base.videoBitrate,
    },
    base,
  );
}

export function pixelFormatFor(settings: ExportSettings): string {
  if (settings.videoCodec === "prores") {
    // 4444 and 4444 XQ carry alpha; the 422 family does not.
    return settings.proresProfile >= 4 ? "yuva444p10le" : "yuv422p10le";
  }
  return "yuv420p";
}

export function videoOutputArgs(settings: ExportSettings): string[] {
  const args: string[] = ["-c:v", VIDEO_ENCODERS[settings.videoCodec]];

  if (settings.videoCodec === "prores") {
    // ProRes is intra-only at fixed per-profile rates; `-crf` and `-b:v` are
    // both meaningless here, and `-preset` is rejected outright.
    args.push("-profile:v", `${settings.proresProfile}`);
  } else if (settings.qualityMode === "crf") {
    args.push("-crf", `${settings.crf}`);
    if (settings.videoCodec === "vp9") {
      // libvpx reads a nonzero `-b:v` as a *target*, which silently downgrades
      // `-crf` from constant quality to a quality ceiling. The explicit zero is
      // what makes it constant quality.
      args.push("-b:v", "0");
    }
  } else {
    args.push("-b:v", `${settings.videoBitrate}k`);
  }

  if (settings.videoCodec === "h264" || settings.videoCodec === "h265") {
    args.push("-preset", settings.preset);
  } else if (settings.videoCodec === "vp9") {
    args.push(
      "-deadline",
      "good",
      "-cpu-used",
      `${VP9_CPU_USED[settings.preset]}`,
      "-row-mt",
      "1",
    );
  }

  args.push("-pix_fmt", pixelFormatFor(settings));

  if (settings.videoCodec === "h265" && settings.container !== "webm") {
    // Without hvc1 the ISOBMFF sample entry is hev1, which QuickTime and Safari
    // refuse to play even though the bitstream itself is fine.
    args.push("-tag:v", "hvc1");
  }

  return args;
}

export function audioOutputArgs(settings: ExportSettings): string[] {
  const args: string[] = ["-c:a", AUDIO_ENCODERS[settings.audioCodec]];

  if (!settings.audioCodec.startsWith("pcm_")) {
    args.push("-b:a", `${settings.audioBitrate}k`);
  }

  args.push("-ar", `${settings.sampleRate}`, "-ac", `${settings.channels}`);

  return args;
}

export function containerOutputArgs(settings: ExportSettings): string[] {
  const args: string[] = [];

  if (settings.container === "mp4" || settings.container === "mov") {
    // Moves the moov atom to the front so the file is seekable before it has
    // finished downloading; harmless locally, required for a served file.
    args.push("-movflags", "+faststart");
  }

  // The muxer is inferrable from the extension, but the save dialog does not
  // guarantee one, so pin it.
  args.push("-f", settings.container);

  return args;
}
