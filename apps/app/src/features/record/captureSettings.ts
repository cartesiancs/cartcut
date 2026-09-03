/**
 * How large, how fast and how good a capture is — the arithmetic behind the
 * "quality" half of the recorder.
 *
 * Every number here is decided before a single frame is captured, and getting
 * one of them wrong is the difference between a recording that reads like the
 * screen and one that reads like a video of the screen. The three that matter
 * most, in order:
 *
 *  1. **Capture at the display's own pixels.** A 14" MacBook panel is 3024×1964
 *     of real pixels behind a 1512×982 coordinate space. Capturing "1080p" from
 *     it throws away 64% of them *before* the encoder ever sees the picture, and
 *     no bitrate spent afterwards brings the text back. This is the single
 *     largest quality defect in the in-panel recorder, which pins
 *     `maxWidth: 1920, maxHeight: 1080` unconditionally
 *     (`features/record/screenRecord.ts`).
 *  2. **Bitrate from pixels, not from a preset.** A fixed "8 Mbps" is generous
 *     at 720p30 and starvation at 5K60. Everything here is bits per pixel per
 *     frame, clamped at both ends.
 *  3. **A codec string whose level actually admits the picture.** `avc1.640028`
 *     is High profile at *level 4.0*, which tops out at 1920×1080. Hand that to
 *     `VideoEncoder` for a 4K capture and `isConfigSupported` says no — or
 *     worse, a driver accepts it and produces a stream other decoders reject.
 *     `avcCodec` computes the level from the frame size and rate.
 *
 * DOM-free, and it takes the display as a plain `{ width, height, scaleFactor }`
 * rather than reaching for Electron's `screen` module, so it runs under
 * `environment: "node"`.
 */

import type { QualityPreset } from "./recordSettings";

export type Size = { width: number; height: number };

/** What Electron's `Display` gives us, reduced to what this module needs. */
export type DisplayInfo = {
  /** Logical points, as `display.size`. */
  width: number;
  height: number;
  /** `display.scaleFactor` — 2 on a Retina panel, 1.5 on many Windows laptops. */
  scaleFactor: number;
};

/**
 * The largest frame the encoders are asked for.
 *
 * 5K wide covers a Pro Display XDR at native scale. Past this the hardware
 * encoder on several Macs falls back to software without saying so, which turns
 * a smooth capture into a stuttering one — a cap that costs a little sharpness
 * on one exotic display beats a recording nobody can watch.
 */
export const MAX_CAPTURE_WIDTH = 5120;
export const MAX_CAPTURE_HEIGHT = 2880;

/** The smallest frame worth encoding; also what a degenerate display becomes. */
export const MIN_CAPTURE_WIDTH = 160;
export const MIN_CAPTURE_HEIGHT = 120;

/** What `"720p"` and `"1080p"` mean, as a target *height*. */
const QUALITY_HEIGHTS: Record<QualityPreset, number | null> = {
  "720p": 720,
  "1080p": 1080,
  native: null,
};

/**
 * Round down to an even number, never below `floor`.
 *
 * H.264 is 4:2:0: the chroma planes are half resolution on both axes, so an odd
 * dimension has no representation. Encoders cope by padding and the padding
 * leaks in as a green or repeated edge column. Every size this module produces
 * is even, on both axes, and that is not negotiable anywhere downstream.
 */
export function evenDown(value: number, floor: number): number {
  if (!Number.isFinite(value)) {
    return floor;
  }
  const clamped = Math.max(floor, Math.floor(value));
  return clamped - (clamped % 2);
}

/** The display's real pixel count, clamped to what the encoders will take. */
export function nativeCaptureSize(display: DisplayInfo): Size {
  const scale =
    Number.isFinite(display.scaleFactor) && display.scaleFactor > 0
      ? display.scaleFactor
      : 1;

  const rawWidth = Math.max(0, display.width) * scale;
  const rawHeight = Math.max(0, display.height) * scale;

  if (rawWidth <= 0 || rawHeight <= 0) {
    return { width: MIN_CAPTURE_WIDTH, height: MIN_CAPTURE_HEIGHT };
  }

  // Shrink on the tighter axis so the aspect ratio survives the clamp. Fitting
  // each axis independently would stretch a 6K ultrawide into something the
  // display is not.
  const fit = Math.min(
    1,
    MAX_CAPTURE_WIDTH / rawWidth,
    MAX_CAPTURE_HEIGHT / rawHeight,
  );

  return {
    width: evenDown(rawWidth * fit, MIN_CAPTURE_WIDTH),
    height: evenDown(rawHeight * fit, MIN_CAPTURE_HEIGHT),
  };
}

/**
 * The frame the capture is actually asked for.
 *
 * `"native"` is the display's own pixels. The two fixed presets scale *down*
 * only — asking a 1280×800 display for "1080p" would upscale, spending bitrate
 * on pixels that carry no information, so the native size wins whenever it is
 * already smaller.
 */
export function captureSizeFor(
  display: DisplayInfo,
  quality: QualityPreset,
): Size {
  const native = nativeCaptureSize(display);
  const targetHeight = QUALITY_HEIGHTS[quality];

  if (targetHeight == null || native.height <= targetHeight) {
    return native;
  }

  // The height is the target, exactly, and the width follows from it. Scaling
  // both by `target / native.height` would go through a reciprocal that does
  // not round-trip: `1964 * (1080 / 1964)` is not reliably 1080, and one ulp
  // low turns into a frame two pixels short once `evenDown` floors it.
  const height = evenDown(targetHeight, MIN_CAPTURE_HEIGHT);

  return {
    width: evenDown(
      (native.width * height) / native.height,
      MIN_CAPTURE_WIDTH,
    ),
    height,
  };
}

/**
 * Sizes to try, largest first, when the encoder refuses the one asked for.
 *
 * A hardware H.264 encoder's real limits are not the codec's. VideoToolbox on
 * Apple silicon tops out around 4096×2304 whatever the level tables say, and a
 * scaled Retina display can easily be taller than that — a 16" MacBook at
 * "More Space" reports 1800×1169 points at 2×, which is 3600×2338, and 2338 is
 * over the line. The three profiles are all refused and the take never starts.
 *
 * Guessing the limit would be wrong on the next machine, so the recorder asks
 * instead: it walks this ladder through `VideoEncoder.isConfigSupported` and
 * takes the first size that is accepted. Every rung keeps the display's aspect
 * ratio, is even on both axes, and is strictly smaller than the one before, so
 * the walk terminates and never upscales.
 *
 * The bounds are the familiar delivery heights rather than anything derived:
 * whatever a machine's real limit is, it falls between two of these, and
 * landing on 2160 or 1440 is a better answer than landing on an odd number
 * nobody recognises.
 */
export function captureSizeLadder(size: Size): Size[] {
  const heights = [2160, 1440, 1080, 720];
  const ladder: Size[] = [size];

  for (const height of heights) {
    const previous = ladder[ladder.length - 1];
    if (height >= previous.height) {
      continue;
    }

    const next = {
      width: evenDown((size.width * height) / size.height, MIN_CAPTURE_WIDTH),
      height: evenDown(height, MIN_CAPTURE_HEIGHT),
    };

    if (next.width < previous.width && next.height < previous.height) {
      ladder.push(next);
    }
  }

  return ladder;
}

/** What the camera is asked for. 720p is what almost every webcam actually is. */
export const CAMERA_CAPTURE: Size & { fps: number } = {
  width: 1280,
  height: 720,
  fps: 30,
};

type BitrateRule = { bpp: number; min: number; max: number };

/**
 * Bits per pixel per frame, by what is being encoded.
 *
 * Screen content is not camera content. It is mostly flat, which is easy, and
 * then it is one-pixel-wide text edges, which is the hardest thing H.264 does —
 * the ringing around a subpixel-antialiased glyph is exactly what a DCT is bad
 * at. So the screen figure is deliberately over the ~0.07 that would be plenty
 * for a talking head at the same size.
 *
 * The composite pass re-encodes an already-encoded picture, so it is given
 * headroom over the screen figure: generation loss compounds, and the composite
 * is what the editor actually receives.
 */
const BITRATE_RULES: Record<"screen" | "camera" | "composite", BitrateRule> = {
  screen: { bpp: 0.11, min: 6_000_000, max: 40_000_000 },
  camera: { bpp: 0.07, min: 2_000_000, max: 12_000_000 },
  composite: { bpp: 0.132, min: 8_000_000, max: 48_000_000 },
};

/** Bits per second for a stream of this size at this rate. */
export function bitrateFor(
  kind: "screen" | "camera" | "composite",
  size: Size,
  fps: number,
): number {
  const rule = BITRATE_RULES[kind];
  const pixels = Math.max(0, size.width) * Math.max(0, size.height);
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const raw = pixels * rate * rule.bpp;

  if (!Number.isFinite(raw) || raw <= 0) {
    return rule.min;
  }

  return Math.round(Math.min(rule.max, Math.max(rule.min, raw)));
}

/**
 * How often a keyframe goes in, in frames.
 *
 * Two seconds. A GOP is the granularity at which anything can seek, and the
 * editor seeks constantly — scrubbing, the frame grid, the export's own
 * per-frame sampling. `tests/e2e/FINDINGS.md` records a one-frame-in-three seek
 * defect, which a long GOP makes worse and a short one does not cause.
 *
 * WebCodecs has no "GOP length" knob: the caller counts frames and passes
 * `{ keyFrame: true }`, which is why this returns a count rather than a config.
 */
export function keyFrameIntervalFrames(fps: number): number {
  const rate = Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 30;
  return Math.max(1, rate * 2);
}

/** H.264 profiles, best first. */
const AVC_PROFILES = [
  { name: "high", bytes: "6400" },
  { name: "main", bytes: "4D40" },
  { name: "baseline", bytes: "42E0" },
] as const;

export type AvcProfile = (typeof AVC_PROFILES)[number]["name"];

/**
 * H.264 levels, with the two limits that decide which one a picture needs.
 *
 * `maxFrameMbs` is the frame size in 16×16 macroblocks; `maxMbsPerSecond` is
 * that times the frame rate. Both come from Annex A of the spec. Only the
 * levels a desktop capture can plausibly need are listed — below 3.1 is smaller
 * than any display, and above 6.2 does not exist.
 */
const AVC_LEVELS = [
  { idc: 0x1f, maxFrameMbs: 3600, maxMbsPerSecond: 108000 }, // 3.1
  { idc: 0x20, maxFrameMbs: 5120, maxMbsPerSecond: 216000 }, // 3.2
  { idc: 0x28, maxFrameMbs: 8192, maxMbsPerSecond: 245760 }, // 4.0
  { idc: 0x2a, maxFrameMbs: 8704, maxMbsPerSecond: 522240 }, // 4.2
  { idc: 0x32, maxFrameMbs: 22080, maxMbsPerSecond: 589824 }, // 5.0
  { idc: 0x33, maxFrameMbs: 36864, maxMbsPerSecond: 983040 }, // 5.1
  { idc: 0x34, maxFrameMbs: 36864, maxMbsPerSecond: 2073600 }, // 5.2
  { idc: 0x3c, maxFrameMbs: 139264, maxMbsPerSecond: 4177920 }, // 6.0
  { idc: 0x3d, maxFrameMbs: 139264, maxMbsPerSecond: 8355840 }, // 6.1
  { idc: 0x3e, maxFrameMbs: 139264, maxMbsPerSecond: 16711680 }, // 6.2
] as const;

/** The frame size in macroblocks, which is what every level limit is stated in. */
export function macroblocksFor(size: Size): number {
  return (
    Math.ceil(Math.max(0, size.width) / 16) *
    Math.ceil(Math.max(0, size.height) / 16)
  );
}

/**
 * The lowest H.264 level that admits this picture at this rate.
 *
 * Lowest rather than highest on purpose: a level is a *promise to the decoder*
 * about how much work it will have to do, and overstating it locks out hardware
 * decoders that would have played the file. Falls back to the top level rather
 * than throwing — a picture past 6.2 is one no encoder here will accept anyway,
 * and the config probe is the right place for that to be reported.
 */
export function avcLevelIdc(size: Size, fps: number): number {
  const mbs = macroblocksFor(size);
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const mbsPerSecond = mbs * rate;

  const level = AVC_LEVELS.find(
    (candidate) =>
      mbs <= candidate.maxFrameMbs && mbsPerSecond <= candidate.maxMbsPerSecond,
  );

  return (level ?? AVC_LEVELS[AVC_LEVELS.length - 1]).idc;
}

/** e.g. `avc1.640033` — High profile, level 5.1. */
export function avcCodec(
  profile: AvcProfile,
  size: Size,
  fps: number,
): string {
  const entry =
    AVC_PROFILES.find((candidate) => candidate.name === profile) ??
    AVC_PROFILES[0];
  const idc = avcLevelIdc(size, fps)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

  return `avc1.${entry.bytes}${idc}`;
}

/**
 * Codec strings to try, best first.
 *
 * The caller walks these through `VideoEncoder.isConfigSupported` and takes the
 * first that answers yes. High profile is worth asking for — CABAC and 8×8
 * transforms are most of the reason H.264 beats its own baseline on screen
 * content — but a machine whose only hardware encoder is baseline should record
 * rather than refuse.
 */
export function avcCodecCandidates(size: Size, fps: number): string[] {
  return AVC_PROFILES.map((profile) => avcCodec(profile.name, size, fps));
}

/**
 * The full encoder configuration, minus the parts only the runtime knows.
 *
 * `latencyMode: "quality"` is the one that would be easy to leave at its
 * default. The default is `"realtime"`, which is right for a video call and
 * wrong here: it makes the encoder hold its bitrate flat frame by frame rather
 * than spending where the picture is hard, which on screen content means the
 * one frame that scrolled gets the same bits as the thousand that did not.
 */
export type EncoderPlan = {
  codecCandidates: string[];
  width: number;
  height: number;
  framerate: number;
  bitrate: number;
  keyFrameInterval: number;
};

export function encoderPlan(
  kind: "screen" | "camera" | "composite",
  size: Size,
  fps: number,
): EncoderPlan {
  const rate = Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 30;

  return {
    codecCandidates: avcCodecCandidates(size, rate),
    width: size.width,
    height: size.height,
    framerate: rate,
    bitrate: bitrateFor(kind, size, rate),
    keyFrameInterval: keyFrameIntervalFrames(rate),
  };
}
