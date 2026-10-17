/**
 * The per-clip arithmetic of the browser export's mix: channel layout, sample
 * rate, and level. Each function matches one stage of the desktop graph in
 * `electron/render/ffmpegArgs.ts#audioFilterFor`, and `dsp.test.ts` runs the
 * bundled ffmpeg on the same input as the reference.
 *
 * Samples are planar: one `Float32Array` per channel.
 */

import type { EnvelopePoint } from "./shared";

/** The quietest level that is still a level, `timeline/audio.ts#MIN_VOLUME_DB`. */
const MIN_VOLUME_DB = -60;

/**
 * `channelStageFor`, as a matrix.
 *
 * Stereo out: `pan=stereo|FL=FL+FC|FR=FR+FC`. `pan` drops a channel the input
 * does not have, so a mono source (its one channel is `FC`) is copied to both
 * sides at unity, a stereo source passes through, and a surround source
 * (WAVE order: FL FR FC ...) keeps its centre and drops its surrounds.
 *
 * Mono out: `pan=mono|FC<FL+FR+FC`, where `<` renormalises over the channels
 * present: a mono source passes through, a stereo one becomes the mean.
 */
export function toLayout(planes: readonly Float32Array[], channels: 1 | 2): Float32Array[] {
  const count = planes.length;
  const frames = count === 0 ? 0 : planes[0].length;
  if (count === 0) {
    return Array.from({ length: channels }, () => new Float32Array(0));
  }
  if (count === 1) {
    return channels === 1 ? [planes[0].slice()] : [planes[0].slice(), planes[0].slice()];
  }
  const left = planes[0];
  const right = planes[1];
  const centre = count >= 3 ? planes[2] : null;
  if (channels === 2) {
    if (centre == null) {
      return [left.slice(), right.slice()];
    }
    const outLeft = new Float32Array(frames);
    const outRight = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      outLeft[i] = left[i] + centre[i];
      outRight[i] = right[i] + centre[i];
    }
    return [outLeft, outRight];
  }
  const mono = new Float32Array(frames);
  if (centre == null) {
    for (let i = 0; i < frames; i++) {
      mono[i] = (left[i] + right[i]) / 2;
    }
  } else {
    for (let i = 0; i < frames; i++) {
      mono[i] = (left[i] + right[i] + centre[i]) / 3;
    }
  }
  return [mono];
}

function gcd(a: number, b: number): number {
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

/** Half the taps a windowed-sinc output sample reads, at unity bandwidth. */
const HALF_TAPS = 16;

/** A Blackman window over [-1, 1]. */
function blackman(x: number): number {
  if (x <= -1 || x >= 1) {
    return 0;
  }
  const t = (x + 1) / 2;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}

function sinc(x: number): number {
  if (x === 0) {
    return 1;
  }
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * A streaming windowed-sinc resampler for one clip's channels.
 *
 * Output sample `j` sits at input position `j * in / out`, so the first output
 * sample is the first input sample, as swresample aligns them. The ratio is
 * kept exact as a fraction, so the 44.1kHz to 48kHz case is 160 phases with a
 * filter table each and no drift over an hour of audio.
 *
 * Downsampling narrows the filter to the output's band, so nothing above the
 * new Nyquist folds back.
 *
 * Feed it in chunks of any size with `push`; it holds back the samples the
 * next outputs still need. `finish` flushes the tail against silence.
 */
export class Resampler {
  private readonly up: number;
  private readonly down: number;
  private readonly cutoff: number;
  private readonly half: number;
  private readonly table: Float32Array[] | null;
  /** Unconsumed input per channel, starting at absolute input index `base`. */
  private pending: Float32Array[];
  private base = 0;
  /** The next output sample's index. */
  private next = 0;

  constructor(
    readonly inRate: number,
    readonly outRate: number,
    readonly channels: number,
  ) {
    const divisor = gcd(inRate, outRate);
    this.up = outRate / divisor;
    this.down = inRate / divisor;
    this.cutoff = Math.min(1, outRate / inRate);
    this.half = Math.ceil(HALF_TAPS / this.cutoff);
    this.pending = Array.from({ length: channels }, () => new Float32Array(0));
    // One filter per phase when the phases are few enough to tabulate.
    this.table = this.up <= 4096 ? this.buildTable() : null;
  }

  get identity(): boolean {
    return this.inRate === this.outRate;
  }

  private buildTable(): Float32Array[] {
    const width = this.half * 2;
    const table: Float32Array[] = [];
    for (let phase = 0; phase < this.up; phase++) {
      const fraction = phase / this.up;
      const taps = new Float32Array(width);
      for (let k = 0; k < width; k++) {
        taps[k] = this.weight(fraction, k);
      }
      table.push(taps);
    }
    return table;
  }

  /** The weight of input `floor(x) - half + 1 + k` for an output at `floor(x) + fraction`. */
  private weight(fraction: number, k: number): number {
    const distance = k - this.half + 1 - fraction;
    return this.cutoff * sinc(distance * this.cutoff) * blackman(distance / this.half);
  }

  push(planes: readonly Float32Array[]): Float32Array[] {
    if (this.identity) {
      return planes.map((plane) => plane.slice());
    }
    this.pending = this.pending.map((held, c) => concat(held, planes[c]));
    return this.drain(false);
  }

  finish(): Float32Array[] {
    if (this.identity) {
      return Array.from({ length: this.channels }, () => new Float32Array(0));
    }
    return this.drain(true);
  }

  private drain(final: boolean): Float32Array[] {
    const available = this.base + this.pending[0].length;
    const out: number[][] = Array.from({ length: this.channels }, () => []);
    const width = this.half * 2;
    for (;;) {
      // Exact: the position is `next * down / up`, split into a whole input
      // index and a phase without any floating-point accumulation.
      const numerator = this.next * this.down;
      const whole = Math.floor(numerator / this.up);
      const phase = numerator - whole * this.up;
      const last = whole + this.half;
      if (final ? whole >= available : last >= available) {
        break;
      }
      const first = whole - this.half + 1;
      const taps = this.table?.[phase];
      for (let c = 0; c < this.channels; c++) {
        const held = this.pending[c];
        let sum = 0;
        for (let k = 0; k < width; k++) {
          const index = first + k - this.base;
          if (index < 0 || index >= held.length) {
            continue;
          }
          const w = taps != null ? taps[k] : this.weight(phase / this.up, k);
          sum += held[index] * w;
        }
        out[c].push(sum);
      }
      this.next++;
    }
    // Keep only what the next output still reads.
    const nextWhole = Math.floor((this.next * this.down) / this.up);
    const keepFrom = Math.max(this.base, nextWhole - this.half + 1);
    const drop = keepFrom - this.base;
    if (drop > 0) {
      this.pending = this.pending.map((held) => held.slice(drop));
      this.base = keepFrom;
    }
    return out.map((samples) => Float32Array.from(samples));
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) {
    return b.slice();
  }
  const joined = new Float32Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  return joined;
}

/** `gainFromDb`'s rule without its six-decimal rounding: -60 dB and below is off. */
function linear(db: number): number {
  return db <= MIN_VOLUME_DB ? 0 : 10 ** (db / 20);
}

/**
 * The level of a keyframed clip at clip-local timeline `tSec`, as the desktop
 * export's `volume=eval=frame` expression evaluates it
 * (`audioEnvelope.ts#volumeExprOf`): held flat before the first breakpoint and
 * after the last, interpolated in dB between them, and silent wherever the
 * line is at or below -60 dB.
 */
export function envelopeGainAt(points: readonly EnvelopePoint[], tSec: number): number {
  if (points.length === 0) {
    return 1;
  }
  const tMs = tSec * 1000;
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length === 1 || tMs < first.tMs) {
    return linear(first.db);
  }
  if (tMs > last.tMs) {
    return linear(last.db);
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!(b.tMs > a.tMs) || tMs > b.tMs) {
      continue;
    }
    const db = a.db + ((b.db - a.db) * (tMs - a.tMs)) / (b.tMs - a.tMs);
    return linear(db);
  }
  return linear(last.db);
}

/**
 * The frame size the desktop export evaluates its envelope on
 * (`asetnsamples=n=256`): one level per 256 samples, at the block's first.
 */
export const ENVELOPE_BLOCK = 256;

/**
 * Apply a clip's level in place.
 *
 * `offset` is the clip-local index of `planes[c][0]`, so a clip handed over in
 * pieces is levelled exactly as if it came in one: the 256-sample blocks are
 * counted from the clip's first sample.
 */
export function applyLevel(
  planes: Float32Array[],
  offset: number,
  sampleRate: number,
  gain: number,
  envelope: readonly EnvelopePoint[] | null,
): void {
  const frames = planes.length === 0 ? 0 : planes[0].length;
  if (envelope == null || envelope.length === 0) {
    if (gain === 1) {
      return;
    }
    for (const plane of planes) {
      for (let i = 0; i < frames; i++) {
        plane[i] *= gain;
      }
    }
    return;
  }
  let i = 0;
  while (i < frames) {
    const absolute = offset + i;
    const block = Math.floor(absolute / ENVELOPE_BLOCK);
    const end = Math.min(frames, (block + 1) * ENVELOPE_BLOCK - offset);
    const level = envelopeGainAt(envelope, (block * ENVELOPE_BLOCK) / sampleRate);
    for (const plane of planes) {
      for (let j = i; j < end; j++) {
        plane[j] *= level;
      }
    }
    i = end;
  }
}
