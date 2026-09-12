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
import { spawn } from "child_process";
import { app } from "electron";
import axios from "axios";
import Store from "electron-store";
import { ffmpegConfig } from "../lib/ffmpeg";
import {
  isNativeSpeechAvailable,
  nativeSpeechUnavailableReason,
  SPEECH_BIN_PATH,
} from "../lib/speechBin";
import {
  readLocales,
  transcribeWav,
  type SpeechLocales,
  type SpeechStage,
} from "../lib/speechStt";
import { toFsPath } from "./localpath";
import {
  confidenceFromLogProb,
  segmentWords,
  type TranscriptSegment,
  type TranscriptWord,
} from "./analysis/segments";

const store = new Store();

export type { TranscriptWord, TranscriptSegment } from "./analysis/segments";

/**
 * Which engine produced a transcript.
 *
 * `"apple"` rather than `"native"`, and deliberately not folded into `"local"`:
 * the WhisperX server is *also* local, so the useful distinction is whose engine
 * it is. `local` is a server you run, `openai` is an API you pay for, `apple` is
 * the OS.
 */
export type TranscriptMethod = "local" | "openai" | "apple";

export type Transcript = {
  words: TranscriptWord[];
  segments: TranscriptSegment[];
  method: TranscriptMethod;
};

/** What a caller can watch and interrupt. */
export type TranscribeOptions = {
  /** BCP-47, for the `apple` method. Ignored by the other two. */
  locale?: string;
  onProgress?: (fraction: number, stage: TranscribeStage) => void;
  signal?: AbortSignal;
};

export type TranscribeStage = "extracting" | SpeechStage;

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
 * What a cached transcript holds. Bump it when the shape changes.
 *
 * v2 added per-word confidence and speaker labels. Without a bump every project
 * already transcribed would keep answering from a cache that has neither, and
 * the new fields would look like a back end that does not report them — a
 * silent, permanent absence rather than a visible re-transcription.
 */
const CACHE_VERSION = "v2";

/**
 * Cache key from the file's identity, not its path.
 *
 * Size and mtime are in because the interesting failure is re-exporting over
 * the same filename and getting the previous file's words back.
 */
function cacheKey(filepath: string, method: string): string {
  const stat = fs.statSync(filepath);
  return createHash("sha1")
    .update(
      `${filepath}:${stat.size}:${stat.mtimeMs}:${method}:${CACHE_VERSION}`,
    )
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

/**
 * Strip the audio to a wav the STT back ends both accept.
 *
 * `spawn` rather than `fluent-ffmpeg`. That wrapper validates every requested
 * format against a capability list it builds by parsing `ffmpeg -formats`, and
 * its parser (2.1.2, last published years ago) expects one space between the
 * flag column and the format name. **ffmpeg 9 emits two**, having added a third
 * flag for devices — so the parse yields *zero* formats, every format looks
 * unavailable, and this failed with "Output format wav is not available"
 * against a binary whose own `-muxers` lists it.
 *
 * That made `get_transcript` fail outright for every clip. The live export path
 * spawns ffmpeg directly and was never affected; the only other wrapper user is
 * `render/renderMain.ts`, the legacy IPC path nothing calls any more.
 */
function extractAudio(mediaPath: string): Promise<string> {
  const output = path.join(
    app.getPath("temp"),
    `cartcut-stt-${createHash("sha1").update(mediaPath).digest("hex").slice(0, 12)}.wav`,
  );

  return new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(ffmpegConfig.FFMPEG_PATH, [
      "-v", "error",
      "-y",
      "-i", mediaPath,
      "-vn",
      "-acodec", "pcm_s16le",
      "-ar", "16000",
      "-ac", "1",
      "-f", "wav",
      output,
    ]);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) =>
      reject(
        new Error(`Could not extract audio from ${mediaPath}: ${error.message}`),
      ),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Could not extract audio from ${mediaPath}: ffmpeg exited ${code}. ${stderr.trim()}`,
          ),
        );
        return;
      }
      resolve(output);
    });
  });
}

/** A back end's score as a 0..1 number, or nothing at all. */
function asScore(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  return Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100;
}

/** A diarisation label, or nothing. Empty strings are nothing. */
function asSpeaker(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  // `{word, start, end, score}` where the times are seconds. With diarisation
  // on, a `speaker` label sits on the segment and often on the word too.
  //
  // `score` and `speaker` were both being read past and thrown away. They are
  // the two things a transcript can say that the words alone cannot: which of
  // them the recogniser was unsure of, and who was talking.
  const words: TranscriptWord[] = [];
  for (const segment of data?.result ?? []) {
    const segmentSpeaker = asSpeaker(segment?.speaker);
    for (const word of segment?.words ?? []) {
      if (word?.start == null || word?.end == null) {
        continue;
      }
      // The word's own label wins; the segment's is the fallback, because some
      // builds label only the segment.
      const speaker = asSpeaker(word?.speaker) ?? segmentSpeaker;
      words.push({
        word: String(word.word ?? "").trim(),
        startMs: Math.round(word.start * 1000),
        endMs: Math.round(word.end * 1000),
        ...(asScore(word?.score) != null
          ? { confidence: asScore(word.score) }
          : {}),
        ...(speaker != null ? { speaker } : {}),
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

  // whisper-1 reports no per-word score, only a per-segment mean log
  // probability — so confidence lives on the segment here and the words carry
  // none, rather than a sentence-level number being dressed up as a word-level
  // one. No diarisation either, so no speakers.
  const segments: TranscriptSegment[] =
    (data?.segments ?? []).length > 0
      ? data.segments.map((segment: any) => {
          const confidence = confidenceFromLogProb(segment?.avg_logprob);
          return {
            text: String(segment.text ?? "").trim(),
            startMs: Math.round((segment.start ?? 0) * 1000),
            endMs: Math.round((segment.end ?? 0) * 1000),
            ...(confidence != null ? { confidence } : {}),
          };
        })
      : segmentWords(words);

  return { words, segments, method: "openai" };
}

/** The languages this Mac can transcribe on device, for a language picker. */
export async function appleSpeechLocales(): Promise<SpeechLocales> {
  if (!isNativeSpeechAvailable()) {
    return {
      available: false,
      locales: [],
      reason: nativeSpeechUnavailableReason() ?? undefined,
    };
  }
  return readLocales(SPEECH_BIN_PATH);
}

/**
 * macOS's own recogniser, through the `cartcut-stt` sidecar.
 *
 * The only back end here that reports **per-word** timings without being asked
 * twice, which is what the auto-caption panel's word chips and split-at-a-word
 * are built on. It is also the only one that needs no network and no key.
 *
 * Confidence comes per word, so — unlike the OpenAI path, which has only a
 * per-segment mean log probability — `segmentWords` gets real numbers to
 * average and nothing is invented.
 */
async function transcribeApple(
  wavPath: string,
  options: TranscribeOptions,
): Promise<Transcript> {
  const reason = nativeSpeechUnavailableReason();
  if (reason != null) {
    throw new Error(reason);
  }

  const words = await transcribeWav(
    SPEECH_BIN_PATH,
    wavPath,
    options.locale ?? app.getLocale(),
    options.onProgress,
    options.signal,
  );

  return { words, segments: segmentWords(words), method: "apple" };
}

/**
 * Transcribe one media file.
 *
 * `method` defaults to the best back end this machine actually has: macOS's own
 * recogniser when it is available, then OpenAI if a key is set, then a local
 * server. That ordering is what makes `get_transcript` work on a fresh install
 * with no key and no server running, which it previously could not.
 *
 * Times in the result are **source-file** ms; mapping them onto the timeline is
 * the renderer's job, because only it knows the clip's trim and speed.
 */
export async function transcribeFile(
  source: string,
  method?: TranscriptMethod,
  options: TranscribeOptions = {},
): Promise<Transcript> {
  // A clip's `localpath` is a percent-encoded `file://` URL, not a path, so
  // everything below that reaches `fs` — this guard and `cacheKey`'s `statSync`
  // — needs the converted form. ffmpeg accepts either, which is why only the
  // filesystem half ever complained.
  const mediaPath = toFsPath(source);
  if (!fs.existsSync(mediaPath)) {
    throw new Error(`No such media file: ${mediaPath}`);
  }

  const chosen: TranscriptMethod =
    method ??
    (isNativeSpeechAvailable()
      ? "apple"
      : store.get("ai_openai_key")
        ? "openai"
        : "local");

  // The locale is part of the identity of an `apple` transcript — the same file
  // read as Korean and as English gives different words — so it has to be part
  // of the key. Folding it into the `method` component is what lets that happen
  // without moving `CACHE_VERSION`, so every transcript cached before this
  // feature stays valid.
  const locale = options.locale ?? app.getLocale();
  const cacheMethod = chosen === "apple" ? `apple:${locale}` : chosen;

  const key = cacheKey(mediaPath, cacheMethod);
  const cached = readCache(key);
  if (cached != null) {
    return cached;
  }

  options.onProgress?.(0, "extracting");
  const wavPath = await extractAudio(mediaPath);
  try {
    const transcript =
      chosen === "apple"
        ? await transcribeApple(wavPath, { ...options, locale })
        : chosen === "local"
          ? await transcribeLocal(wavPath)
          : await transcribeOpenAi(wavPath);

    writeCache(key, transcript);
    return transcript;
  } finally {
    fs.rm(wavPath, { force: true }, () => {});
  }
}
