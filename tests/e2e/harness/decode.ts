/**
 * Getting pixels back out of the exported file.
 *
 * **Colorimetry: decode with defaults, and prove it with the canary.**
 * `electron/render/ffmpegArgs.ts` passes no `-colorspace`, `-color_range` or
 * `-color_primaries`, so swscale converted RGBA to yuv420p with its own
 * defaults and wrote no VUI; ffprobe reports the output `color_space=unknown`.
 * Decoding with defaults therefore round-trips self-consistently. Measured on
 * this repo's ffmpeg, over an editor-like frame:
 *
 *     decode              mean|d|   p99   worst swatch error
 *     default (correct)      1.07     4                    4
 *     bt709 forced           1.52    10                   42
 *     full-range forced      9.79    14                   19
 *
 * Every forced override makes it worse. Forcing would also rot silently: the
 * day someone correctly adds `-colorspace bt709` to `videoOutputArgs`, hardcoded
 * decode flags would keep passing while the file changed meaning. So nothing is
 * forced here, and `compare.ts` checks the round trip empirically instead.
 *
 * **One decode pass, not one per frame.** An 18,000-frame file is not something
 * to open fifty times. Sampled frames and their alignment windows go out in a
 * single `select` expression, in ascending order.
 */

import { spawn } from "node:child_process";

import { FFMPEG, FFPROBE, type CodeRegion, type Region } from "./paths";

export class FfmpegError extends Error {
  constructor(readonly argv: string[], readonly stderrTail: string, code: number | null) {
    super(`ffmpeg exited ${code}\n  ${argv.join(" ")}\n${stderrTail}`);
    this.name = "FfmpegError";
  }
}

/** Keep the tail of stderr the way `framePipe.ts` does — it is where the interesting lines are. */
function tail(text: string, lines = 64): string {
  return text.split("\n").slice(-lines).join("\n");
}

function runCapture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new FfmpegError(args, tail(err), code)),
    );
  });
}

// ------------------------------------------------------------------- probe

export type OutputProbe = {
  video: {
    codec: string;
    width: number;
    height: number;
    pixFmt: string;
    rFrameRate: string;
    avgFrameRate: string;
    colorRange: string | null;
    colorSpace: string | null;
    durationSec: number | null;
    startTimeSec: number | null;
  };
  audio: {
    codec: string;
    sampleRate: number;
    channels: number;
    durationSec: number | null;
  } | null;
  formatDurationSec: number;
  streamCount: number;
};

export async function probeOutput(file: string): Promise<OutputProbe> {
  const json = JSON.parse(
    await runCapture(FFPROBE, [
      "-hide_banner", "-loglevel", "error",
      "-show_streams", "-show_format", "-of", "json", file,
    ]),
  );
  const v = json.streams.find((s: any) => s.codec_type === "video");
  const a = json.streams.find((s: any) => s.codec_type === "audio");
  if (v == null) throw new Error(`${file} has no video stream`);

  const num = (x: unknown) => (x == null || x === "N/A" ? null : Number(x));

  return {
    video: {
      codec: v.codec_name,
      width: v.width,
      height: v.height,
      pixFmt: v.pix_fmt,
      rFrameRate: v.r_frame_rate,
      avgFrameRate: v.avg_frame_rate,
      colorRange: v.color_range ?? null,
      colorSpace: v.color_space ?? null,
      durationSec: num(v.duration),
      startTimeSec: num(v.start_time),
    },
    audio: a == null ? null : {
      codec: a.codec_name,
      sampleRate: Number(a.sample_rate),
      channels: a.channels,
      durationSec: num(a.duration),
    },
    formatDurationSec: Number(json.format?.duration ?? 0),
    streamCount: json.streams.length,
  };
}

/** Decoded frame count. Separate from `probeOutput` because it walks the whole file. */
export async function countFrames(file: string): Promise<number> {
  const out = await runCapture(FFPROBE, [
    "-hide_banner", "-loglevel", "error",
    "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames",
    "-of", "default=nk=1:nw=1", file,
  ]);
  return Number(out.trim());
}

// -------------------------------------------------- exhaustive index decode

export type IndexMap = {
  /** `decoded[i]` is the frame index burned into output frame `i`. */
  decoded: number[];
  /** Ordinals where `decoded[i] !== i`, run-length encoded. Empty means perfect. */
  anomalies: Array<{ from: number; to: number; decoded: number; offset: number }>;
  frames: number;
  elapsedMs: number;
};

/**
 * Read the burned-in frame index out of **every** frame of the output.
 *
 * This is the strongest single assertion the suite makes, and it is nearly
 * free. Rather than decoding whole frames, the filter crops to the code band
 * and then scales it to one pixel per bit with nearest-neighbour sampling.
 * Scaling `bits*patch` down to `bits` with `neighbor` samples input x =
 * round((k + 0.5) * patch), which is exactly the centre of patch k — so no
 * blending, no interpolation, and 15 bytes per frame instead of 8.3 MB.
 *
 * Measured: 3,600 frames of 1080p in 1.3s, so an 18,000-frame export costs
 * about seven seconds to verify end to end.
 */
export async function decodeIndexMap(file: string, code: CodeRegion): Promise<IndexMap> {
  const started = Date.now();
  const { bits, w, h, x, y } = code;

  const argv = [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-i", file,
    "-vf", `crop=${w}:${h}:${x}:${y},scale=${bits}:1:flags=neighbor,format=gray`,
    "-fps_mode", "passthrough",
    "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ];

  const decoded: number[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let pending: Buffer = Buffer.alloc(0);
    let err = "";

    child.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= bits) {
        const row = pending.subarray(0, bits);
        pending = pending.subarray(bits);
        let value = 0;
        for (let k = 0; k < bits; k++) {
          // Patches are authored at 0 or 255 and decode within a code or two of
          // those even at crf 28, so the midpoint is not a close call.
          if (row[k] > 128) value |= 1 << k;
        }
        decoded.push(value);
      }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (codeOut) =>
      codeOut === 0 ? resolve() : reject(new FfmpegError(argv, tail(err), codeOut)),
    );
  });

  // Run-length encode the disagreements. A perfectly aligned export produces an
  // empty list; a shifted one produces a single run naming the offset, which is
  // usually the whole diagnosis.
  const anomalies: IndexMap["anomalies"] = [];
  for (let i = 0; i < decoded.length; i++) {
    if (decoded[i] === i) continue;
    const offset = decoded[i] - i;
    const last = anomalies[anomalies.length - 1];
    if (last != null && last.to === i - 1 && last.offset === offset) {
      last.to = i;
    } else {
      anomalies.push({ from: i, to: i, decoded: decoded[i], offset });
    }
  }

  return { decoded, anomalies, frames: decoded.length, elapsedMs: Date.now() - started };
}

// ------------------------------------------------------- full-frame decode

export type DecodedFrames = {
  /** Requested indices, ascending and deduped — the order buffers come back in. */
  indices: number[];
  /** RGBA, `width * height * 4` bytes each, parallel to `indices`. */
  frames: Buffer[];
  width: number;
  height: number;
};

/**
 * Extract specific frames as RGBA, in one pass.
 *
 * `select` with `+`-joined `eq(n,K)` terms acts as OR and emits in ascending
 * `n`, so slice *k* of the output is index *k* of the sorted request. That
 * pairing is only sound if every requested frame actually arrived, which is why
 * the byte count is asserted rather than assumed: a short read would shift
 * every subsequent pairing silently, and every frame after it would be compared
 * against the wrong reference. This is the same failure `framePipe.ts` guards
 * against on the write side.
 *
 * Indices past the end simply do not appear — `select=eq(n,frameCount)` on a
 * file with exactly that many frames emits nothing — so a short file is
 * reported as a clean count mismatch rather than as garbage pixels.
 */
export async function decodeFrames(
  file: string,
  wanted: number[],
  width: number,
  height: number,
  crop?: Region,
): Promise<DecodedFrames> {
  const indices = [...new Set(wanted)].filter((n) => n >= 0).sort((a, b) => a - b);
  if (indices.length === 0) {
    return { indices, frames: [], width, height };
  }

  const outW = crop?.w ?? width;
  const outH = crop?.h ?? height;
  const stride = outW * outH * 4;

  const filters = [`select='${indices.map((n) => `eq(n\\,${n})`).join("+")}'`];
  if (crop != null) filters.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);

  const argv = [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-i", file,
    "-vf", filters.join(","),
    "-fps_mode", "passthrough",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-",
  ];

  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stdout.on("data", (c: Buffer) => { chunks.push(c); total += c.length; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new FfmpegError(argv, tail(err), code)),
    );
  });

  const expected = indices.length * stride;
  if (total !== expected) {
    throw new Error(
      `decodeFrames: asked for ${indices.length} frames of ${outW}x${outH} ` +
      `(${expected} bytes), ffmpeg produced ${total} (${(total / stride).toFixed(2)} frames).\n` +
      `Frames past the end of the file are silently absent — check the frame count first.\n` +
      `Requested: ${indices.slice(0, 12).join(", ")}${indices.length > 12 ? ", …" : ""}`,
    );
  }

  const all = Buffer.concat(chunks, total);
  const frames = indices.map((_, i) => all.subarray(i * stride, (i + 1) * stride));
  return { indices, frames, width: outW, height: outH };
}

/**
 * One frame, for a diagnostic artifact or a reproduction command.
 *
 * Seeks to a quarter of a frame *inside* the interval: `N/fps` sits exactly on
 * the boundary, where float rounding can tip onto `N-1`. Verified to land on
 * frame N for both the exact and the offset form, but the offset form has
 * margin and the exact one does not. Keyframe-dependent, so this is a
 * convenience — never the assertion path.
 */
export function singleFrameCommand(file: string, frame: number, fps: number): string[] {
  const at = (frame - 0.25) / fps;
  return [
    FFMPEG, "-hide_banner", "-loglevel", "error",
    "-ss", at.toFixed(6),
    "-i", file, "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-",
  ];
}

export { runCapture };
