/**
 * Putting one cloud item on disk. Plain `fs`, no Electron.
 *
 * The rules are `tts/ttsDownload.ts`'s, for its reasons, with three changes
 * that come from installing a folder rather than a file:
 *
 * - **Staged outside every scanned root.** Files land in
 *   `cloud/staging/<kind>-<id>-<random>/` and the folder moves into place only
 *   once every file has been checked, so neither scanner ever sees half of one.
 * - **Hashed while streaming, written asynchronously.** `ttsDownload` hashes a
 *   finished file with a synchronous read; on the main process that freezes
 *   every window for as long as the read takes.
 * - **Swapped aside, not over.** A rename onto a non-empty folder fails, so an
 *   update moves the old folder into staging first, moves the new one in, and
 *   only then deletes the old. If the second rename fails (Windows refuses
 *   while a file inside is open) the old folder goes back.
 */

import { createHash, randomBytes } from "crypto";
import * as fsp from "fs/promises";
import path from "path";

import type { CloudItem } from "./cloudCatalog";

export type StreamedResponse = {
  ok: boolean;
  status: number;
  chunks: AsyncIterable<Uint8Array>;
};

export type FetchLike = (url: string, signal?: AbortSignal) => Promise<StreamedResponse>;

export class CloudDownloadCancelled extends Error {
  constructor() {
    super("Download cancelled");
    this.name = "CloudDownloadCancelled";
  }
}

export type InstallDeps = {
  fetch: FetchLike;
  /** The URL of one of the item's files. */
  fileUrl: (file: { path: string; sha256: string }) => string;
  stagingRoot: string;
  /** The item's folder: `installRoot/<id>`. */
  target: string;
  /** 0 to 1 across the whole item. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** How long a file may send nothing before the download fails. */
  stallMs?: number;
};

const STALL_MS = 30_000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new CloudDownloadCancelled();
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function downloadInto(
  item: CloudItem,
  staging: string,
  deps: InstallDeps,
): Promise<void> {
  const total = Math.max(1, item.bytes);
  let done = 0;
  deps.onProgress?.(0);

  for (const file of item.files) {
    throwIfAborted(deps.signal);
    const destination = path.join(staging, ...file.path.split("/"));
    await fsp.mkdir(path.dirname(destination), { recursive: true });

    // A connection that goes quiet never errors on its own, and the tile's
    // ring would turn for the rest of the session. Each file gets its own
    // signal: the caller's cancel, or this much silence.
    const fileAbort = new AbortController();
    const forward = () => fileAbort.abort();
    deps.signal?.addEventListener("abort", forward, { once: true });
    let stalled = false;
    let timer = setTimeout(() => {
      stalled = true;
      fileAbort.abort();
    }, deps.stallMs ?? STALL_MS);
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        fileAbort.abort();
      }, deps.stallMs ?? STALL_MS);
    };

    const hash = createHash("sha256");
    let received = 0;
    try {
      const response = await deps.fetch(deps.fileUrl(file), fileAbort.signal);
      if (!response.ok) {
        throw new Error(`${file.path}: HTTP ${response.status}`);
      }
      const handle = await fsp.open(destination, "w");
      try {
        for await (const chunk of response.chunks) {
          kick();
          throwIfAborted(deps.signal);
          received += chunk.byteLength;
          // Stop as soon as a response outgrows its listing rather than
          // writing whatever an error page or a runaway stream sends.
          if (received > file.bytes) {
            throw new Error(`${file.path}: more bytes than the catalog lists`);
          }
          hash.update(chunk);
          await handle.write(chunk);
          deps.onProgress?.(Math.min(1, (done + received) / total));
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      throwIfAborted(deps.signal);
      if (stalled) {
        throw new Error(`${file.path}: the connection stalled`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", forward);
    }
    throwIfAborted(deps.signal);

    if (received !== file.bytes) {
      throw new Error(`${file.path}: expected ${file.bytes} bytes, received ${received}`);
    }
    // The size check catches a cut connection; only the digest catches a
    // proxy that answered 200 with a page of its own.
    if (hash.digest("hex") !== file.sha256) {
      throw new Error(`${file.path}: checksum did not match`);
    }
    done += file.bytes;
  }
  deps.onProgress?.(1);
}

/** Move `staging` to `target`, keeping the old `target` until the new one is in. */
async function swapIntoPlace(staging: string, target: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });

  if (!(await exists(target))) {
    await fsp.rename(staging, target);
    return;
  }

  const old = `${staging}.old`;
  await fsp.rename(target, old);
  try {
    await fsp.rename(staging, target);
  } catch (error) {
    await fsp.rename(old, target).catch(() => {});
    throw error;
  }
  await fsp.rm(old, { recursive: true, force: true }).catch(() => {});
}

/**
 * Download every file of `item`, check each, and install the folder at `target`.
 *
 * Throws `CloudDownloadCancelled` when `signal` fires, and an `Error` naming
 * the file for anything else. Either way nothing is left in staging and an
 * earlier install at `target` is untouched.
 */
export async function installCloudItem(item: CloudItem, deps: InstallDeps): Promise<void> {
  await fsp.mkdir(deps.stagingRoot, { recursive: true });
  const staging = path.join(
    deps.stagingRoot,
    `${item.kind}-${item.id}-${randomBytes(6).toString("hex")}`,
  );
  await fsp.mkdir(staging, { recursive: true });

  try {
    await downloadInto(item, staging, deps);
    throwIfAborted(deps.signal);
    await swapIntoPlace(staging, deps.target);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Empty the staging folder. Run once per launch, before any download starts,
 * so a run that crashed mid-download leaves nothing behind for long.
 */
export async function clearStaging(stagingRoot: string): Promise<void> {
  await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
}
