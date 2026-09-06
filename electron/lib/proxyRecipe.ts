/**
 * What a proxy is, as arithmetic: how big, and what to ask FFmpeg for.
 *
 * Split out from `proxy.ts` so the two decisions that are easy to get wrong —
 * the scaled size and the encoder arguments — can be tested without spawning
 * anything or touching a disk.
 *
 * A proxy is a small, cheap-to-decode stand-in for a source file, used by the
 * **preview only**. Export always reads the original; that is not a policy this
 * module enforces but a consequence of where the substitution happens, which is
 * one function in `loadedAssetStore`.
 */

/** Longest edge of a proxy, in pixels. */
export const PROXY_MAX_EDGE = 960;

/**
 * Keyframe interval, in frames, at the proxy's own rate.
 *
 * Twelve rather than the two-hundred-and-fifty an x264 default would give.
 * The whole point of a proxy in an editor is random access: a seek costs the
 * decode of everything back to the previous keyframe, so a 250-frame GOP means
 * a scrub can decode 250 frames to show one. Twelve is FFmpeg's own default for
 * `-g` and is about a fifth of a second at 60fps — small enough that a seek is
 * imperceptible, large enough that the file is not an intra-frame monster.
 */
export const PROXY_GOP = 12;

/** Ceiling on the proxy's frame rate. */
export const PROXY_MAX_FPS = 60;

export type SourceInfo = {
  width: number;
  height: number;
  /** Frames per second, as a number. Zero or NaN means "unknown". */
  fps: number;
};

export type ProxySize = { width: number; height: number; fps: number };

/**
 * The size and rate a proxy for this source should have.
 *
 * Three rules, and the reasons matter:
 *
 * - **Never upscale.** A source already smaller than the cap gets a proxy at
 *   its own size — re-encoding it smaller would cost quality for nothing, and
 *   re-encoding it *larger* would cost quality and space for less than nothing.
 * - **Both dimensions stay even.** H.264 4:2:0 chroma is subsampled by two, so
 *   an odd dimension is not representable; libx264 fails outright rather than
 *   rounding.
 * - **The aspect ratio is preserved exactly enough to be invisible.** A proxy
 *   that letterboxes differently from its source would move every clip's
 *   framing the moment the user toggled proxies, which is the one thing a
 *   stand-in must never do. Rounding to even can shift the ratio by at most
 *   half a pixel in one axis.
 */
export function proxySizeFor(source: SourceInfo): ProxySize {
  const w = Math.max(1, Math.round(source.width));
  const h = Math.max(1, Math.round(source.height));
  const longest = Math.max(w, h);

  const scale = longest > PROXY_MAX_EDGE ? PROXY_MAX_EDGE / longest : 1;

  const fps =
    Number.isFinite(source.fps) && source.fps > 0
      ? Math.min(source.fps, PROXY_MAX_FPS)
      : PROXY_MAX_FPS;

  return {
    width: even(w * scale),
    height: even(h * scale),
    fps,
  };
}

/** Round to the nearest even integer, never below 2. */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * Whether a source is worth proxying at all.
 *
 * A file that is already small and already cheap to decode gains nothing from a
 * second copy, and generating one costs the user a transcode. The test is
 * deliberately about *decode cost*, which is pixels per second, rather than
 * about resolution alone: 3600x2338 at 120fps and 1920x1080 at 60fps are two
 * and a half million pixels apart per second, and only one of them is a
 * problem.
 */
export const PROXY_PIXEL_RATE_THRESHOLD = 1920 * 1080 * 61;

export function needsProxy(source: SourceInfo): boolean {
  const fps = Number.isFinite(source.fps) && source.fps > 0 ? source.fps : 30;
  return source.width * source.height * fps > PROXY_PIXEL_RATE_THRESHOLD;
}

/**
 * The FFmpeg arguments for one proxy.
 *
 * H.264 rather than ProRes, which inverts the advice every desktop NLE gives —
 * and the inversion is the point. Those tools decode with their own engines;
 * this preview decodes with Chromium, which has a hardware H.264 path and
 * cannot open ProRes at all. A ProRes proxy here would be slower than the
 * source it replaced.
 *
 * `-movflags +faststart` so the moov atom is at the front: the renderer streams
 * these over `file://` and a trailing index means the whole file is read before
 * the first frame appears.
 */
export function proxyArgs(
  sourcePath: string,
  outPath: string,
  size: ProxySize,
): string[] {
  return [
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    // **Audio is kept, and it has to be.** A video clip's sound in the preview
    // comes off the very same `<video>` handle the picture does — that is what
    // `playback.ts` mutes and sets a volume on — so a silent proxy would not
    // save decoding, it would make every video clip silent while proxies were
    // on. The `?` makes the stream optional, so a source with no audio track
    // still encodes instead of failing.
    "-map",
    "0:a?",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-vf",
    `scale=${size.width}:${size.height}:flags=bilinear`,
    "-r",
    String(size.fps),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "26",
    "-g",
    String(PROXY_GOP),
    // No B-frames: they are what makes decode order differ from display order,
    // and a proxy exists to be scrubbed.
    "-bf",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    // **Stated, not inferred.** FFmpeg picks its muxer from the output
    // extension, and the caller writes to a `.mp4.part` temporary so that a
    // transcode killed halfway cannot leave a playable-but-truncated file
    // behind an index entry. That extension is not one FFmpeg knows, and it
    // fails with "Unable to choose an output format" before encoding a frame.
    // Naming the format keeps the atomic rename and removes the coupling.
    "-f",
    "mp4",
    outPath,
  ];
}
