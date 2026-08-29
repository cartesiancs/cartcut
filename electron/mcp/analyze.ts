/**
 * Audio analysis for the MCP tools, headless.
 *
 * The agent has always edited from words alone. It could read what was said and
 * when, and nothing else — not where the room went quiet, not how loud a moment
 * was, not where the beat fell. So "cut on the beat" was guesswork and "punch
 * in on the loud bit" was not expressible at all.
 *
 * This is the shell around `analysis/signal.ts`: decode, measure, cache. Every
 * piece of arithmetic lives in that module, which is free of ffmpeg and
 * Electron and therefore testable against signals whose answer is known by
 * construction. Nothing here does maths.
 *
 * Caching follows `transcribe.ts` exactly, and for the same reason: an agent
 * asks for the same clip more than once — once to plan, again to place — and
 * the decode is the slow part. Keyed by the file's identity rather than its
 * name, so re-exporting over a path correctly misses.
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { app } from "electron";
import { ffmpegConfig } from "../lib/ffmpeg";
import { toFsPath } from "./localpath";
import {
  detectOnsets,
  estimateTempo,
  rmsEnvelope,
  silentRanges,
  trackBeats,
  type Envelope,
  type Range,
  type Tempo,
} from "./analysis/signal";

/**
 * The rate everything below is measured at.
 *
 * 16 kHz mono, the same as the STT path takes. Every feature here is driven by
 * energy rather than by anything living near the top of the spectrum, so a
 * higher rate would cost decode time and change no answer.
 */
const ANALYSIS_RATE = 16_000;

/** Envelope resolution. 10ms is finer than any cut a person would place. */
const HOP_MS = 10;

/**
 * How sure of a pulse we have to be before reporting beats at all.
 *
 * Speech scores about 0.2 and music about 0.6, measured. Between them is where
 * a wrong grid does the most damage, so the threshold sits above the middle:
 * an empty `beats` costs a caller nothing, and a plausible-looking wrong one
 * costs it the edit.
 */
const MIN_BEAT_CONFIDENCE = 0.4;


export type AudioAnalysis = {
  durationMs: number;
  silences: Range[];
  onsets: number[];
  tempo: Tempo | null;
  /** Measured beat times. Empty when there is no pulse to follow. */
  beats: number[];
  /** Full resolution, for the caller to window and downsample. */
  envelope: Envelope;
};

function cacheDir(): string {
  const dir = path.join(app.getPath("userData"), "analysis");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Cache key from the file's identity, not its path.
 *
 * The version suffix is deliberate: change a threshold or the detector and
 * every stored answer is stale in a way nothing else would notice. Bump it in
 * the same commit as the change.
 */
function cacheKey(filepath: string): string {
  const stat = fs.statSync(filepath);
  return createHash("sha1")
    .update(`${filepath}:${stat.size}:${stat.mtimeMs}:v1:${ANALYSIS_RATE}:${HOP_MS}`)
    .digest("hex");
}

function readCache(key: string): AudioAnalysis | null {
  const file = path.join(cacheDir(), `${key}.json`);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as AudioAnalysis;
  } catch {
    // A truncated write from a previous crash. Re-measuring is cheaper than
    // reasoning about half an envelope.
    return null;
  }
}

function writeCache(key: string, analysis: AudioAnalysis) {
  fs.writeFileSync(
    path.join(cacheDir(), `${key}.json`),
    JSON.stringify(analysis),
    "utf8",
  );
}

/**
 * Decode to raw mono float samples.
 *
 * `f32le` straight out of ffmpeg on stdout, rather than a wav on disk: there is
 * no header to parse and no temp file to clean up, and the samples are already
 * in the `[-1, 1]` the signal module works in.
 *
 * `spawn` rather than `fluent-ffmpeg`, which every other ffmpeg site here uses.
 * That wrapper validates the requested format against a capability list it
 * probes for, and it refused `f32le` — *"Output format f32le is not
 * available"* — against a binary whose own `-muxers` lists it. This is one
 * fixed pipe with no codec juggling, so the wrapper is a layer that can only
 * take options away.
 */
function decodeMono(mediaPath: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stderr = "";

    const child = spawn(ffmpegConfig.FFMPEG_PATH, [
      "-v", "error",
      "-i", mediaPath,
      "-vn",
      "-acodec", "pcm_f32le",
      "-ar", String(ANALYSIS_RATE),
      "-ac", "1",
      "-f", "f32le",
      "pipe:1",
    ]);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) =>
      reject(
        new Error(`Could not read audio from ${mediaPath}: ${error.message}`),
      ),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Could not read audio from ${mediaPath}: ffmpeg exited ${code}. ${stderr.trim()}`,
          ),
        );
        return;
      }
      const buffer = Buffer.concat(chunks);
      // `Buffer.concat` is byte-aligned but not necessarily 4-aligned at its own
      // offset, so copy rather than viewing onto its backing store.
      const samples = new Float32Array(Math.floor(buffer.byteLength / 4));
      for (let i = 0; i < samples.length; i++) {
        samples[i] = buffer.readFloatLE(i * 4);
      }
      resolve(samples);
    });
  });
}

/**
 * Measure one media file, from cache when it has been seen before.
 *
 * A file with no audio track is not an error — ffmpeg yields nothing and the
 * result is an empty analysis, which is the honest answer for a silent GIF and
 * lets a caller ask about every clip without checking types first.
 */
export async function analyzeFile(source: string): Promise<AudioAnalysis> {
  // A clip's `localpath` is a percent-encoded `file://` URL, not a path.
  const mediaPath = toFsPath(source);
  if (!fs.existsSync(mediaPath)) {
    throw new Error(`No such file: ${mediaPath}`);
  }

  const key = cacheKey(mediaPath);
  const cached = readCache(key);
  if (cached != null) {
    return cached;
  }

  const samples = await decodeMono(mediaPath);
  const envelope = rmsEnvelope(samples, ANALYSIS_RATE, HOP_MS);
  const tempo = estimateTempo(envelope);

  const analysis: AudioAnalysis = {
    durationMs: Math.round((samples.length / ANALYSIS_RATE) * 1000),
    silences: silentRanges(envelope),
    onsets: detectOnsets(envelope),
    tempo,
    // Only worth tracking when there is a pulse to track. Below the threshold
    // the "beats" would be a grid laid over speech, which is worse than none:
    // it looks deliberate and lands wrong.
    beats:
      tempo != null && tempo.confidence >= MIN_BEAT_CONFIDENCE
        ? trackBeats(envelope, tempo.bpm)
        : [],
    envelope,
  };

  writeCache(key, analysis);
  return analysis;
}

/**
 * Cap an analysis to what fits in a tool result.
 *
 * Tool output is capped at 25,000 tokens and a five-minute music track can
 * carry thousands of onsets, which is enough to blow that on its own.
 * `onsetCount` stays exact so a truncation is visible rather than reading like
 * a quiet passage — the same rule `serialize.ts` follows.
 *
 * Windowing is by **timeline** ms and therefore happens after `map_analysis`,
 * not here: these are source-file times and comparing them against a window the
 * agent gave in timeline ms is exactly the mix-up the two-step conversion
 * exists to prevent.
 *
 * The envelope is deliberately not projected. It is a dense uniform grid, and
 * putting it on the timeline needs a conversion of a different shape from the
 * event lists — so it stays in the cache, where the waveform strip will want it,
 * rather than being returned in a time base the caller would have to guess at.
 */
export function capAnalysis(
  analysis: Pick<AudioAnalysis, "silences" | "onsets" | "tempo" | "beats">,
  maxOnsets = 200,
) {
  return {
    tempo: analysis.tempo,
    silences: analysis.silences,
    beatCount: analysis.beats.length,
    beats: analysis.beats.slice(0, maxOnsets),
    beatsTruncated: analysis.beats.length > maxOnsets,
    onsetCount: analysis.onsets.length,
    onsets: analysis.onsets.slice(0, maxOnsets),
    onsetsTruncated: analysis.onsets.length > maxOnsets,
  };
}
