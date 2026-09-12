/**
 * Running the native speech sidecar: spawn, read NDJSON, abort.
 *
 * **No Electron import.** The layering `lib/reverse.ts` and
 * `lib/reversePipeline.ts` state: the half with decisions in it takes the
 * binary path as an argument so it can be unit tested, and `lib/speechBin.ts`
 * is the half that knows `process.resourcesPath`.
 *
 * The sidecar speaks one JSON object per line on stdout. That is not decoration:
 * a ten-minute file is ~25 seconds of work and the caller wants words and
 * progress while it happens, and a line is the cheapest framing that survives a
 * pipe delivering half a buffer at a time.
 */

import { spawn } from "child_process";

export type SpeechWord = {
  word: string;
  startMs: number;
  endMs: number;
  confidence?: number;
};

export type SpeechLocale = {
  id: string;
  name: string;
  installed: boolean;
};

export type SpeechLocales = {
  available: boolean;
  locales: SpeechLocale[];
  reason?: string;
};

export type SpeechStage = "downloading" | "transcribing";

export class SpeechCancelledError extends Error {
  constructor() {
    super("Transcription was cancelled");
    this.name = "SpeechCancelledError";
  }
}

/** A failure the sidecar named, kept apart from a crash so callers can branch. */
export class SpeechError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SpeechError";
  }
}

/**
 * Feed bytes, get whole lines.
 *
 * A pipe splits wherever it likes, including mid-character for the multi-byte
 * text this feature exists to handle, so the tail is kept rather than parsed.
 */
export function createLineReader(onLine: (line: string) => void) {
  let pending = "";
  return {
    push(chunk: string) {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line.length > 0) {
          onLine(line);
        }
      }
    },
    /** Whatever arrived without a trailing newline. */
    flush() {
      const rest = pending.trim();
      pending = "";
      if (rest.length > 0) {
        onLine(rest);
      }
    },
  };
}

type Events = {
  onWord?: (word: SpeechWord) => void;
  onProgress?: (fraction: number, stage: SpeechStage) => void;
};

/**
 * Interpret one event line.
 *
 * Exported for its suite: the whole protocol lives here, and getting `assets`
 * versus `progress` the wrong way round is invisible until someone watches a
 * first run in a new language.
 */
export function applyEvent(
  event: any,
  sink: Events & { onError?: (error: SpeechError) => void; onDone?: () => void },
) {
  switch (event?.type) {
    case "word":
      if (typeof event.word === "string" && event.word.length > 0) {
        sink.onWord?.({
          word: event.word,
          startMs: Math.round(event.startMs ?? 0),
          endMs: Math.round(event.endMs ?? 0),
          ...(typeof event.confidence === "number"
            ? { confidence: Math.round(Math.max(0, Math.min(1, event.confidence)) * 100) / 100 }
            : {}),
        });
      }
      break;
    case "assets":
      // A model download and the transcription itself are different waits and
      // the user is told which one they are in: the first can be minutes on a
      // slow connection and happens once per language, the second is seconds.
      sink.onProgress?.(Number(event.fraction) || 0, "downloading");
      break;
    case "progress":
      sink.onProgress?.(Number(event.fraction) || 0, "transcribing");
      break;
    case "error":
      sink.onError?.(
        new SpeechError(String(event.code ?? "unknown"), String(event.message ?? "Transcription failed")),
      );
      break;
    case "done":
      sink.onDone?.();
      break;
    default:
      break;
  }
}

/** The languages this Mac can transcribe. Never throws; an unusable state is `available: false`. */
export async function readLocales(binPath: string): Promise<SpeechLocales> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(binPath, ["locales"]);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () =>
      resolve({ available: false, locales: [], reason: "The on-device speech component could not be started." }),
    );
    child.on("close", () => {
      try {
        const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
        const data = JSON.parse(line);
        if (data?.available !== true) {
          resolve({
            available: false,
            locales: [],
            reason: typeof data?.message === "string" ? data.message : undefined,
          });
          return;
        }
        resolve({
          available: true,
          locales: (data.supported ?? []).map((entry: any) => ({
            id: String(entry.id),
            name: String(entry.name ?? entry.id),
            installed: entry.installed === true,
          })),
        });
      } catch {
        resolve({ available: false, locales: [] });
      }
    });
  });
}

/**
 * Transcribe one wav.
 *
 * `(…, onProgress?, signal?)` is the house shape — `lib/reverse.ts#ensureReversed`
 * has the same. Cancellation is `SIGKILL`, as in `reversePipeline.ts#runFfmpeg`:
 * there is no partial result worth draining, and the analyzer holds a model the
 * OS would rather have back promptly.
 */
export function transcribeWav(
  binPath: string,
  wavPath: string,
  locale: string,
  onProgress?: (fraction: number, stage: SpeechStage) => void,
  signal?: AbortSignal,
): Promise<SpeechWord[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SpeechCancelledError());
      return;
    }

    const words: SpeechWord[] = [];
    let failure: SpeechError | null = null;
    let stderr = "";

    const child = spawn(binPath, ["transcribe", "--input", wavPath, "--locale", locale]);

    const reader = createLineReader((line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        // Not ours. dyld and crash reporters write to stderr, so an unparseable
        // line on stdout is worth nothing but is not itself a failure.
        return;
      }
      applyEvent(event, {
        onWord: (word) => words.push(word),
        onProgress,
        onError: (error) => {
          failure = error;
        },
      });
    });

    child.stdout.on("data", (chunk: Buffer) => reader.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => {
      // The tail only: the reason for a failure is at the end.
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      reader.flush();

      if (signal?.aborted) {
        reject(new SpeechCancelledError());
        return;
      }
      if (failure != null) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `cartcut-stt exited with code ${code}`));
        return;
      }
      resolve(words);
    });
  });
}
