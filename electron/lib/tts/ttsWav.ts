/**
 * The vocoder's float samples as a file the editor can import.
 *
 * No imports beyond `Buffer`, so this runs under `environment: "node"` and can
 * be checked against ffmpeg decoding the same bytes back.
 *
 * 44.1 kHz is the model's own rate (`tts.json#ae.sample_rate`) and is kept.
 * Resampling here would be a second approximation on top of the vocoder's, and
 * the editor already imports audio at whatever rate the file states.
 */

/** Mono, which is all the model produces. */
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const HEADER_BYTES = 44;

/**
 * Clamp and quantise one float sample to signed 16-bit.
 *
 * The asymmetry is deliberate. Signed 16-bit runs to +32767 but -32768, so
 * scaling both directions by 32768 would wrap the loudest positive peak to
 * full-scale negative: one sample of hard click on exactly the material most
 * likely to reach it.
 */
export function toPcm16(sample: number): number {
  // Silence, including for the infinities. A vocoder that produced one
  // non-finite sample rarely produced only one, and clamping a run of them to
  // full scale delivers a burst of square wave at maximum level.
  if (!Number.isFinite(sample)) {
    return 0;
  }
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
}

/**
 * A complete RIFF/WAVE file holding `samples`.
 *
 * Written in one allocation rather than appended, because a minute of 44.1 kHz
 * speech is 2.6 million samples and growing a Buffer per sample is what makes
 * a synthesis that took two seconds spend ten writing itself out.
 */
export function encodeWav(
  samples: ArrayLike<number>,
  sampleRate: number,
): Buffer {
  const rate = Math.max(1, Math.floor(sampleRate));
  const dataBytes = samples.length * (BITS_PER_SAMPLE / 8);
  const buffer = Buffer.alloc(HEADER_BYTES + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  // Every RIFF size field counts the bytes that follow it, not the whole file.
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");

  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk length
  buffer.writeUInt16LE(1, 20); // PCM, uncompressed
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE((rate * CHANNELS * BITS_PER_SAMPLE) / 8, 28); // byte rate
  buffer.writeUInt16LE((CHANNELS * BITS_PER_SAMPLE) / 8, 32); // block align
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);

  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(toPcm16(samples[i]), HEADER_BYTES + i * 2);
  }

  return buffer;
}

/** How long `sampleCount` frames last, in whole milliseconds. */
export function durationMsOf(sampleCount: number, sampleRate: number): number {
  if (sampleRate <= 0) {
    return 0;
  }
  return Math.round((sampleCount / sampleRate) * 1000);
}

/**
 * Lay chunks end to end with a gap between them.
 *
 * The gap is what keeps two sentences from running together when a long script
 * is synthesised in several passes. It goes *between* chunks only: a leading or
 * trailing silence would show up as a clip that starts late and outlasts its
 * own speech, which the user then has to trim by hand every time.
 */
export function joinChunks(
  chunks: readonly Float32Array[],
  sampleRate: number,
  gapSeconds: number,
): Float32Array {
  const present = chunks.filter((chunk) => chunk.length > 0);
  if (present.length === 0) {
    return new Float32Array(0);
  }

  const gap = Math.max(0, Math.round(gapSeconds * sampleRate));
  const total =
    present.reduce((sum, chunk) => sum + chunk.length, 0) +
    gap * (present.length - 1);

  const out = new Float32Array(total);
  let offset = 0;
  present.forEach((chunk, index) => {
    if (index > 0) {
      offset += gap;
    }
    out.set(chunk, offset);
    offset += chunk.length;
  });

  return out;
}
