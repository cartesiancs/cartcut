/**
 * The preload bridge for speech synthesis, narrowed to what the panel uses.
 *
 * A plain record rather than an import, for the reason CLAUDE.md gives for
 * `TranscribePort` and the rest: there is no DOM test environment here, so a
 * rule kept inside a Lit class is a rule nothing can check. The session below
 * is handed one of these and runs under `environment: "node"` against a fake.
 *
 * `reverse`, `transcribe` and `proxy` all reach their bridge this way rather
 * than through `functions/ipcWrapper.ts`, and this follows them.
 */

/** The ten preset voices. There is no cloning in this release of the model. */
export type TtsVoice = string;

export type TtsAvailabilityReply = {
  ok: boolean;
  reason?: "models_not_installed" | "models_incomplete";
  presentBytes?: number;
  totalBytes: number;
  voices: readonly TtsVoice[];
  repo: string;
  license: string;
};

export type TtsStartRequest = {
  text: string;
  voice: TtsVoice;
  lang: string;
  speed: number;
  steps: number;
};

export type TtsStartReply =
  | { ok: true; path: string; durationMs: number; sampleRate: number }
  | { ok: false; cancelled?: boolean; error?: string };

export type TtsDownloadReply =
  | { ok: true; downloaded: string[] }
  | { ok: false; cancelled?: boolean; error?: string };

export type TtsProgress = {
  jobId: string;
  fraction: number | null;
  stage: string;
};

export type TtsPort = {
  availability(): Promise<TtsAvailabilityReply>;
  download(jobId: string): Promise<TtsDownloadReply>;
  cancelDownload(jobId: string): Promise<unknown>;
  start(jobId: string, request: TtsStartRequest): Promise<TtsStartReply>;
  cancel(jobId: string): Promise<unknown>;
  onProgress(handler: (payload: TtsProgress) => void): () => void;
};

/** The bridge, or `null` in the web build, which has no main process. */
export function ttsBridge(): TtsPort | null {
  return (window as any).electronAPI?.req?.tts ?? null;
}

/** Whether synthesis is available at all. The utility tile hides itself if not. */
export function canSpeakHere(): boolean {
  return ttsBridge() != null;
}
