/**
 * What the Show Info dialog says about a file, and in what words.
 *
 * Every decision is here, DOM-free, so `mediaInfoView.test.ts` can check it:
 * which clips get the menu row, which file a clip is asked about, which rows
 * appear, and how each number reads. `mediaInfoDialog.ts` only paints the
 * `InfoView` this returns.
 *
 * Two rules the rows follow:
 *
 * - **The basics always show.** Resolution, duration and codec read "Unknown"
 *   when ffprobe could not say, because a missing row there looks like a bug.
 *   Stream details (bitrate, bit depth, colour, rotation) are simply left out
 *   when not stated.
 * - **Resolution is the size the picture is shown at.** A phone clip stored
 *   landscape with a quarter-turn flag reads portrait, which is how it lands on
 *   the canvas; the stored size goes on the Rotation row.
 */

import type {
  MediaAudioStream,
  MediaFileInfo,
  MediaInfoFailure,
  MediaInfoResult,
  MediaVideoStream,
} from "../../../../../electron/lib/mediaInfo";
import type { TimelineElement } from "../../@types/timeline";
import { detectFlavour, toFsPath } from "../project/assetPaths";
import { formatTimecode } from "../subtitle/timecode";

export type InfoKind = "video" | "image" | "gif" | "audio";

const INFO_KINDS: readonly string[] = ["video", "image", "gif", "audio"];

export function isInfoKind(value: unknown): value is InfoKind {
  return typeof value === "string" && INFO_KINDS.includes(value);
}

/** The file the dialog is about, however it was asked for. */
export type InfoTarget = {
  kind: InfoKind;
  name: string;
  /** For ffprobe and Reveal: an OS path, never a URL. */
  fsPath: string;
  /** For the `<img>` that measures a photo: the app's `file://` form. */
  localpath: string;
  /** The OS path of the reversed copy a clip actually plays, if it does. */
  reversedCopy: string | null;
};

export type ShownSize = { width: number; height: number };

export type LoadedInfo = {
  result: MediaInfoResult;
  /** A photo's size as Chromium shows it, EXIF orientation applied. */
  shown: ShownSize | null;
};

export type InfoRow = { label: string; value: string };
export type InfoSection = { title: string; rows: InfoRow[] };

export type InfoView = {
  kind: InfoKind;
  title: string;
  kindLabel: string;
  status: "loading" | "ready" | "failed";
  /** Resolution and Duration. Location is painted after them, with buttons. */
  general: InfoRow[];
  location: string;
  reversedCopy: string | null;
  /** False when there is no file to show: Finder would open on nothing. */
  canReveal: boolean;
  failure: string | null;
  /** The stream sections, after General. */
  sections: InfoSection[];
};

export const PENDING = "…";
const UNKNOWN = "Unknown";

const KIND_LABELS: Record<InfoKind, string> = {
  video: "Video",
  image: "Image",
  gif: "GIF",
  audio: "Audio",
};

const FAILURES: Record<MediaInfoFailure, string> = {
  missing: "File not found. It was moved, renamed or deleted.",
  unreadable: "This file could not be read.",
  timeout: "Reading this file took too long.",
  invalid: "This path cannot be read.",
};

// ------------------------------------------------------------------ targets

function fsPathOf(localpath: string): string {
  return toFsPath(localpath, detectFlavour(localpath));
}

function baseName(fsPath: string): string {
  const parts = fsPath.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? fsPath;
}

/**
 * The file a timeline clip is about, or null when Show Info has nothing to say
 * about this kind of clip, which is what keeps the row off its menu.
 *
 * A reversed clip is asked about its **original**: the reversed file is a
 * cache the app made, re-encoded at its own settings, and "where is my source"
 * is the question the dialog exists to answer. The copy is named separately.
 */
export function targetForElement(
  element: TimelineElement | undefined,
): InfoTarget | null {
  if (element == null || !isInfoKind(element.filetype)) {
    return null;
  }
  const reversed =
    element.filetype === "video" ? (element.reversed ?? null) : null;
  const source = reversed?.localpath ?? element.localpath;
  if (typeof source !== "string" || source === "") {
    return null;
  }

  const fsPath = fsPathOf(source);
  return {
    kind: element.filetype,
    name: baseName(fsPath),
    fsPath,
    localpath: source,
    reversedCopy: reversed != null ? fsPathOf(element.localpath) : null,
  };
}

/** The file an asset tile stands for, keyed by `functions/mime.ts`'s type. */
export function targetForAsset(
  fsPath: string,
  fileUrl: string,
  name: string,
  mimeType: string,
): InfoTarget | null {
  if (!isInfoKind(mimeType) || fsPath === "") {
    return null;
  }
  return { kind: mimeType, name, fsPath, localpath: fileUrl, reversedCopy: null };
}

// ------------------------------------------------------------------- labels

/** At most `digits` decimals, and none that are zero: 29.97, 25, 44.1. */
function trimmed(value: number, digits = 2): string {
  return String(Number(value.toFixed(digits)));
}

const CODEC_NAMES: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC (H.265)",
  av1: "AV1",
  vp9: "VP9",
  vp8: "VP8",
  prores: "Apple ProRes",
  mpeg4: "MPEG-4 Part 2",
  mpeg2video: "MPEG-2",
  dnxhd: "Avid DNxHD",
  png: "PNG",
  webp: "WebP",
  gif: "GIF",
  bmp: "BMP",
  tiff: "TIFF",
  aac: "AAC",
  mp3: "MP3",
  opus: "Opus",
  vorbis: "Vorbis",
  flac: "FLAC",
  alac: "Apple Lossless",
  ac3: "Dolby Digital (AC-3)",
  eac3: "Dolby Digital Plus (E-AC-3)",
};

/**
 * `h264` and `High` to "H.264 High".
 *
 * `mjpeg` is the one id that means two things: a photo is a JPEG, a video
 * stream of them is Motion JPEG.
 */
export function codecLabel(
  codec: string | null,
  profile: string | null,
  still = false,
): string {
  if (codec == null) {
    return UNKNOWN;
  }

  let name: string;
  const pcm = /^pcm_([suf])(\d+)/.exec(codec);
  if (codec === "mjpeg") {
    name = still ? "JPEG" : "Motion JPEG";
  } else if (pcm != null) {
    name = `PCM ${pcm[2]}-bit${pcm[1] === "f" ? " float" : ""}`;
  } else {
    name = CODEC_NAMES[codec] ?? codec.toUpperCase();
  }

  return profile != null ? `${name} ${profile}` : name;
}

/**
 * "29.97 fps", or "Variable (avg 119.65 fps)" when the stream's base rate and
 * its measured average disagree by more than 1%, which is how a screen
 * recording or a phone clip that dropped frames probes.
 */
export function fpsLabel(fps: number | null, avgFps: number | null): string | null {
  if (fps != null && avgFps != null && Math.abs(fps - avgFps) / fps > 0.01) {
    return `Variable (avg ${trimmed(avgFps)} fps)`;
  }
  const rate = fps ?? avgFps;
  return rate == null ? null : `${trimmed(rate)} fps`;
}

export function bitrateLabel(bitsPerSecond: number | null): string | null {
  if (bitsPerSecond == null) {
    return null;
  }
  if (bitsPerSecond >= 1_000_000) {
    const mbps = bitsPerSecond / 1_000_000;
    return `${mbps >= 100 ? Math.round(mbps) : trimmed(mbps, 1)} Mbps`;
  }
  if (bitsPerSecond >= 1_000) {
    return `${Math.round(bitsPerSecond / 1_000)} kbps`;
  }
  return `${Math.round(bitsPerSecond)} bps`;
}

/** How the samples of a pixel format are laid out, ignoring bit depth. */
function layoutOf(pixelFormat: string): string | null {
  const table: [RegExp, string][] = [
    [/^yuva420/, "4:2:0 with alpha"],
    [/^yuva422/, "4:2:2 with alpha"],
    [/^yuva444/, "4:4:4 with alpha"],
    [/^(yuvj?420|nv12|nv21|p010|p016)/, "4:2:0"],
    [/^(yuvj?422|nv16|p210|p216)/, "4:2:2"],
    [/^(yuvj?444|p410|p416)/, "4:4:4"],
    [/^(rgba|bgra|argb|abgr|gbrap)/, "RGBA"],
    [/^(rgb|bgr|gbrp)/, "RGB"],
    [/^ya/, "Grayscale with alpha"],
    [/^gray/, "Grayscale"],
    [/^pal8/, "Palette"],
  ];
  return table.find(([pattern]) => pattern.test(pixelFormat))?.[1] ?? null;
}

/**
 * Bits per sample, from the pixel format, for a stream that does not state it:
 * `yuv420p10le` and `p010le` are 10, `rgba64be` and `rgb48le` are 16 (the
 * number there is bits per *pixel*).
 *
 * Every format deeper than 8 bits carries an endianness suffix, so the digits
 * count only when one follows. Without that rule `rgb24` read as 24-bit and
 * `nv12` as 12-bit.
 */
function depthOf(pixelFormat: string): number {
  if (/^(rgba64|bgra64|rgb48|bgr48|ya16)/.test(pixelFormat)) {
    return 16;
  }
  const trailing = /(\d+)(le|be)$/.exec(pixelFormat);
  if (trailing != null) {
    const bits = Number(trailing[1]);
    if (bits >= 9 && bits <= 32) {
      return bits;
    }
  }
  return 8;
}

/** "10-bit 4:2:0", "8-bit RGBA". Null when the pixel format is not stated. */
export function depthLabel(
  pixelFormat: string | null,
  bitDepth: number | null,
): string | null {
  if (pixelFormat == null) {
    return null;
  }
  const layout = layoutOf(pixelFormat);
  if (layout == null) {
    return null;
  }
  return `${bitDepth ?? depthOf(pixelFormat)}-bit ${layout}`;
}

/** Whether the pixel format carries alpha, or null when it cannot say. */
export function hasAlpha(pixelFormat: string | null): boolean | null {
  if (pixelFormat == null || /^pal8/.test(pixelFormat)) {
    // A palette may or may not reserve a transparent entry; the format alone
    // does not tell.
    return null;
  }
  return /^(rgba|bgra|argb|abgr|yuva|gbrap|ya)/.test(pixelFormat);
}

const GAMUTS: Record<string, string> = {
  bt2020: "Rec. 2020",
  bt709: "Rec. 709",
  smpte432: "Display P3",
  smpte431: "DCI-P3",
  bt470bg: "Rec. 601",
  smpte170m: "Rec. 601",
};

/**
 * "HDR10 (PQ, Rec. 2020)", "HLG (Rec. 2020)", "SDR (Rec. 709)". Null when the
 * stream states neither a transfer nor primaries: guessing Rec. 709 from the
 * frame size is what players do, and presenting a guess as a fact is not.
 */
export function colorLabel(
  transfer: string | null,
  primaries: string | null,
): string | null {
  const gamut = primaries != null ? (GAMUTS[primaries] ?? null) : null;

  if (transfer === "smpte2084") {
    return gamut != null ? `HDR10 (PQ, ${gamut})` : "HDR10 (PQ)";
  }
  if (transfer === "arib-std-b67") {
    return gamut != null ? `HLG (${gamut})` : "HLG";
  }
  if (gamut != null) {
    return `SDR (${gamut})`;
  }
  if (transfer === "bt709") {
    return "SDR (Rec. 709)";
  }
  if (transfer === "iec61966-2-1") {
    return "SDR (sRGB)";
  }
  return null;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Ratios whose exact fraction is too big to read, with the name people use. */
const NAMED_RATIOS: [number, string][] = [
  [21 / 9, "21:9"],
  [2.39, "2.39:1"],
  [1.85, "1.85:1"],
];

/** "16:9", "9:16", "2.39:1", or the ratio to two places: "1.54:1". */
export function aspectLabel(width: number, height: number): string {
  const d = gcd(width, height);
  const a = width / d;
  const b = height / d;
  if (a <= 32 && b <= 32) {
    return `${a}:${b}`;
  }

  const ratio = width / height;
  const named = NAMED_RATIOS.find(
    ([value]) => Math.abs(ratio - value) / value <= 0.01,
  );
  if (named != null) {
    return named[1];
  }
  return ratio >= 1 ? `${trimmed(ratio)}:1` : `1:${trimmed(1 / ratio)}`;
}

export function resolutionLabel(
  width: number,
  height: number,
  sampleAspect: [number, number] | null = null,
): string {
  const pixels =
    sampleAspect != null
      ? `, pixel aspect ${sampleAspect[0]}:${sampleAspect[1]}`
      : "";
  return `${width} × ${height} (${aspectLabel(width, height)}${pixels})`;
}

export function channelsLabel(
  channels: number | null,
  layout: string | null,
): string | null {
  const named: Record<number, string> = { 1: "Mono", 2: "Stereo", 6: "5.1", 8: "7.1" };
  if (channels != null) {
    if (named[channels] != null) {
      return named[channels];
    }
    return layout != null ? `${channels} channels (${layout})` : `${channels} channels`;
  }
  return layout;
}

export function sampleRateLabel(hertz: number | null): string | null {
  return hertz == null ? null : `${trimmed(hertz / 1000, 2)} kHz`;
}

/** "00:04:12.480". Reuses the subtitle clock rather than a third formatter. */
export function durationLabel(ms: number | null): string {
  return ms == null ? UNKNOWN : formatTimecode(ms, "vtt");
}

/** What the Reveal button says, in the platform's own words. */
export function revealLabel(userAgent: string): string {
  if (/Mac/.test(userAgent)) {
    return "Show in Finder";
  }
  if (/Windows/.test(userAgent)) {
    return "Show in Explorer";
  }
  return "Show in Folder";
}

// ----------------------------------------------------------------- sections

function row(label: string, value: string | null): InfoRow[] {
  return value == null ? [] : [{ label, value }];
}

function isQuarterTurn(rotation: number): boolean {
  return rotation === 90 || rotation === 270;
}

/** The size a stream is stored at, and the size it is shown at. */
function sizesOf(
  kind: InfoKind,
  video: MediaVideoStream | null,
  shown: ShownSize | null,
): { stored: ShownSize | null; display: ShownSize | null } {
  const stored =
    video?.width != null && video.height != null
      ? { width: video.width, height: video.height }
      : null;

  if (kind === "image" && shown != null) {
    return { stored, display: shown };
  }
  if (stored != null && isQuarterTurn(video!.rotation)) {
    return { stored, display: { width: stored.height, height: stored.width } };
  }
  return { stored, display: stored };
}

function generalRows(
  kind: InfoKind,
  info: MediaFileInfo,
  shown: ShownSize | null,
): InfoRow[] {
  const rows: InfoRow[] = [];

  if (kind !== "audio") {
    const { display } = sizesOf(kind, info.video, shown);
    rows.push({
      label: "Resolution",
      value:
        display != null
          ? resolutionLabel(display.width, display.height, info.video?.sampleAspect)
          : UNKNOWN,
    });
  }
  if (kind !== "image") {
    rows.push({ label: "Duration", value: durationLabel(info.durationMs) });
  }
  return rows;
}

function rotationRow(
  kind: InfoKind,
  video: MediaVideoStream,
  shown: ShownSize | null,
): InfoRow[] {
  const { stored, display } = sizesOf(kind, video, shown);
  if (stored == null || display == null) {
    return [];
  }
  const storedAs = `stored as ${stored.width} × ${stored.height}`;

  if (video.rotation !== 0) {
    return row("Rotation", `${video.rotation}° (${storedAs})`);
  }
  // A photo's EXIF orientation, which Chromium applies and ffprobe does not
  // report: visible only as a shown size that is the stored one turned.
  const turned =
    stored.width !== stored.height &&
    display.width === stored.height &&
    display.height === stored.width;
  return turned ? row("Rotation", `From EXIF (${storedAs})`) : [];
}

const NO_TRACK: InfoRow[] = [{ label: "Track", value: "None" }];

function videoSection(info: MediaFileInfo): InfoSection {
  const v = info.video;
  if (v == null) {
    return { title: "Video", rows: NO_TRACK };
  }
  return {
    title: "Video",
    rows: [
      { label: "Codec", value: codecLabel(v.codec, v.profile) },
      ...row("Frame rate", fpsLabel(v.fps, v.avgFps)),
      ...row("Bitrate", bitrateLabel(v.bitRate)),
      ...row("Bit depth", depthLabel(v.pixelFormat, v.bitDepth)),
      ...row("Color", colorLabel(v.colorTransfer, v.colorPrimaries)),
      ...rotationRow("video", v, null),
    ],
  };
}

function imageSection(info: MediaFileInfo, shown: ShownSize | null): InfoSection {
  const v = info.video;
  if (v == null) {
    return { title: "Image", rows: [{ label: "Format", value: UNKNOWN }] };
  }
  const alpha = hasAlpha(v.pixelFormat);
  return {
    title: "Image",
    rows: [
      { label: "Format", value: codecLabel(v.codec, null, true) },
      ...row("Bit depth", depthLabel(v.pixelFormat, v.bitDepth)),
      ...row("Transparency", alpha == null ? null : alpha ? "Yes" : "No"),
      ...rotationRow("image", v, shown),
    ],
  };
}

function gifSection(info: MediaFileInfo): InfoSection {
  const v = info.video;
  return {
    title: "GIF",
    rows: [
      { label: "Format", value: codecLabel(v?.codec ?? "gif", null, true) },
      ...row("Frames", v?.frames != null ? String(v.frames) : null),
      ...row("Frame rate", v != null ? fpsLabel(v.fps, v.avgFps) : null),
    ],
  };
}

/** Bit depth is a fact about lossless audio; AAC and MP3 have none. */
function isLossless(codec: string | null): boolean {
  return codec != null && /^(pcm_|flac$|alac$)/.test(codec);
}

function audioSections(info: MediaFileInfo): InfoSection[] {
  if (info.audio.length === 0) {
    return [{ title: "Audio", rows: NO_TRACK }];
  }
  const several = info.audio.length > 1;

  return info.audio.map((a: MediaAudioStream, index) => ({
    title: several ? `Audio ${index + 1}` : "Audio",
    rows: [
      { label: "Codec", value: codecLabel(a.codec, a.profile) },
      ...row("Sample rate", sampleRateLabel(a.sampleRate)),
      ...row("Channels", channelsLabel(a.channels, a.channelLayout)),
      ...row(
        "Bit depth",
        isLossless(a.codec) && a.bitDepth != null ? `${a.bitDepth}-bit` : null,
      ),
      ...row("Bitrate", bitrateLabel(a.bitRate)),
      ...row("Language", several ? a.language : null),
    ],
  }));
}

function streamSections(
  kind: InfoKind,
  info: MediaFileInfo,
  shown: ShownSize | null,
): InfoSection[] {
  switch (kind) {
    case "video":
      return [videoSection(info), ...audioSections(info)];
    case "image":
      return [imageSection(info, shown)];
    case "gif":
      return [gifSection(info)];
    case "audio":
      // The file may be a video whose sound was detached onto this clip. The
      // clip is the sound, so the picture is not what the user asked about.
      return audioSections(info);
  }
}

/** Placeholders shaped like the General rows, while ffprobe runs. */
function pendingGeneral(kind: InfoKind): InfoRow[] {
  return [
    ...(kind !== "audio" ? [{ label: "Resolution", value: PENDING }] : []),
    ...(kind !== "image" ? [{ label: "Duration", value: PENDING }] : []),
  ];
}

/** `loaded` is null while the probe is still running. */
export function buildInfoView(
  target: InfoTarget,
  loaded: LoadedInfo | null,
): InfoView {
  const base = {
    kind: target.kind,
    title: target.name,
    kindLabel: KIND_LABELS[target.kind],
    location: target.fsPath,
    reversedCopy: target.reversedCopy,
  };

  if (loaded == null) {
    return {
      ...base,
      status: "loading",
      general: pendingGeneral(target.kind),
      canReveal: true,
      failure: null,
      sections: [],
    };
  }
  if (!loaded.result.ok) {
    const { reason } = loaded.result;
    return {
      ...base,
      status: "failed",
      general: [],
      canReveal: reason !== "missing" && reason !== "invalid",
      failure: FAILURES[reason] ?? FAILURES.unreadable,
      sections: [],
    };
  }

  const { info } = loaded.result;
  return {
    ...base,
    status: "ready",
    general: generalRows(target.kind, info, loaded.shown),
    canReveal: true,
    failure: null,
    sections: streamSections(target.kind, info, loaded.shown).filter(
      (section) => section.rows.length > 0,
    ),
  };
}

/** The whole dialog as plain text, in the order it is painted, for Copy all. */
export function infoAsText(view: InfoView): string {
  const lines = [view.title, "", "General"];
  for (const { label, value } of view.general) {
    lines.push(`${label}: ${value}`);
  }
  lines.push(`Location: ${view.location}`);
  if (view.reversedCopy != null) {
    lines.push(`Reversed copy: ${view.reversedCopy}`);
  }
  if (view.failure != null) {
    lines.push("", view.failure);
  }
  for (const section of view.sections) {
    lines.push("", section.title);
    for (const { label, value } of section.rows) {
      lines.push(`${label}: ${value}`);
    }
  }
  return lines.join("\n");
}
