/**
 * Retiming audio to a speed ramp, by WSOLA.
 *
 * ## Why this exists at all
 *
 * FFmpeg cannot do it. There is no `rubberband` in the bundled build, and
 * `atempo` takes only a constant factor. Its `tempo` option carries the runtime
 * flag, so `asendcmd` can step it, and that was measured before this file was
 * written: a ten-second source ramped 1x to 2x should deliver 6.9315s, and
 * stepping `atempo` delivered 6.91s in ten steps, 6.84s in a hundred and 6.77s
 * in a thousand. The error grows with the step count, because each command
 * costs the filter the tail of its current window. 21ms to 161ms of slip per
 * ramped clip is not a sync budget, so the sound is retimed here and handed to
 * FFmpeg as an ordinary input playing at 1x.
 *
 * ## Why the length is exact
 *
 * The synthesis hop is **fixed**. Output frame `k` is written at `k * Hs`
 * whatever the rate, and the analysis position it reads from is looked up fresh
 * from `sourceAt` rather than advanced by an accumulator. So the k-th output
 * sample names the analytically correct source instant however long the clip
 * runs, and no error accumulates for a longer one. The caller states
 * `outputFrames` and gets exactly that many, which is what keeps `adelay` and
 * the mix placing the clip to the sample.
 *
 * ## Why WSOLA and not a resampler
 *
 * A plain resampler is fifty lines and has no window, no search and no
 * artefacts to tune, but it moves the pitch with the rate. Today a constant 2x
 * clip is pitch-preserving in both the preview (Chromium's default
 * `preservesPitch`) and the export (`atempo`), so varispeed ramps would make
 * flattening a ramp change the character of the sound. The stretcher is behind
 * one function signature so that choice stays a one-file change.
 *
 * Knows nothing about speed curves: the caller passes the map as a closure, so
 * the suite can drive it with a constant rate and check it against `atempo`.
 */

/** Analysis window, in ms. 40ms at 48kHz is 1920 frames. */
export const WINDOW_MS = 40;

/**
 * How far the search may move an analysis window, in ms.
 *
 * The whole cost of the algorithm is here: every output frame correlates
 * `2 * radius` candidate positions. Five milliseconds covers a pitch period
 * down to 200Hz, which is below any speaking voice, and keeps the pre-pass at a
 * small fraction of the frame loop it runs before.
 */
export const SEARCH_MS = 5;

/**
 * Most PCM one clip may decode to, in bytes.
 *
 * 512MB is about 46 minutes of 48kHz stereo, well past any clip somebody ramps
 * by hand, and a stated limit that **refuses** is the point: the alternative is
 * a pre-pass that quietly exhausts the main process during an export. A ramped
 * clip longer than this is rejected with its own name, exactly as a missing
 * input file is.
 */
export const MAX_PCM_BYTES = 512 * 1024 * 1024;

export type StretchRequest = {
  /** Interleaved f32 samples of exactly the clip's source window. */
  input: Float32Array;
  channels: number;
  sampleRate: number;
  /** Source ms shown at input frame 0, which is the clip's `trim.startTime`. */
  sourceStartMs: number;
  /**
   * The source instant an output instant shows, both in ms and both clip-local
   * on the output side.
   *
   * The inverse of the time map, and the only thing this function knows about
   * the ramp. Must be non-decreasing, which a speed bounded strictly above zero
   * guarantees.
   */
  sourceAt: (outputMs: number) => number;
  /** Exactly this many output frames are produced. */
  outputFrames: number;
};

/** A periodic Hann window, which sums to one at fifty percent overlap. */
function hann(length: number): Float32Array {
  const window = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
  }
  return window;
}

/**
 * How well the segment at `candidate` continues the one at `expected`.
 *
 * Normalised, so a loud stretch does not out-score a well-matched quiet one,
 * and measured on the channel sum so every channel is shifted together: picking
 * an offset per channel would make the stereo image wander inside a ramp.
 *
 * Strided by two. At 48kHz consecutive samples of anything a microphone
 * recorded are nearly identical, so half of them decide the same answer for
 * twice the work.
 */
function similarity(
  input: Float32Array,
  channels: number,
  frames: number,
  candidate: number,
  expected: number,
  length: number,
): number {
  let dot = 0;
  let energy = 0;
  for (let n = 0; n < length; n += 2) {
    const a = candidate + n;
    const b = expected + n;
    if (a < 0 || b < 0 || a >= frames || b >= frames) {
      continue;
    }
    let left = 0;
    let right = 0;
    for (let c = 0; c < channels; c++) {
      left += input[a * channels + c];
      right += input[b * channels + c];
    }
    dot += left * right;
    energy += left * left;
  }
  if (energy <= 0) {
    return dot === 0 ? 0 : -Infinity;
  }
  return dot / Math.sqrt(energy);
}

/**
 * Retime one clip's audio, pitch preserved.
 *
 * Returns exactly `outputFrames * channels` interleaved samples.
 */
export function stretchAudio(request: StretchRequest): Float32Array {
  const { input, channels, sampleRate, sourceStartMs, sourceAt, outputFrames } =
    request;

  const out = new Float32Array(Math.max(0, outputFrames) * channels);
  if (outputFrames <= 0 || channels <= 0 || sampleRate <= 0) {
    return out;
  }

  const frames = Math.floor(input.length / channels);
  if (frames <= 0) {
    return out;
  }

  const windowFrames = Math.max(2, Math.round((WINDOW_MS / 1000) * sampleRate) & ~1);
  const hop = windowFrames >> 1;
  const search = Math.max(0, Math.round((SEARCH_MS / 1000) * sampleRate));
  const window = hann(windowFrames);

  // Accumulated window weight per output frame. Dividing by it at the end makes
  // reconstruction exact wherever the overlap is uniform *and* at the two ends,
  // where it is not: the first half window and the last one would otherwise be
  // faded in and out by the window they were multiplied by.
  const weight = new Float32Array(outputFrames);

  // Where the previous segment would have carried on to. The whole of WSOLA:
  // the next segment is chosen to continue this waveform rather than to sit at
  // the arithmetically correct place, which is what keeps the phase from
  // jumping and the sound from warbling.
  let expected = -1;

  // The first window starts half a hop before the output, so its second half
  // completes the overlap on `[0, hop)` and the clip does not fade in.
  for (let start = -hop; start < outputFrames; start += hop) {
    const centreMs = ((start + hop) / sampleRate) * 1000;
    const wanted = sourceAt(centreMs) - sourceStartMs;
    let analysis =
      Math.round((wanted / 1000) * sampleRate) - hop;

    if (expected >= 0 && search > 0) {
      let best = analysis;
      let bestScore = -Infinity;
      for (let offset = -search; offset <= search; offset++) {
        const candidate = analysis + offset;
        if (candidate < 0 || candidate + hop > frames) {
          continue;
        }
        const score = similarity(
          input,
          channels,
          frames,
          candidate,
          expected,
          hop,
        );
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      analysis = best;
    }

    for (let n = 0; n < windowFrames; n++) {
      const outFrame = start + n;
      if (outFrame < 0 || outFrame >= outputFrames) {
        continue;
      }
      const inFrame = analysis + n;
      if (inFrame < 0 || inFrame >= frames) {
        continue;
      }
      const gain = window[n];
      for (let c = 0; c < channels; c++) {
        out[outFrame * channels + c] += gain * input[inFrame * channels + c];
      }
      weight[outFrame] += gain;
    }

    expected = analysis + hop;
  }

  for (let frame = 0; frame < outputFrames; frame++) {
    const total = weight[frame];
    // A frame nothing reached stays silent rather than being divided by noise.
    // Only reachable past the end of a source that ran short, which is the case
    // the caller pads for.
    if (total <= 1e-6) {
      continue;
    }
    for (let c = 0; c < channels; c++) {
      out[frame * channels + c] /= total;
    }
  }

  return out;
}
