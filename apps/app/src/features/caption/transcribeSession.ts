/**
 * One transcription job, from minting its id to landing its caption lines.
 *
 * The most ordering-sensitive code in the auto-caption panel, and none of it was
 * reachable from a test. Four orderings here look arbitrary and are not; each is
 * stated at the line that depends on it, and each has a case in the suite.
 *
 * `window.electronAPI.req.transcribe` is reached only through `TranscribePort`,
 * so this runs under `environment: "node"` against a fake — the narrowing
 * `ui/transientModal.ts` does to `bootstrap.Modal`, for the same reason. The id
 * minter is injected too, so a test can name the job it is asserting about.
 *
 * ## It returns an outcome; the caller performs it
 *
 * Deliberately. Finishing a job means closing one Bootstrap modal and opening
 * another **in that order, in one tick**, over shared `body.modal-open` state —
 * which is the family of bug `TransientModal` exists for. Those calls stay in the
 * component, in one place, where the order is visible.
 */

import { linesFromTranscript, type CaptionLine, type TranscribedWord } from "./lines";

/** What the panel asks main for. `locale` is meaningful for `apple` alone. */
export type TranscribeRequest = {
  source: string;
  method: "apple" | "openai";
  locale?: string;
};

/** The part of `electronAPI.req.transcribe` this needs. */
export type TranscribePort = {
  start(jobId: string, request: TranscribeRequest): Promise<unknown>;
  cancel(jobId: string): Promise<unknown>;
  onProgress(handler: (payload: unknown) => void): () => void;
};

export type JobOutcome =
  | { kind: "lines"; lines: CaptionLine[] }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

/** Shown while the job runs. `stage` is main's vocabulary, read as an opaque string. */
export type JobProgress = { fraction: number; stage: string };

const NOTE_LOCAL = "The audio never leaves your computer.";

/**
 * The dialog's copy for a progress stage.
 *
 * Main can send four: `extracting`, `downloading`, `transcribing`, and
 * **`queued`** — which it sends, with a `null` fraction, when a job waits behind
 * another. There is no branch for `queued`, so it falls through to
 * "Transcribing…" at 0%, indistinguishable from a job that has just started.
 * That is the behaviour today and it is pinned, not fixed: see the findings note
 * on this function's suite.
 */
export function progressCopy(stage: string): { title: string; note: string } {
  if (stage === "downloading") {
    return {
      title: "Downloading the language model...",
      note: "This happens once per language, and the model stays on this Mac.",
    };
  }
  if (stage === "extracting") {
    return { title: "Extracting audio...", note: NOTE_LOCAL };
  }
  return { title: "Transcribing...", note: NOTE_LOCAL };
}

/** The bar's width, as a whole percent. */
export function progressPercent(fraction: number): number {
  return Math.round(fraction * 100);
}

export class TranscribeSession {
  private _jobId: string | null = null;
  private _fraction = 0;
  private _stage = "";

  constructor(
    private readonly port: TranscribePort,
    private readonly mintId: () => string,
  ) {}

  /** The job main is working on, or null between jobs. */
  get jobId(): string | null {
    return this._jobId;
  }

  get progress(): JobProgress {
    return { fraction: this._fraction, stage: this._stage };
  }

  /** Subscribe to main's progress. `onChange` fires only for our own job. */
  subscribe(onChange: () => void): () => void {
    return this.port.onProgress((payload) => {
      if (this.acceptProgress(payload)) {
        onChange();
      }
    });
  }

  /**
   * Take a progress payload, or ignore it.
   *
   * False when it is not ours, which covers three cases with one comparison:
   * another job's progress, a malformed payload, and **anything arriving after
   * `run` has finished** — because `run` clears the id in a `finally`, before it
   * has even looked at the result.
   */
  acceptProgress(payload: unknown): boolean {
    const update = payload as
      | { jobId?: unknown; fraction?: unknown; stage?: unknown }
      | null
      | undefined;

    if (update?.jobId !== this._jobId) {
      return false;
    }
    // `fraction` is null for the `queued` notice, which reads as 0.
    this._fraction = (update?.fraction ?? 0) as number;
    this._stage = (update?.stage ?? "") as string;
    return true;
  }

  /**
   * Run the job.
   *
   * `onStarted` fires once the id and the opening stage are set, so the caller
   * can show its dialog — before the await, because on a first-run model
   * download `start` does not resolve until the download has finished.
   */
  async run(request: TranscribeRequest, onStarted: () => void): Promise<JobOutcome> {
    // Minted *before* the call, so Cancel has something to send during that
    // download. It is the long wait, and it is inside `start`.
    this._jobId = this.mintId();
    this._fraction = 0;
    this._stage = "extracting";
    onStarted();

    let result: unknown;
    try {
      result = await this.port.start(this._jobId, {
        source: request.source,
        // `locale` travels for `apple` only. The OpenAI path detects the
        // language itself, and sending one would imply it were honoured.
        method: request.method,
        locale: request.method === "apple" ? request.locale : undefined,
      });
    } catch (error) {
      return { kind: "failed", message: String(error) };
    } finally {
      // Cleared here rather than after the result is read, so a Cancel pressed
      // between `start` resolving and the outcome being handled is a no-op
      // rather than an attempt to abort a job that has already finished.
      this._jobId = null;
    }

    const payload = result as
      | { ok?: unknown; cancelled?: unknown; error?: unknown; lines?: unknown }
      | null
      | undefined;

    if (payload?.ok !== true) {
      if (payload?.cancelled === true) {
        return { kind: "cancelled" };
      }
      return {
        kind: "failed",
        message: String(payload?.error ?? "Transcription failed."),
      };
    }

    // Main groups the words with `analysis/segments.ts`, which is where the rule
    // for where a caption breaks lives and is tested. Only the units change.
    return {
      kind: "lines",
      lines: linesFromTranscript(payload.lines as TranscribedWord[][] | undefined),
    };
  }

  /**
   * Ask main to stop.
   *
   * Must be called **before** the caller clears its own state: it reads the live
   * id, and with it already null main is sent nothing and silently ignores it.
   */
  requestCancel(): void {
    if (this._jobId != null) {
      void this.port.cancel(this._jobId);
    }
  }

  /** Forget the job, without telling main. */
  clear(): void {
    this._jobId = null;
  }
}
