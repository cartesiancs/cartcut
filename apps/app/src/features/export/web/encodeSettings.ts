/**
 * What the browser export writes, from the same `ExportSettings` the desktop
 * export reads.
 *
 * The vocabulary is the desktop one (`settings.ts`), so a project moves between
 * the two with its settings intact. A browser has no FFmpeg, though, only the
 * encoders WebCodecs offers, so a saved choice it cannot honour is *read* as
 * the nearest one it can (`webExportSettings`), never written back: open the
 * same project in the desktop app and its ProRes is still ProRes.
 *
 * The first cut writes two files: H.264 + AAC in MP4, and VP9 + Opus in WebM.
 * MOV, HEVC, MP3 and GIF come later; until then the settings panel does not
 * offer them here.
 *
 * Pure, so the whole table runs under `environment: "node"`.
 */

import {
  normalizeExportSettings,
  type AudioCodec,
  type Container,
  type ExportSettings,
  type VideoCodec,
} from "../settings";

export const WEB_CONTAINERS = ["mp4", "webm"] as const satisfies readonly Container[];
export type WebContainer = (typeof WEB_CONTAINERS)[number];

export const WEB_CONTAINER_VIDEO_CODECS: Record<WebContainer, readonly VideoCodec[]> = {
  mp4: ["h264"],
  webm: ["vp9"],
};

export const WEB_CONTAINER_AUDIO_CODECS: Record<WebContainer, readonly AudioCodec[]> = {
  mp4: ["aac"],
  webm: ["opus"],
};

/** Mediabunny's names for the codecs the browser export writes. */
const VIDEO_CODEC_FOR: Partial<Record<VideoCodec, "avc" | "vp9">> = {
  h264: "avc",
  vp9: "vp9",
};
const AUDIO_CODEC_FOR: Partial<Record<AudioCodec, "aac" | "opus">> = {
  aac: "aac",
  opus: "opus",
};

/**
 * A key frame every two seconds, as WebCodecs encoders are usually configured
 * and as the recorder already does (`overlay-record/.../videoWriter.ts`).
 */
export const KEY_FRAME_INTERVAL_SEC = 2;

export type WebEncodePlan = {
  readonly container: WebContainer;
  readonly extension: string;
  readonly mimeType: string;
  readonly video: {
    readonly codec: "avc" | "vp9";
    /**
     * VP9's constant-quality target, CRF on the encoder's own 0 to 63 scale,
     * or absent for a bitrate target. See `encodePlanFor` for why H.264 never
     * takes one.
     */
    readonly quantizer?: number;
    /** bits/s: the target, or the fallback where a quantizer is refused. */
    readonly bitrate: number;
    readonly hardwareAcceleration: "prefer-hardware" | "no-preference";
    readonly keyFrameIntervalSec: number;
  };
  readonly audio: {
    readonly codec: "aac" | "opus";
    /** bits/s. */
    readonly bitrate: number;
    readonly sampleRate: number;
    readonly channels: 1 | 2;
  };
};

/**
 * The settings as the browser export will honour them.
 *
 * Each field falls back the way the panel would fall back if the user had
 * picked the container: a MOV or a GIF becomes an MP4, HEVC and ProRes become
 * H.264, and the audio codec follows the container. Rate control, bitrates,
 * sample rate and channels are kept wherever the new codec takes them.
 */
export function webExportSettings(settings: ExportSettings): ExportSettings {
  const container: WebContainer = settings.container === "webm" ? "webm" : "mp4";
  const videoCodec = WEB_CONTAINER_VIDEO_CODECS[container].includes(settings.videoCodec)
    ? settings.videoCodec
    : WEB_CONTAINER_VIDEO_CODECS[container][0];
  const audioCodec = WEB_CONTAINER_AUDIO_CODECS[container].includes(settings.audioCodec)
    ? settings.audioCodec
    : WEB_CONTAINER_AUDIO_CODECS[container][0];
  const { gifFps: _gifFps, gifWidth: _gifWidth, ...rest } = settings;
  return normalizeExportSettings({ ...rest, container, videoCodec, audioCodec }, settings);
}

/** Whether the browser export writes `settings` exactly as saved. */
export function isWebExportable(settings: ExportSettings): boolean {
  const honoured = webExportSettings(settings);
  return (
    honoured.container === settings.container &&
    honoured.videoCodec === settings.videoCodec &&
    honoured.audioCodec === settings.audioCodec &&
    honoured.sampleRate === settings.sampleRate
  );
}

/** Bits per pixel per frame x264 spends at CRF 23 on ordinary footage. */
const H264_BITS_PER_PIXEL_AT_CRF23 = 0.1;
const MIN_VIDEO_BITRATE = 500_000;
const MAX_VIDEO_BITRATE = 200_000_000;

/**
 * The bitrate that stands in for an H.264 CRF.
 *
 * x264's rule of thumb: every six CRF steps halve or double the rate. Anchored
 * at 0.1 bits per pixel for CRF 23, so the medium preset at 1080p30 is about
 * 6 Mbit/s, CRF 18 about 11 and CRF 28 about 3.5.
 */
export function h264BitrateForCrf(
  crf: number,
  frame: { width: number; height: number; fps: number },
): number {
  const bitsPerPixel = H264_BITS_PER_PIXEL_AT_CRF23 * 2 ** ((23 - crf) / 6);
  const bitrate = bitsPerPixel * frame.width * frame.height * frame.fps;
  return Math.round(Math.min(MAX_VIDEO_BITRATE, Math.max(MIN_VIDEO_BITRATE, bitrate)));
}

/**
 * The encoder settings for one export.
 *
 * **H.264 never gets a quantizer.** A constant-quantizer request is one the
 * platform's hardware encoder (VideoToolbox on a Mac) does not take, so Chrome
 * answers it with its software encoder: measured at 720p, 4.5s for four
 * seconds of video against 0.5s at a bitrate. The point of encoding in the
 * browser is the hardware encoder, so a CRF is translated into the bitrate it
 * would roughly spend (`h264BitrateForCrf`) and the encoder targets that. VP9
 * has no hardware encoder to lose and takes its CRF as a quantizer directly.
 */
export function encodePlanFor(
  saved: ExportSettings,
  frame: { width: number; height: number; fps: number },
): WebEncodePlan {
  const settings = webExportSettings(saved);
  const container = settings.container as WebContainer;
  const video = VIDEO_CODEC_FOR[settings.videoCodec]!;
  const audio = AUDIO_CODEC_FOR[settings.audioCodec]!;
  const crf = settings.qualityMode === "crf";
  return {
    container,
    extension: container,
    mimeType: container === "webm" ? "video/webm" : "video/mp4",
    video: {
      codec: video,
      ...(crf && video === "vp9" ? { quantizer: settings.crf } : {}),
      bitrate:
        crf && video === "avc"
          ? h264BitrateForCrf(settings.crf, frame)
          : settings.videoBitrate * 1000,
      hardwareAcceleration: settings.hardwareAccel ? "prefer-hardware" : "no-preference",
      keyFrameIntervalSec: KEY_FRAME_INTERVAL_SEC,
    },
    audio: {
      codec: audio,
      bitrate: settings.audioBitrate * 1000,
      sampleRate: settings.sampleRate,
      channels: settings.channels,
    },
  };
}

/**
 * The most packets a track can hold, which the MP4 writer needs up front to
 * reserve room for the index at the head of the file (`fastStart: "reserve"`),
 * where the desktop export's `-movflags +faststart` puts it.
 *
 * A video track has exactly one packet per frame. An audio packet is one codec
 * frame: 1024 samples for AAC, 960 for 20ms of Opus at 48kHz, so the smaller is
 * a bound for both. A third more on top, as Mediabunny advises.
 */
export function packetBounds(
  frameCount: number,
  durationSec: number,
  sampleRate: number,
): { video: number; audio: number } {
  const audioPackets = Math.ceil((durationSec * sampleRate) / 960);
  return {
    video: Math.ceil(frameCount * 4 / 3) + 16,
    audio: Math.ceil(audioPackets * 4 / 3) + 16,
  };
}
