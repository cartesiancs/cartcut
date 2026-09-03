/**
 * Microphone in, raw PCM out.
 *
 * Uncompressed, deliberately. The recording is going straight into an editor,
 * and every codec in the chain is a decision that cannot be taken back — so the
 * signal stays untouched until the one AAC encode at mux time, where it is
 * transparent and where the alternative (a second generation over Opus) is not.
 * Speech at 48kHz mono is 96 kB/s; a half-hour take is 170 MB of temp file,
 * which is nothing beside the video beside it.
 *
 * Headerless, equally deliberately. A WAV header states the data length, which
 * is not known until the recording stops, so a WAV written incrementally has to
 * be patched afterwards — and a patch that fails leaves a file that looks valid
 * and plays as noise. `recordMux.ts` passes the format on the command line
 * instead, from the same constants that wrote it.
 *
 * An `AudioWorklet` rather than the old `ScriptProcessorNode`: the worklet runs
 * on the audio thread, so a busy main thread — one encoding video, for
 * instance — cannot make it drop a buffer.
 */

/**
 * The worklet, as source.
 *
 * Delivered as a blob URL rather than a file because `addModule` takes a URL
 * and a bundler would otherwise need a separate entry point, an output name and
 * a base path that survives `loadFile`. Three build-config problems traded for
 * one string.
 */
const PROCESSOR_SOURCE = `
class PcmWriter extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input == null || input.length === 0 || input[0] == null) {
      return true;
    }

    const channels = input.length;
    const frames = input[0].length;
    const out = new Int16Array(frames * channels);

    for (let f = 0; f < frames; f += 1) {
      for (let c = 0; c < channels; c += 1) {
        const sample = Math.max(-1, Math.min(1, input[c][f]));
        // Asymmetric on purpose: signed 16-bit runs -32768..32767, so scaling
        // both directions by 32767 wastes a step and scaling both by 32768
        // wraps the loudest positive sample to full-scale negative.
        out[f * channels + c] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
    }

    this.port.postMessage(out, [out.buffer]);
    return true;
  }
}

registerProcessor("pcm-writer", PcmWriter);
`;

/**
 * How much PCM to gather before sending it across.
 *
 * A worklet renders 128 frames at a time, which at 48kHz is 375 messages a
 * second. Each one crossing the IPC boundary on its own would cost more in
 * structured-clone overhead than the audio itself is worth, so they are pooled
 * into roughly a tenth of a second.
 */
const BATCH_MS = 100;

export type AudioWriter = {
  readonly sampleRate: number;
  readonly channels: number;
  /** `performance.now()` when the first sample arrived. */
  readonly startedAt: number;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
};

export type AudioWriterOptions = {
  stream: MediaStream;
  onChunk: (bytes: Uint8Array) => Promise<void>;
  onError: (error: Error) => void;
};

export async function startAudioWriter(
  options: AudioWriterOptions,
): Promise<AudioWriter> {
  const context = new AudioContext();
  const moduleUrl = URL.createObjectURL(
    new Blob([PROCESSOR_SOURCE], { type: "application/javascript" }),
  );

  try {
    await context.audioWorklet.addModule(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }

  const source = context.createMediaStreamSource(options.stream);
  const node = new AudioWorkletNode(context, "pcm-writer");

  // Not connected to `context.destination`. Routing the microphone to the
  // speakers while recording the speakers is a feedback loop, and the analyser
  // in `features/record/audioRecord.ts` is left unconnected for the same
  // reason. A worklet's `process` runs whether or not its output goes anywhere.
  source.connect(node);

  const channels = Math.max(1, node.channelCount);
  let startedAt = Number.NaN;
  let paused = false;
  let stopped = false;

  let pending: Int16Array[] = [];
  let pendingFrames = 0;
  const batchFrames = Math.round((context.sampleRate * BATCH_MS) / 1000);

  let writes: Promise<void> = Promise.resolve();
  let failed = false;

  const fail = (error: Error) => {
    if (!failed) {
      failed = true;
      options.onError(error);
    }
  };

  const flush = () => {
    if (pending.length === 0) {
      return;
    }

    const total = pending.reduce((sum, part) => sum + part.length, 0);
    const merged = new Int16Array(total);
    let offset = 0;
    for (const part of pending) {
      merged.set(part, offset);
      offset += part.length;
    }

    pending = [];
    pendingFrames = 0;

    const bytes = new Uint8Array(
      merged.buffer,
      merged.byteOffset,
      merged.byteLength,
    );

    writes = writes
      .then(() => options.onChunk(bytes))
      .catch((error) => fail(error as Error));
  };

  node.port.onmessage = (event: MessageEvent<Int16Array>) => {
    if (stopped || paused || failed) {
      return;
    }

    if (Number.isNaN(startedAt)) {
      // The first sample, not the first setup call: everything downstream lines
      // the microphone up against the first video frame, and the gap between
      // "the graph was built" and "audio actually flowed" is most of the offset
      // being corrected for.
      startedAt = performance.now();
    }

    pending.push(event.data);
    pendingFrames += event.data.length / channels;

    if (pendingFrames >= batchFrames) {
      flush();
    }
  };

  return {
    sampleRate: context.sampleRate,
    channels,
    get startedAt() {
      return startedAt;
    },

    pause() {
      // Drop what is buffered rather than writing it: the paused stretch is
      // removed from the video too, and a tail of audio from before the pause
      // would land against the picture from after it.
      paused = true;
      pending = [];
      pendingFrames = 0;
    },

    resume() {
      paused = false;
    },

    async stop() {
      stopped = true;
      flush();

      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();

      await context.close().catch(() => {
        // Already closed, or never opened. Neither is worth reporting on the
        // way out of a take.
      });

      await writes;
    },
  };
}
