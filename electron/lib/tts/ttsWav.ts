/**
 * The vocoder's float samples as a file the editor can import.
 *
 * No imports, and written through a `DataView` rather than a `Buffer`, so the
 * browser build's synthesis worker encodes with the same code the desktop
 * does. Runs under `environment: "node"` and is checked against ffmpeg
 * decoding the same bytes back.
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
 * speech is 2.6 million samples and growing a buffer per sample is what makes
 * a synthesis that took two seconds spend ten writing itself out.
 */
export function encodeWavBytes(
  samples: ArrayLike<number>,
  sampleRate: number,
): Uint8Array {
  const rate = Math.max(1, Math.floor(sampleRate));
  const dataBytes = samples.length * (BITS_PER_SAMPLE / 8);
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  ascii(0, "RIFF");
  // Every RIFF size field counts the bytes that follow it, not the whole file.
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");

  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk length
  view.setUint16(20, 1, true); // PCM, uncompressed
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, (rate * CHANNELS * BITS_PER_SAMPLE) / 8, true); // byte rate
  view.setUint16(32, (CHANNELS * BITS_PER_SAMPLE) / 8, true); // block align
  view.setUint16(34, BITS_PER_SAMPLE, true);

  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(HEADER_BYTES + i * 2, toPcm16(samples[i]), true);
  }

  return bytes;
}

/** `encodeWavBytes` as a `Buffer`, for the desktop worker's `writeFileSync`. */
export function encodeWav(
  samples: ArrayLike<number>,
  sampleRate: number,
): Buffer {
  const bytes = encodeWavBytes(samples, sampleRate);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
