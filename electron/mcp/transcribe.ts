/**
 * Speech-to-text for the MCP tools, headless.
 *
 * The auto-caption panel already transcribes, but it does so from the renderer
 * and drives Bootstrap modals as it goes — it is a UI flow, not a function. A
 * tool call has no user watching a progress dialog, so this is the same two
 * back ends reached directly from main: the local WhisperX-shaped server, or
 * OpenAI's whisper.
 *
 * Transcription is the slow, expensive step in an automatic cut edit, and an
 * agent will ask for the same clip more than once — once to read the words,
 * again after deciding what to cut. So results are cached on disk, keyed by the
 * file's identity rather than its name, and a re-encode of the same path
 * correctly misses the cache.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { app } from "electron";
import ffmpeg from "fluent-ffmpeg";
import axios from "axios";
import Store from "electron-store";
import { ffmpegConfig } from "../lib/ffmpeg";

const store = new Store();

ffmpeg.setFfmpegPath(ffmpegConfig.FFMPEG_PATH);
ffmpeg.setFfprobePath(ffmpegConfig.FFPROBE_PATH);

/** One recognised word, in **source-file** milliseconds. */
export type TranscriptWord = {
  word: string;
  startMs: number;
  endMs: number;
};

/** A run of words, in **source-file** milliseconds. */
export type TranscriptSegment = {
  text: string;
  startMs: number;
  endMs: number;
};

export type Transcript = {
  words: TranscriptWord[];
  segments: TranscriptSegment[];
  method: "local" | "openai";
};

export const DEFAULT_LOCAL_STT_URL = "http://127.0.0.1:8000";

export function localSttUrl(): string {
  const configured = store.get("ai_stt_server_url");
  return typeof configured === "string" && configured.length > 0
    ? configured
    : DEFAULT_LOCAL_STT_URL;
}

/**
 * A file as a `Blob`, for `FormData`.
 *
 * The `Uint8Array` copy is not ceremony: `Buffer`'s backing store is typed as
 * `ArrayBufferLike`, which admits `SharedArrayBuffer`, and `BlobPart` does not
 * — so handing a `Buffer` straight to `new Blob([...])` fails to compile.
 */
export function fileBlob(filepath: string, type: string): Blob {
  return new Blob([new Uint8Array(fs.readFileSync(filepath))], { type });
}

function cacheDir(): string {
  const dir = path.join(app.getPath("userData"), "transcripts");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Cache key from the file's identity, not its path.
 *
 * Size and mtime are in because the interesting failure is re-exporting over
 * the same filename and getting the previous file's words back.
 */
function cacheKey(filepath: string, method: string): string {
  const stat = fs.statSync(filepath);
  return createHash("sha1")
    .update(`${filepath}:${stat.size}:${stat.mtimeMs}:${method}`)
    .digest("hex");
}

function readCache(key: string): Transcript | null {
  const file = path.join(cacheDir(), `${key}.json`);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Transcript;
  } catch {
    // A truncated write from a previous crash. Re-transcribing is cheaper than
    // reasoning about half a transcript.
    return null;
  }
}

function writeCache(key: string, transcript: Transcript) {
  fs.writeFileSync(
    path.join(cacheDir(), `${key}.json`),
    JSON.stringify(transcript),
    "utf8",
  );
}

/** Strip the audio to a wav the STT back ends both accept. */
function extractAudio(mediaPath: string): Promise<string> {
  const output = path.join(
    app.getPath("temp"),
    `cartcut-stt-${createHash("sha1").update(mediaPath).digest("hex").slice(0, 12)}.wav`,
  );

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(mediaPath)
      .noVideo()
      .audioCodec("pcm_s16le")
      .audioFrequency(16000)
      .audioChannels(1)
      .format("wav")
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (error) =>
        reject(
          new Error(`Could not extract audio from ${mediaPath}: ${error.message}`),
        ),
      )
      .run();
  });
}

/** Group words into caption-sized lines. */
function segmentWords(words: TranscriptWord[]): TranscriptSegment[] {
  const MAX_CHARS = 42;
  const MAX_MS = 6000;
  /** A pause this long reads as a sentence boundary. */
  const GAP_MS = 700;

  const segments: TranscriptSegment[] = [];
  let current: TranscriptWord[] = [];

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    segments.push({
      text: current.map((w) => w.word).join(" ").replace(/\s+/g, " ").trim(),
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
    });
    current = [];
  };

  for (const word of words) {
    if (current.length > 0) {
      const gap = word.startMs - current[current.length - 1].endMs;
      const chars = current.reduce((n, w) => n + w.word.length + 1, 0);
      const span = word.endMs - current[0].startMs;
      const endsSentence = /[.!?。？！]$/.test(
        current[current.length - 1].word,
      );

      if (gap >= GAP_MS || chars >= MAX_CHARS || span >= MAX_MS || endsSentence) {
        flush();
      }
    }
    current.push(word);
  }
  flush();

  return segments;
}

async function transcribeLocal(wavPath: string): Promise<Transcript> {
  const url = localSttUrl();
  const form = new FormData();
  form.append("file", fileBlob(wavPath, "audio/wav"), "audio.wav");

  let data: any;
  try {
    const response = await axios.post(`${url}/api/audio/test`, form, {
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    data = response.data;
  } catch (error: any) {
    throw new Error(
      `Local speech-to-text server at ${url} did not answer (${error.message}). ` +
        `Start it, or switch to the OpenAI method by setting an API key.`,
    );
  }

  // WhisperX shape: `result` is a list of segments, each with a `words` list of
  // `{word, start, end, score}` where the times are seconds.
  const words: TranscriptWord[] = [];
  for (const segment of data?.result ?? []) {
    for (const word of segment?.words ?? []) {
      if (word?.start == null || word?.end == null) {
        continue;
      }
      words.push({
        word: String(word.word ?? "").trim(),
        startMs: Math.round(word.start * 1000),
        endMs: Math.round(word.end * 1000),
      });
    }
  }

  return { words, segments: segmentWords(words), method: "local" };
}

async function transcribeOpenAi(wavPath: string): Promise<Transcript> {
  const key = store.get("ai_openai_key");
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(
      "No OpenAI API key is set. Add one in Cartcut's AI settings, or run a local speech-to-text server.",
    );
  }

  const form = new FormData();
  form.append("file", fileBlob(wavPath, "audio/wav"), "audio.wav");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  // Word granularity is what makes silence and filler detection possible at
  // all; the segment list alone cannot say where inside a sentence a pause is.
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");

  const response = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    form,
    {
      headers: { Authorization: `Bearer ${key}` },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    },
  );

  const data = response.data;

  const words: TranscriptWord[] = (data?.words ?? []).map((word: any) => ({
    word: String(word.word ?? "").trim(),
    startMs: Math.round((word.start ?? 0) * 1000),
    endMs: Math.round((word.end ?? 0) * 1000),
  }));

  const segments: TranscriptSegment[] =
    (data?.segments ?? []).length > 0
      ? data.segments.map((segment: any) => ({
          text: String(segment.text ?? "").trim(),
          startMs: Math.round((segment.start ?? 0) * 1000),
          endMs: Math.round((segment.end ?? 0) * 1000),
        }))
      : segmentWords(words);

  return { words, segments, method: "openai" };
}

/**
 * Transcribe one media file.
 *
 * `method` defaults to whichever back end is configured: a local server if one
 * is set, otherwise OpenAI. Times in the result are **source-file** ms; mapping
 * them onto the timeline is the renderer's job, because only it knows the
 * clip's trim and speed.
 */
export async function transcribeFile(
  mediaPath: string,
  method?: "local" | "openai",
): Promise<Transcript> {
  if (!fs.existsSync(mediaPath)) {
    throw new Error(`No such media file: ${mediaPath}`);
  }

  const chosen: "local" | "openai" =
    method ?? (store.get("ai_openai_key") ? "openai" : "local");

  const key = cacheKey(mediaPath, chosen);
  const cached = readCache(key);
  if (cached != null) {
    return cached;
  }

  const wavPath = await extractAudio(mediaPath);
  try {
    const transcript =
      chosen === "local"
        ? await transcribeLocal(wavPath)
        : await transcribeOpenAi(wavPath);

    writeCache(key, transcript);
    return transcript;
  } finally {
    fs.rm(wavPath, { force: true }, () => {});
  }
}
