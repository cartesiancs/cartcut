/**
 * Fetching the model, once, with a progress bar and a way out.
 *
 * The transport arrives as a narrow port rather than being imported. Electron's
 * `net.fetch` is the real one, because it honours the system proxy and a user
 * behind a corporate proxy is exactly the user for whom a 400MB download fails;
 * but it cannot be loaded in a suite, so everything decidable lives here and is
 * checked against a fake.
 *
 * Three rules, all of them `lib/reverse.ts#ensureReversed`'s:
 *
 * - Write to `.part` and rename into place, so an interrupted run never leaves
 *   a truncated file that the next one takes for a finished one.
 * - Verify before renaming. The size check in `installState` catches a cut
 *   connection; only the digest catches a proxy that served an error page with
 *   a 200, which is a thing corporate proxies do.
 * - A file already in place is skipped, so resuming after a failure costs only
 *   what is actually left.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  MODEL_FILES,
  downloadUrl,
  totalBytesOf,
  type ModelFile,
} from "./ttsManifest";
import { digestOf, fileLocation, installState } from "./ttsModels";

/** What `net.fetch` gives back, narrowed to what this needs. */
export type DownloadResponse = {
  ok: boolean;
  status: number;
  /** The body, in whatever pieces the transport delivers it. */
  chunks: AsyncIterable<Uint8Array>;
};

export type FetchLike = (
  url: string,
  signal?: AbortSignal,
) => Promise<DownloadResponse>;

export class DownloadCancelledError extends Error {
  constructor() {
    super("Model download cancelled");
    this.name = "DownloadCancelledError";
  }
}

export type DownloadProgress = {
  /** 0 to 1 across the whole set, counting what was already on disk. */
  fraction: number;
  receivedBytes: number;
  totalBytes: number;
  /** The manifest path in flight, for a caller that wants to name it. */
  file: string;
};

export type DownloadDeps = {
  userDataDir: string;
  fetch: FetchLike;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DownloadCancelledError();
  }
}

/**
 * Fetch one file to its `.part` and rename it into place.
 *
 * `onBytes` reports deltas rather than totals so the caller can keep one
 * running figure across the whole set without this one knowing about the rest.
 */
async function downloadFile(
  file: ModelFile,
  deps: DownloadDeps,
  onBytes: (delta: number) => void,
): Promise<void> {
  const destination = fileLocation(deps.userDataDir, file);
  const part = `${destination}.part`;

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // A `.part` left by an earlier attempt holds bytes from a response we can no
  // longer reason about. Starting it again is cheaper than deciding whether it
  // is resumable.
  fs.rmSync(part, { force: true });

  const response = await deps.fetch(downloadUrl(file), deps.signal);
  if (!response.ok) {
    throw new Error(`${file.path}: HTTP ${response.status}`);
  }

  const handle = fs.openSync(part, "w");
  try {
    for await (const chunk of response.chunks) {
      throwIfAborted(deps.signal);
      fs.writeSync(handle, chunk);
      onBytes(chunk.byteLength);
    }
  } finally {
    fs.closeSync(handle);
  }

  throwIfAborted(deps.signal);

  // Both checks, in this order. The size is instant and catches a cut
  // connection; the digest is the only thing that catches a proxy that
  // answered 200 with a login page.
  const written = fs.statSync(part).size;
  if (written !== file.bytes) {
    fs.rmSync(part, { force: true });
    throw new Error(
      `${file.path}: expected ${file.bytes} bytes, received ${written}`,
    );
  }
  if (digestOf(part) !== file.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`${file.path}: checksum did not match`);
  }

  fs.renameSync(part, destination);
}

export type DownloadResult = {
  /** Manifest paths fetched this run. Empty when everything was already here. */
  downloaded: string[];
};

/**
 * Put the whole model on disk, fetching only what is missing.
 *
 * Sequential rather than parallel, for the reason `ipcProxy.ts` runs one job at
 * a time: four sockets do not make a home connection faster, and they turn one
 * legible progress bar into four that interleave.
 */
export async function downloadModel(
  deps: DownloadDeps,
): Promise<DownloadResult> {
  const state = installState(deps.userDataDir);
  // Taken from the manifest being walked, not from the module constant, so the
  // bar's denominator is always the set actually being fetched.
  const totalBytes = totalBytesOf(MODEL_FILES);
  // Bytes already on disk count towards the total, so a resumed download picks
  // the bar up where it left off instead of restarting at zero.
  let received = state.presentBytes;
  const downloaded: string[] = [];

  const report = (file: string) => {
    deps.onProgress?.({
      fraction: totalBytes > 0 ? Math.min(1, received / totalBytes) : 1,
      receivedBytes: received,
      totalBytes,
      file,
    });
  };

  if (state.missing.length === 0) {
    report("");
    return { downloaded };
  }

  for (const file of MODEL_FILES) {
    if (!state.missing.includes(file.path)) {
      continue;
    }
    throwIfAborted(deps.signal);
    report(file.path);

    await downloadFile(file, deps, (delta) => {
      received += delta;
      report(file.path);
    });
    downloaded.push(file.path);

    // Re-seat the running total on what is actually on disk. A transport that
    // decompressed a Content-Encoding on the way in reports more bytes through
    // `onBytes` than the file has, and the bar would run past 100%.
    received = installState(deps.userDataDir).presentBytes;
    report(file.path);
  }

  return { downloaded };
}
