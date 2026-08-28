/**
 * Checking the audio the export actually delivered.
 *
 * Deliberately *not* a second implementation of `buildFFmpegArgs`. Asserting
 * the argv is `electron/render/ffmpegArgs.test.ts`'s job and it already does it
 * thoroughly; repeating it here would only prove the copy matches the original.
 * What that unit test cannot say is whether the file that came out has the
 * sound in it. So everything below is an observable property of the delivered
 * file, derived from where the scenario put its clips.
 */

import { spawn } from "node:child_process";

import { FFMPEG } from "./paths";

function runFfmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    // `-f null -` exits 0 on success; the interesting output is on stderr for
    // silencedetect and on stdout for the metadata printer.
    child.on("close", () => resolve({ stdout, stderr }));
  });
}

export type SilenceWindow = { startSec: number; endSec: number; durationSec: number };

/**
 * Where the delivered audio is silent.
 *
 * `-50 dB` sits below anything the fixtures contain and comfortably above AAC's
 * noise floor in a genuinely silent passage, so the boundaries land on the real
 * transitions rather than on encoder hiss.
 */
export async function detectSilence(
  file: string,
  { noiseDb = -50, minDurationSec = 0.15 } = {},
): Promise<SilenceWindow[]> {
  const { stderr } = await runFfmpeg([
    "-hide_banner", "-nostdin", "-loglevel", "info",
    "-i", file, "-map", "0:a",
    "-af", `silencedetect=noise=${noiseDb}dB:d=${minDurationSec}`,
    "-f", "null", "-",
  ]);

  const windows: SilenceWindow[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split("\n")) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (start != null) {
      pendingStart = Number(start[1]);
      continue;
    }
    const end = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (end != null && pendingStart != null) {
      const endSec = Number(end[1]);
      windows.push({ startSec: pendingStart, endSec, durationSec: endSec - pendingStart });
      pendingStart = null;
    }
  }
  // A file that ends silent reports a start with no end.
  if (pendingStart != null) {
    windows.push({ startSec: pendingStart, endSec: Infinity, durationSec: Infinity });
  }
  return windows;
}

export type RmsBucket = { atSec: number; db: number };

/**
 * A dB envelope, one bucket per `bucketMs`.
 *
 * The obvious `astats=reset=N` is wrong and quietly so: `reset` counts *frames*,
 * not samples, so `reset=48000` yields one measurement per 48,000 frames rather
 * than one per second. `asetnsamples` is what actually fixes the bucket size,
 * and `ametadata=print` is what gets the numbers out.
 */
export async function rmsEnvelope(file: string, bucketMs = 100): Promise<RmsBucket[]> {
  const samplesPerBucket = Math.round((48000 * bucketMs) / 1000);
  const { stdout } = await runFfmpeg([
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-i", file, "-map", "0:a",
    "-af",
    [
      "aformat=channel_layouts=mono",
      `asetnsamples=n=${samplesPerBucket}:p=0`,
      "astats=metadata=1:reset=1",
      "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    ].join(","),
    "-f", "null", "-",
  ]);

  const buckets: RmsBucket[] = [];
  let atSec = 0;
  for (const line of stdout.split("\n")) {
    const time = line.match(/pts_time:([\d.]+)/);
    if (time != null) {
      atSec = Number(time[1]);
      continue;
    }
    const value = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf)/);
    if (value != null) {
      buckets.push({ atSec, db: value[1] === "-inf" ? -Infinity : Number(value[1]) });
    }
  }
  return buckets;
}

/** Integrated loudness and true peak — one number that moves if the mix changes. */
export async function loudness(file: string): Promise<{ integratedLufs: number | null; truePeakDb: number | null }> {
  const { stderr } = await runFfmpeg([
    "-hide_banner", "-nostdin",
    "-i", file, "-map", "0:a",
    "-af", "ebur128=peak=true",
    "-f", "null", "-",
  ]);
  const integrated = stderr.match(/I:\s*(-?[\d.]+)\s*LUFS/);
  const peak = stderr.match(/Peak:\s*(-?[\d.]+)\s*dBFS/);
  return {
    integratedLufs: integrated ? Number(integrated[1]) : null,
    truePeakDb: peak ? Number(peak[1]) : null,
  };
}

/**
 * Where the loudest moments are, to the nearest bucket.
 *
 * Used for the A/V sync anchor: the fixture puts a 2 kHz click and a white
 * flash on the *same* frame numbers, generated together, so the click's peak
 * should land on the flash's frame. That is the only assertion in the suite
 * that tests sync rather than testing the two streams independently.
 */
export function peakTimes(buckets: RmsBucket[], aboveDb: number): number[] {
  const peaks: number[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i];
    if (bucket.db < aboveDb) continue;
    const previous = buckets[i - 1]?.db ?? -Infinity;
    const next = buckets[i + 1]?.db ?? -Infinity;
    if (bucket.db >= previous && bucket.db >= next) peaks.push(bucket.atSec);
  }
  return peaks;
}

/** Pearson correlation, for comparing two dB envelopes over the same window. */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? 0 : num / den;
}

/** Buckets inside a window, with `-Infinity` floored so the maths stays finite. */
export function windowDb(buckets: RmsBucket[], fromSec: number, toSec: number, floorDb = -90): number[] {
  return buckets
    .filter((b) => b.atSec >= fromSec && b.atSec < toSec)
    .map((b) => (Number.isFinite(b.db) ? b.db : floorDb));
}
