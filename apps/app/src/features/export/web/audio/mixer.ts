/**
 * The browser export's sound: every audible clip, placed and mixed, handed out
 * a block at a time.
 *
 * The desktop export builds this with an FFmpeg filter graph, one chain per
 * clip: layout, level, tempo, envelope, delay, then `amix` at unity. This is
 * the same chain in the same order, over a `PcmPort` that decodes (WebCodecs,
 * through Mediabunny, in `pcmSource.ts`), so the whole mix runs under
 * `environment: "node"` against a fake.
 *
 * Blocks are produced in order from the first sample, so the encoder can be fed
 * alongside the picture and nothing holds the whole mix in memory. A clip
 * playing at its own rate is decoded as it is reached. A retimed one (a speed
 * other than 1, or a ramp) is decoded whole and stretched once when the mix
 * reaches it, as the desktop export does before it spawns FFmpeg
 * (`renderedAudio.ts`), and under the same memory limit.
 *
 * Two differences, both deliberate:
 *
 *   - A constant speed goes through the same WSOLA stretch a ramp does
 *     (`speedStretch.ts`), where the desktop export uses `atempo`. Both keep
 *     the pitch; the length is exact either way.
 *   - The mix lasts exactly as long as the picture. `amix` stops at its
 *     longest input, so a desktop export whose sound ends early has a shorter
 *     audio track; here the rest is silence.
 */

import { curveSourceAt } from "../../../timeline/speedCurve";
import { needsStretch, type AudioClipPlan } from "./audioPlan";
import { Resampler, applyLevel, toLayout } from "./dsp";
import { MAX_PCM_BYTES, stretchAudio } from "./shared";

export type PcmChunk = {
  /** One plane per channel, as the file holds them. */
  readonly planes: readonly Float32Array[];
  readonly sampleRate: number;
};

export type PcmPort = {
  /**
   * The file's sound from `fromSec` for `durationSec` source seconds, decoded,
   * in order. Ends early where the file does; yields nothing for a file with
   * no sound.
   */
  read(localpath: string, fromSec: number, durationSec: number): AsyncIterable<PcmChunk>;
  /** A file's name, for a message that has to say which one. */
  nameOf?(localpath: string): string;
};

export type MixFormat = {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  /** Exactly this many frames are produced. */
  readonly totalFrames: number;
};

/** One clip's processed sound, pulled in order, exactly `length` frames long. */
class Voice {
  readonly start: number;
  readonly length: number;
  private produced = 0;
  private held: Float32Array[];
  private source: AsyncIterator<PcmChunk> | null = null;
  private resampler: Resampler | null = null;
  private drained = false;
  private stretched: Float32Array[] | null = null;

  constructor(
    private readonly clip: AudioClipPlan,
    private readonly port: PcmPort,
    private readonly format: MixFormat,
  ) {
    const { sampleRate } = format;
    this.start = Math.round((clip.delayMs * sampleRate) / 1000);
    this.length = Math.max(
      0,
      needsStretch(clip)
        ? Math.round((clip.spanMs / 1000) * sampleRate)
        : Math.round(clip.tSec * sampleRate),
    );
    this.held = this.emptyPlanes(0);
  }

  get done(): boolean {
    return this.produced >= this.length;
  }

  /** The next `frames` of this clip, levelled, zero past its end. */
  async pull(frames: number): Promise<Float32Array[]> {
    const out = needsStretch(this.clip)
      ? await this.pullStretched(frames)
      : await this.pullDecoded(frames);
    applyLevel(out, this.produced, this.format.sampleRate, this.clip.gain, this.clip.envelope);
    this.produced += frames;
    return out;
  }

  async close(): Promise<void> {
    const source = this.source;
    this.source = null;
    this.held = this.emptyPlanes(0);
    this.stretched = null;
    await source?.return?.();
  }

  private emptyPlanes(frames: number): Float32Array[] {
    return Array.from({ length: this.format.channels }, () => new Float32Array(frames));
  }

  /** Decode, lay out and resample until `frames` are held, or the source ends. */
  private async fill(frames: number): Promise<void> {
    if (this.source == null && !this.drained) {
      this.source = this.port
        .read(this.clip.localpath, this.clip.ssSec, this.clip.tSec)
        [Symbol.asyncIterator]();
    }
    while (this.held[0].length < frames && !this.drained) {
      const step = await this.source!.next();
      if (step.done) {
        this.drained = true;
        if (this.resampler != null) {
          this.append(this.resampler.finish());
        }
        break;
      }
      const { planes, sampleRate } = step.value;
      this.resampler ??= new Resampler(sampleRate, this.format.sampleRate, this.format.channels);
      this.append(this.resampler.push(toLayout(planes, this.format.channels)));
    }
  }

  private append(planes: Float32Array[]): void {
    if (planes.length === 0 || planes[0].length === 0) {
      return;
    }
    this.held = this.held.map((held, c) => {
      const joined = new Float32Array(held.length + planes[c].length);
      joined.set(held, 0);
      joined.set(planes[c], held.length);
      return joined;
    });
  }

  private async pullDecoded(frames: number): Promise<Float32Array[]> {
    const wanted = Math.max(0, Math.min(frames, this.length - this.produced));
    await this.fill(wanted);
    const out = this.emptyPlanes(frames);
    const available = Math.min(wanted, this.held[0].length);
    for (let c = 0; c < out.length; c++) {
      out[c].set(this.held[c].subarray(0, available), 0);
    }
    this.held = this.held.map((held) => held.slice(available));
    return out;
  }

  private async pullStretched(frames: number): Promise<Float32Array[]> {
    if (this.stretched == null) {
      this.stretched = await this.stretchWhole();
    }
    const out = this.emptyPlanes(frames);
    const from = this.produced;
    const to = Math.min(this.length, from + frames);
    for (let c = 0; c < out.length; c++) {
      if (to > from) {
        out[c].set(this.stretched[c].subarray(from, to), 0);
      }
    }
    return out;
  }

  /** The whole window, decoded and retimed, as `renderedAudio.ts` does for a ramp. */
  private async stretchWhole(): Promise<Float32Array[]> {
    const { channels, sampleRate } = this.format;
    const limitFrames = Math.floor(MAX_PCM_BYTES / (4 * channels));
    const name = this.port.nameOf?.(this.clip.localpath) ?? this.clip.localpath;
    const expected = Math.round(this.clip.tSec * sampleRate);
    if (expected > limitFrames || this.length > limitFrames) {
      throw new Error(
        `Cannot export: the speed change on ${name} covers more audio than can be retimed at once. Split the clip and try again.`,
      );
    }
    await this.fill(expected);
    const frames = Math.min(expected, this.held[0].length);
    const input = new Float32Array(frames * channels);
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        input[i * channels + c] = this.held[c][i];
      }
    }
    this.held = this.emptyPlanes(0);
    await this.source?.return?.();
    this.source = null;

    const { curve, trimStartMs, speed } = this.clip;
    const output = stretchAudio({
      input,
      channels,
      sampleRate,
      sourceStartMs: trimStartMs,
      sourceAt:
        curve != null
          ? (outputMs) => curveSourceAt(curve, trimStartMs, outputMs)
          : (outputMs) => trimStartMs + outputMs * speed,
      outputFrames: this.length,
    });

    const planes = this.emptyPlanes(this.length);
    for (let i = 0; i < this.length; i++) {
      for (let c = 0; c < channels; c++) {
        planes[c][i] = output[i * channels + c];
      }
    }
    return planes;
  }
}

export class AudioMix {
  private position = 0;
  private voices: Voice[];

  constructor(
    clips: readonly AudioClipPlan[],
    port: PcmPort,
    readonly format: MixFormat,
  ) {
    this.voices = clips
      .map((clip) => new Voice(clip, port, format))
      .filter((voice) => voice.length > 0 && voice.start < format.totalFrames);
  }

  /** Frames handed out so far. */
  get produced(): number {
    return this.position;
  }

  get finished(): boolean {
    return this.position >= this.format.totalFrames;
  }

  /** The next block of up to `maxFrames`, or `null` once the mix is complete. */
  async next(maxFrames: number): Promise<Float32Array[] | null> {
    if (this.finished) {
      return null;
    }
    const begin = this.position;
    const frames = Math.min(maxFrames, this.format.totalFrames - begin);
    const end = begin + frames;
    const out = Array.from({ length: this.format.channels }, () => new Float32Array(frames));

    const sounding = this.voices.filter(
      (voice) => voice.start < end && voice.start + voice.length > begin,
    );
    const pieces = await Promise.all(
      sounding.map(async (voice) => {
        const from = Math.max(begin, voice.start);
        const to = Math.min(end, voice.start + voice.length);
        return { at: from - begin, planes: await voice.pull(to - from) };
      }),
    );
    for (const { at, planes } of pieces) {
      for (let c = 0; c < out.length; c++) {
        const target = out[c];
        const source = planes[c];
        for (let i = 0; i < source.length; i++) {
          target[at + i] += source[i];
        }
      }
    }

    // A clip that has sounded its last frame lets go of its decoder now.
    const finished = this.voices.filter((voice) => voice.done || voice.start + voice.length <= end);
    this.voices = this.voices.filter((voice) => !finished.includes(voice));
    await Promise.all(finished.map((voice) => voice.close()));

    this.position = end;
    return out;
  }

  async close(): Promise<void> {
    const voices = this.voices;
    this.voices = [];
    await Promise.allSettled(voices.map((voice) => voice.close()));
  }
}
