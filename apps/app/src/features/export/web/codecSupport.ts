/**
 * Can this browser encode what the export plan asks for?
 *
 * Asked once, before the frame loop, so a missing encoder is a sentence naming
 * it rather than a half-written file. AAC is the one gap with a remedy: some
 * browsers ship no AAC encoder in WebCodecs (it is optional in the spec), and
 * Mediabunny's extension supplies FFmpeg's, compiled to WebAssembly, in a
 * worker. It is registered only where the browser's own is missing, so a
 * platform encoder is never replaced.
 */

import { registerAacEncoder } from "@mediabunny/aac-encoder";
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BufferSource,
  BufferTarget,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
} from "mediabunny";
import type { WebEncodePlan } from "./encodeSettings";

let aacFallbackRegistered = false;

/** Whether this page can run the browser export at all. */
export function webExportAvailable(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined";
}

const VIDEO_LABEL = { avc: "H.264", vp9: "VP9" } as const;
const AUDIO_LABEL = { aac: "AAC", opus: "Opus" } as const;

export async function ensureEncoders(
  plan: WebEncodePlan,
  frame: { width: number; height: number; fps: number },
): Promise<void> {
  const videoOk = await canEncodeVideo(plan.video.codec, {
    width: frame.width,
    height: frame.height,
    frameRate: frame.fps,
    bitrate: plan.video.bitrate,
    hardwareAcceleration: plan.video.hardwareAcceleration,
  });
  if (!videoOk) {
    throw new Error(
      `Cannot export: this browser cannot encode ${VIDEO_LABEL[plan.video.codec]} at ${frame.width}x${frame.height}.`,
    );
  }

  const audioOptions = {
    numberOfChannels: plan.audio.channels,
    sampleRate: plan.audio.sampleRate,
    bitrate: new Quality({ bitrate: plan.audio.bitrate }),
  };
  let audioOk = await canEncodeAudio(plan.audio.codec, audioOptions);
  if (!audioOk && plan.audio.codec === "aac" && !aacFallbackRegistered) {
    registerAacEncoder();
    aacFallbackRegistered = true;
    audioOk = await canEncodeAudio(plan.audio.codec, audioOptions);
  }
  if (!audioOk) {
    throw new Error(
      `Cannot export: this browser cannot encode ${AUDIO_LABEL[plan.audio.codec]} at ${plan.audio.sampleRate} Hz.`,
    );
  }
}

/** Where a burst lands after a round trip, against where it went in. */
const PROBE_AT = 4800;
const PROBE_LENGTH = 960;
const PROBE_SEARCH = 6000;

/** A fixed noise burst: the same samples on every run, so the probe is repeatable. */
function probeBurst(): Float32Array {
  const burst = new Float32Array(PROBE_LENGTH);
  let seed = 0x2f6b;
  for (let i = 0; i < PROBE_LENGTH; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / PROBE_LENGTH);
    burst[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.5 * window;
  }
  return burst;
}

/**
 * How many samples late a player hears this encoder's output, in samples.
 *
 * An audio encoder emits some priming before the first input sample: 2112
 * samples for Apple's AAC encoder, 1024 for FFmpeg's. WebCodecs does not
 * report it, and a file that does not say so plays its sound late by that
 * much (44ms against the picture, measured, for AAC on macOS). So it is
 * measured here: a burst is put through the same encoder and container,
 * read back with the same demuxer and decoder a player would use, and found
 * by cross-correlation. The export then starts its sound that many samples
 * early, and the MP4 writer trims the stretch before zero with an edit list.
 *
 * A container that already carries the delay (Opus's pre-skip in WebM)
 * measures as zero, and nothing is shifted.
 */
export async function measureAudioDelay(plan: WebEncodePlan): Promise<number> {
  const { sampleRate, channels, codec, bitrate } = plan.audio;
  const total = PROBE_AT + PROBE_SEARCH + PROBE_LENGTH;
  const burst = probeBurst();
  const planar = new Float32Array(total * channels);
  for (let c = 0; c < channels; c++) {
    planar.set(burst, c * total + PROBE_AT);
  }

  const output = new Output({
    format: plan.container === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat(),
    target: new BufferTarget(),
  });
  const source = new AudioSampleSource({ codec, bitrate: new Quality({ bitrate }) });
  output.addAudioTrack(source);
  await output.start();
  const sample = new AudioSample({
    data: planar,
    format: "f32-planar",
    numberOfChannels: channels,
    sampleRate,
    timestamp: 0,
  });
  await source.add(sample);
  sample.close();
  await output.finalize();

  const input = new Input({
    source: new BufferSource(output.target.buffer!),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (track == null) {
      return 0;
    }
    // The decoded sound on its own timeline, where index 0 is time 0.
    const decoded = new Float32Array(total + PROBE_SEARCH);
    for await (const chunk of new AudioSampleSink(track).samples()) {
      const start = Math.round(chunk.timestamp * sampleRate);
      const plane = new Float32Array(chunk.numberOfFrames);
      chunk.copyTo(plane, { planeIndex: 0, format: "f32-planar" });
      for (let i = 0; i < plane.length; i++) {
        const at = start + i;
        if (at >= 0 && at < decoded.length) {
          decoded[at] = plane[i];
        }
      }
      chunk.close();
    }
    let bestLag = 0;
    let best = -Infinity;
    for (let lag = -PROBE_AT; lag <= PROBE_SEARCH; lag++) {
      let sum = 0;
      for (let i = 0; i < PROBE_LENGTH; i++) {
        const at = PROBE_AT + lag + i;
        if (at >= 0 && at < decoded.length) {
          sum += burst[i] * decoded[at];
        }
      }
      if (sum > best) {
        best = sum;
        bestLag = lag;
      }
    }
    return Math.max(0, bestLag);
  } finally {
    input.dispose();
  }
}
