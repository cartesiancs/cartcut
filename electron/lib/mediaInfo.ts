/**
 * What ffprobe says a media file is, reduced to the facts Show Info displays.
 *
 * Pure and import-free. `mediaInfoProbe.ts` is the half that spawns, and the
 * renderer takes these types with `import type` (the arrangement
 * `menuCommands.ts` already uses), so a value import here would be the first
 * thing to drag Node into the renderer bundle.
 *
 * Numbers and codec ids only, never labels. How `yuv420p10le` reads is the
 * renderer's decision (`features/mediaInfo/mediaInfoView.ts`), so the wording
 * can change without a main-process build.
 *
 * Anything ffprobe leaves out or reports as `N/A` is `null` rather than 0: an
 * unknown frame rate and a frame rate of 0 would otherwise print the same wrong
 * number.
 */

export type MediaVideoStream = {
  codec: string | null;
  profile: string | null;
  /** The stored (coded) size, before `rotation` is applied. */
  width: number | null;
  height: number | null;
  /** Clockwise quarter turns needed to show the picture upright. */
  rotation: 0 | 90 | 180 | 270;
  /** Pixel aspect, or null for square pixels and for "not stated". */
  sampleAspect: [number, number] | null;
  /** `r_frame_rate`: the stream's base rate. */
  fps: number | null;
  /** `avg_frame_rate`: frames over duration. Differs from `fps` on VFR. */
  avgFps: number | null;
  pixelFormat: string | null;
  bitDepth: number | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  bitRate: number | null;
  frames: number | null;
};

export type MediaAudioStream = {
  codec: string | null;
  profile: string | null;
  sampleRate: number | null;
  channels: number | null;
  channelLayout: string | null;
  /** Stated only by lossless codecs; AAC and MP3 report 0, read as null. */
  bitDepth: number | null;
  bitRate: number | null;
  language: string | null;
};

export type MediaFileInfo = {
  durationMs: number | null;
  /** The whole file's rate, for when a stream does not state its own. */
  bitRate: number | null;
  /** The first picture stream that is not cover art. */
  video: MediaVideoStream | null;
  audio: MediaAudioStream[];
};

export type MediaInfoFailure = "missing" | "unreadable" | "timeout" | "invalid";

export type MediaInfoResult =
  | { ok: true; info: MediaFileInfo }
  | { ok: false; reason: MediaInfoFailure };

type Dict = Record<string, unknown>;

function dict(value: unknown): Dict | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : null;
}

/** ffprobe's spellings of "nothing to say", all read as absent. */
const UNSTATED = new Set(["", "N/A", "unknown", "und"]);

function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return UNSTATED.has(trimmed) ? null : trimmed;
}

/** ffprobe writes most numbers as strings; either form, positive or null. */
function positive(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function count(value: unknown): number | null {
  const n = positive(value);
  return n == null ? null : Math.round(n);
}

/**
 * `"30000/1001"` to 29.97. A bare number passes through.
 *
 * `0/0` is what ffprobe writes for an audio stream's frame rate and for a
 * video stream it could not time, so it is "unknown", not a division error.
 */
export function rateOf(value: unknown): number | null {
  if (typeof value === "number") {
    return positive(value);
  }
  const raw = text(value);
  if (raw == null) {
    return null;
  }
  const [num, den = "1"] = raw.split("/");
  const n = Number(num);
  const d = Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) {
    return null;
  }
  return n / d;
}

/**
 * The quarter turn, clockwise, that shows this stream upright.
 *
 * Two sources, in the order ffprobe 9 prefers them. The display matrix's
 * `rotation` is **counter-clockwise** (an iPhone portrait clip reports -90);
 * the older `rotate` tag is clockwise (the same clip wrote "90"). Both land on
 * the same answer here. An angle that is not a quarter turn snaps to the
 * nearest one, which is the only kind a picture can be shown at.
 */
export function rotationOf(stream: unknown): 0 | 90 | 180 | 270 {
  const s = dict(stream);
  if (s == null) {
    return 0;
  }

  let clockwise: number | null = null;
  const sideData = Array.isArray(s.side_data_list) ? s.side_data_list : [];
  for (const entry of sideData) {
    const rotation = dict(entry)?.rotation;
    if (typeof rotation === "number" && Number.isFinite(rotation)) {
      clockwise = -rotation;
      break;
    }
  }
  if (clockwise == null) {
    const tag = Number(text(dict(s.tags)?.rotate));
    if (Number.isFinite(tag)) {
      clockwise = tag;
    }
  }
  if (clockwise == null) {
    return 0;
  }

  const quarter = ((Math.round(clockwise / 90) * 90) % 360 + 360) % 360;
  return quarter as 0 | 90 | 180 | 270;
}

/** `"4:3"`, or null for square pixels and for the `0:1` of "not stated". */
function aspectOf(value: unknown): [number, number] | null {
  const raw = text(value);
  if (raw == null) {
    return null;
  }
  const [num, den] = raw.split(":").map(Number);
  if (!(num > 0) || !(den > 0) || num === den) {
    return null;
  }
  return [num, den];
}

function videoOf(s: Dict): MediaVideoStream {
  return {
    codec: text(s.codec_name),
    profile: text(s.profile),
    width: count(s.width),
    height: count(s.height),
    rotation: rotationOf(s),
    sampleAspect: aspectOf(s.sample_aspect_ratio),
    fps: rateOf(s.r_frame_rate),
    avgFps: rateOf(s.avg_frame_rate),
    pixelFormat: text(s.pix_fmt),
    bitDepth: count(s.bits_per_raw_sample),
    colorTransfer: text(s.color_transfer),
    colorPrimaries: text(s.color_primaries),
    bitRate: positive(s.bit_rate),
    frames: count(s.nb_frames),
  };
}

function audioOf(s: Dict): MediaAudioStream {
  return {
    codec: text(s.codec_name),
    profile: text(s.profile),
    sampleRate: positive(s.sample_rate),
    channels: count(s.channels),
    channelLayout: text(s.channel_layout),
    bitDepth: count(s.bits_per_raw_sample) ?? count(s.bits_per_sample),
    bitRate: positive(s.bit_rate),
    language: text(dict(s.tags)?.language),
  };
}

/**
 * An MP3's or M4A's cover art arrives as a video stream. Counting it would
 * give a song a resolution and a codec of PNG.
 */
function isCoverArt(s: Dict): boolean {
  return dict(s.disposition)?.attached_pic === 1;
}

/**
 * `-print_format json -show_format -show_streams` output, reduced.
 *
 * Never throws, whatever it is handed: the JSON comes from a child process,
 * and a file that probes strangely should show fewer rows, not no dialog.
 */
export function parseProbe(raw: unknown): MediaFileInfo {
  const root = dict(raw);
  const format = dict(root?.format);
  const streams = (Array.isArray(root?.streams) ? root.streams : [])
    .map(dict)
    .filter((s): s is Dict => s != null);

  const picture = streams.find(
    (s) => s.codec_type === "video" && !isCoverArt(s),
  );

  // The container's length first; a stream's only when the container is
  // silent, which is how a raw elementary stream or some GIFs probe.
  const seconds =
    positive(format?.duration) ??
    streams.reduce<number | null>((longest, s) => {
      const d = positive(s.duration);
      return d != null && (longest == null || d > longest) ? d : longest;
    }, null);

  return {
    durationMs: seconds == null ? null : seconds * 1000,
    bitRate: positive(format?.bit_rate),
    video: picture == null ? null : videoOf(picture),
    audio: streams.filter((s) => s.codec_type === "audio").map(audioOf),
  };
}
