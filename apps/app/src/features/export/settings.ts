/**
 * The vocabulary of export settings: what containers, codecs and quality knobs
 * exist, which combinations FFmpeg will actually mux, and the presets.
 *
 * Deliberately dependency-free so it runs under `environment: "node"`, and
 * deliberately mirrored by `electron/render/exportSettings.ts` — the Electron
 * build pins `rootDir: ../electron`, so the main process cannot import this
 * file. `electron/render/exportSettings.test.ts` imports both sides and asserts
 * the tables agree, so the pair cannot drift apart silently.
 */

export const CONTAINERS = ["mp4", "mov", "webm"] as const;
export type Container = (typeof CONTAINERS)[number];

export const VIDEO_CODECS = ["h264", "h265", "vp9", "prores"] as const;
export type VideoCodec = (typeof VIDEO_CODECS)[number];

export const AUDIO_CODECS = [
  "aac",
  "mp3",
  "opus",
  "vorbis",
  "pcm_s16le",
] as const;
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
  /** Constant-quality target. The usable range depends on the codec. */
  crf: number;
  /** Speed/compression tradeoff. Mapped to `-cpu-used` for VP9. */
  preset: EncodePreset;
  /** kbit/s, used only when `qualityMode` is `"bitrate"`. */
  videoBitrate: number;
  /** `prores_ks -profile:v`: 0 proxy, 1 LT, 2 422, 3 422 HQ, 4 4444, 5 4444 XQ. */
  proresProfile: number;
  audioCodec: AudioCodec;
  /** kbit/s. Ignored for PCM, which is uncompressed. */
  audioBitrate: number;
  sampleRate: number;
  channels: 1 | 2;
  /**
   * Encode on Apple's media engine instead of in software.
   *
   * macOS only, and only for the codecs in `CODEC_SUPPORTS_HW_ACCEL` — anywhere
   * else the flag is carried but ignored, so a project made on a Mac still
   * exports on Windows. Off by default, and that default is load-bearing: it is
   * what makes every project that predates this field produce the byte-identical
   * file it produced before.
   *
   * Not a blanket win, which is why it is a user choice rather than something
   * the app decides. Measured on an M3 Pro at 1080p60, VideoToolbox is 5x on
   * ProRes and 2.4x on HEVC, but *slower* than libx264 on H.264 at `medium`,
   * and it spends noticeably more bitrate for the same picture.
   */
  hardwareAccel: boolean;
};

/**
 * Which containers can mux each video codec. The first entry is the fallback
 * the normalizer snaps to.
 */
export const CODEC_CONTAINERS: Record<VideoCodec, readonly Container[]> = {
  h264: ["mp4", "mov"],
  h265: ["mp4", "mov"],
  vp9: ["webm"],
  prores: ["mov"],
};

/** The inverse of `CODEC_CONTAINERS`, kept explicit so the UI can read it directly. */
export const CONTAINER_VIDEO_CODECS: Record<Container, readonly VideoCodec[]> =
  {
    mp4: ["h264", "h265"],
    mov: ["h264", "h265", "prores"],
    webm: ["vp9"],
  };

export const CONTAINER_AUDIO_CODECS: Record<Container, readonly AudioCodec[]> =
  {
    mp4: ["aac", "mp3"],
    mov: ["aac", "pcm_s16le"],
    webm: ["opus", "vorbis"],
  };

/** libopus refuses anything but its own rate list, so 48k is all we offer there. */
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
  // Unused: ProRes is profile-driven and has no rate-control knob at all.
  prores: { min: 0, max: 0, default: 0 },
};

/** ProRes is intra-only at fixed per-profile rates; `-crf` means nothing to it. */
export const CODEC_SUPPORTS_CRF: Record<VideoCodec, boolean> = {
  h264: true,
  h265: true,
  vp9: true,
  prores: false,
};

/** The speed knob is `-preset` for x264/x265 and `-cpu-used` for VP9. */
export const CODEC_SUPPORTS_SPEED_PRESET: Record<VideoCodec, boolean> = {
  h264: true,
  h265: true,
  vp9: true,
  prores: false,
};

/**
 * Which codecs have a VideoToolbox encoder to switch to.
 *
 * VP9 has none — Apple's media engine does not encode it at all — so the
 * hardware toggle is hidden rather than offered and quietly ignored. The
 * encoder names themselves live in `electron/render/exportSettings.ts`, since
 * the renderer never spells an FFmpeg flag.
 */
export const CODEC_SUPPORTS_HW_ACCEL: Record<VideoCodec, boolean> = {
  h264: true,
  h265: true,
  vp9: false,
  prores: true,
};

export const PRORES_PROFILES = [
  { value: 0, label: "Proxy" },
  { value: 1, label: "LT" },
  { value: 2, label: "422" },
  { value: 3, label: "422 HQ" },
  { value: 4, label: "4444" },
  { value: 5, label: "4444 XQ" },
] as const;

export const AUDIO_BITRATES = [96, 128, 192, 256, 320] as const;

/** Display names, so neither the UI nor the summary line hardcodes them. */
export const VIDEO_CODEC_LABELS: Record<VideoCodec, string> = {
  h264: "H.264",
  h265: "H.265 (HEVC)",
  vp9: "VP9",
  prores: "ProRes",
};

export const AUDIO_CODEC_LABELS: Record<AudioCodec, string> = {
  aac: "AAC",
  mp3: "MP3",
  opus: "Opus",
  vorbis: "Vorbis",
  pcm_s16le: "PCM (16-bit)",
};

export const CONTAINER_LABELS: Record<Container, string> = {
  mp4: "MP4",
  mov: "MOV",
  webm: "WebM",
};

export const PRESET_NAMES = ["high", "medium", "low"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

/**
 * All three presets are pinned to H.264/MP4 so a preset click never produces an
 * exotic file. `medium.videoBitrate` is 5000 because that is the value the old
 * single bitrate input shipped with.
 */
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
    hardwareAccel: false,
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
    hardwareAccel: false,
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
    hardwareAccel: false,
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

/**
 * Repairs any settings object into a combination FFmpeg will actually mux.
 *
 * The resolution order is deliberate: the **video codec decides the container**,
 * the **container decides the audio codec**, the **audio codec decides the
 * sample rate**. A UI handler that changes something *downstream* — the
 * container, say — has to send the upstream field along in the same patch, or
 * this will simply snap the change back.
 */
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

  // ProRes is pinned to "bitrate" only to keep the type total — the arg builder
  // ignores the mode for ProRes entirely, and the UI hides the control.
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
    // Strict `=== true`, so a project file written before this field existed
    // normalizes to software encoding rather than to `undefined`, which would
    // then reach the arg builder and read as falsy anyway — but only by luck.
    hardwareAccel: raw.hardwareAccel === true,
  };
}

/**
 * "Custom" is derived, never stored. Keeping a preset label next to the values
 * would let the two disagree; comparing is cheap and cannot lie.
 */
export function detectPreset(settings: ExportSettings): PresetName | "custom" {
  for (const name of PRESET_NAMES) {
    const preset = EXPORT_PRESETS[name];
    const keys = Object.keys(preset) as (keyof ExportSettings)[];
    if (keys.every((key) => preset[key] === settings[key])) {
      return name;
    }
  }
  return "custom";
}

/** One-line summary for the panel header, e.g. "H.264 · MP4 · CRF 23 · AAC 192k". */
export function describeExportSettings(settings: ExportSettings): string {
  const parts: string[] = [
    VIDEO_CODEC_LABELS[settings.videoCodec],
    CONTAINER_LABELS[settings.container],
  ];

  if (settings.videoCodec === "prores") {
    const profile = PRORES_PROFILES.find(
      (p) => p.value === settings.proresProfile,
    );
    parts.push(profile ? profile.label : `Profile ${settings.proresProfile}`);
  } else if (settings.qualityMode === "crf") {
    parts.push(`CRF ${settings.crf}`);
  } else {
    parts.push(`${settings.videoBitrate}k`);
  }

  const audio = AUDIO_CODEC_LABELS[settings.audioCodec];
  parts.push(
    settings.audioCodec === "pcm_s16le"
      ? audio
      : `${audio} ${settings.audioBitrate}k`,
  );

  return parts.join(" ");
}
