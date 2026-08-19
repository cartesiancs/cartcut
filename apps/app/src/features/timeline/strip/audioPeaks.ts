/**
 * Decodes a file's waveform once and hands it back on demand.
 *
 * Unlike the filmstrip, this has nothing to stream: `decodeAudioData` needs the
 * whole file and produces the whole peak array in one go. So there is no queue
 * or eviction here — just "asked for, in flight, or done", and the same
 * synchronous `get` contract that keeps the draw pass from ever waiting.
 *
 * Video files are decoded too when they carry a track, so a clip can show
 * frames and a waveform at once.
 */

import { getLocationEnv } from "../../../functions/getLocationEnv";
import { computePeaks, type PeakData } from "./peaks";

export interface PeakProvider {
  /** Decoded peaks, or null. Never blocks. */
  get(localpath: string): PeakData | null;
  /** Queue a decode. Safe to call every frame; repeats are ignored. */
  request(localpath: string): void;
}

export const nullPeakProvider: PeakProvider = {
  get: () => null,
  request: () => {},
};

export type AudioPeakProvider = PeakProvider & {
  onReady(callback: () => void): () => void;
  invalidate(localpath: string): void;
  dispose(): void;
  readonly decodedFiles: number;
};

/** Mirrors `loadedAssetStore.getPath` so web mode resolves the same way. */
function resolvePath(localpath: string): string {
  return getLocationEnv() === "electron"
    ? localpath
    : `/api/file?path=${localpath}`;
}

export function createAudioPeakProvider(): AudioPeakProvider {
  const decoded = new Map<string, PeakData>();
  const inFlight = new Set<string>();
  const failed = new Set<string>();
  const listeners = new Set<() => void>();

  let context: AudioContext | null = null;
  let readyHandle = 0;

  function audioContext(): AudioContext {
    if (context == null) {
      const Ctor =
        (window as any).AudioContext ?? (window as any).webkitAudioContext;
      context = new Ctor();
    }
    return context!;
  }

  function notifyReady() {
    if (readyHandle !== 0) {
      return;
    }
    readyHandle = requestAnimationFrame(() => {
      readyHandle = 0;
      for (const listener of listeners) {
        listener();
      }
    });
  }

  async function decode(localpath: string): Promise<void> {
    const response = await fetch(resolvePath(localpath));
    const bytes = await response.arrayBuffer();
    const buffer = await audioContext().decodeAudioData(bytes);

    const channels: Float32Array[] = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) {
      channels.push(buffer.getChannelData(i));
    }

    decoded.set(
      localpath,
      computePeaks(channels, buffer.sampleRate, buffer.duration * 1000),
    );
    notifyReady();
  }

  return {
    get(localpath) {
      return decoded.get(localpath) ?? null;
    },

    request(localpath) {
      if (
        decoded.has(localpath) ||
        inFlight.has(localpath) ||
        // A file with no decodable audio must not be retried on every repaint.
        failed.has(localpath)
      ) {
        return;
      }

      inFlight.add(localpath);
      decode(localpath)
        .catch(() => {
          failed.add(localpath);
        })
        .finally(() => {
          inFlight.delete(localpath);
        });
    },

    onReady(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    invalidate(localpath) {
      decoded.delete(localpath);
      failed.delete(localpath);
    },

    get decodedFiles() {
      return decoded.size;
    },

    dispose() {
      decoded.clear();
      inFlight.clear();
      failed.clear();
      listeners.clear();
      context?.close().catch(() => {});
      context = null;
      if (readyHandle !== 0) {
        cancelAnimationFrame(readyHandle);
        readyHandle = 0;
      }
    },
  };
}
