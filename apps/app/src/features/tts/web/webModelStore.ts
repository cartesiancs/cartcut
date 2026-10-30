/**
 * The voice model in a browser: fetched from Hugging Face once and kept in
 * Cache Storage.
 *
 * The browser half of `electron/lib/tts/ttsModels.ts` and `ttsDownload.ts`,
 * walking the same manifest, so a browser fetches exactly the files, sizes and
 * digests the desktop app does. Two differences follow from where it lives:
 *
 * - **A file is stored whole or not at all.** There is no `.part` to rename,
 *   so the bytes are gathered, measured and digested in memory and only then
 *   `put`. Presence in the cache therefore means complete and verified, and
 *   availability needs no size check.
 * - **One cache per model revision** (`MODEL_CACHE`), for the reason the
 *   desktop keeps one directory per revision: graphs from two revisions do not
 *   agree with each other. Older caches are dropped by `pruneStaleModelCaches`.
 *
 * Everything browser-shaped arrives through a port (`ModelCache`, `FetchPort`,
 * `DigestPort`), so these rules run under `environment: "node"` against fakes.
 * The synthesis worker reads the same cache, which is why its name lives here.
 */

import {
  MODEL_FILES,
  MODEL_REVISION,
  downloadUrl,
  totalBytesOf,
  type ModelFile,
} from "../../../../../../electron/lib/tts/ttsManifest";

const MODEL_CACHE_PREFIX = "cartcut-tts-";

/** The Cache Storage cache holding this revision's files, keyed by their URL. */
export const MODEL_CACHE = `${MODEL_CACHE_PREFIX}${MODEL_REVISION}`;

/** What this module needs from one Cache Storage cache. */
export type ModelCache = {
  /** The URLs stored, absolute. */
  keys(): Promise<readonly string[]>;
  put(url: string, bytes: Uint8Array): Promise<void>;
  /** The stored bytes, or `null` if the URL is not in the cache. */
  read(url: string): Promise<ArrayBuffer | null>;
};

/** What this module needs from `CacheStorage` itself. */
export type CacheStorageLike = {
  keys(): Promise<readonly string[]>;
  delete(name: string): Promise<boolean>;
};

/** The little of `fetch` a download reads. */
export type FetchPort = (
  url: string,
  init: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
}>;

/** SHA-256 of `bytes`, as lowercase hex. */
export type DigestPort = (bytes: Uint8Array) => Promise<string>;

export type ModelState = {
  complete: boolean;
  /** Bytes already stored, for a download resumed after a failure. */
  presentBytes: number;
  totalBytes: number;
  missing: readonly ModelFile[];
};

/** Which of `files` the cache holds. Reads names only, never the bytes. */
export async function modelState(
  cache: ModelCache,
  files: readonly ModelFile[] = MODEL_FILES,
): Promise<ModelState> {
  const stored = new Set(await cache.keys());
  let presentBytes = 0;
  const missing: ModelFile[] = [];
  for (const file of files) {
    if (stored.has(downloadUrl(file))) {
      presentBytes += file.bytes;
    } else {
      missing.push(file);
    }
  }
  return {
    complete: missing.length === 0,
    presentBytes,
    totalBytes: totalBytesOf(files),
    missing,
  };
}

/**
 * Drop the caches of other model revisions.
 *
 * The desktop leaves an old revision's directory for the user to remove; a
 * browser offers no such place, and 400MB of unreachable weights is a cost the
 * user cannot see or reclaim. Answers the names it deleted.
 */
export async function pruneStaleModelCaches(
  storage: CacheStorageLike,
): Promise<string[]> {
  const stale = (await storage.keys()).filter(
    (name) => name.startsWith(MODEL_CACHE_PREFIX) && name !== MODEL_CACHE,
  );
  await Promise.all(stale.map((name) => storage.delete(name)));
  return stale;
}

export class ModelDownloadCancelled extends Error {
  constructor() {
    super("Model download cancelled");
    this.name = "ModelDownloadCancelled";
  }
}

export type ModelDownloadDeps = {
  cache: ModelCache;
  fetch: FetchPort;
  digest: DigestPort;
  /** Injected so a suite can walk a manifest of a few bytes. */
  files?: readonly ModelFile[];
  /** 0 to 1 across the whole set, counting what was already stored. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Bytes this site may still store, or `null` when the browser will not say. */
  freeBytes?: () => Promise<number | null>;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new ModelDownloadCancelled();
  }
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

function isQuotaError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error != null &&
    (error as { name?: unknown }).name === "QuotaExceededError"
  );
}

function storageMessage(needed: number, free?: number): string {
  const left =
    free == null ? "" : ` It has about ${megabytes(free)} MB left for this site.`;
  return `This browser does not have room for the voice model, which needs about ${megabytes(needed)} MB.${left}`;
}

/**
 * Gather one file's bytes, check them, and answer them.
 *
 * Into one buffer of the manifest's size rather than a list of chunks joined
 * at the end: the largest file is 256MB, and joining would hold it twice.
 */
async function fetchFile(
  file: ModelFile,
  deps: ModelDownloadDeps,
  onBytes: (delta: number) => void,
): Promise<Uint8Array> {
  const response = await deps.fetch(downloadUrl(file), { signal: deps.signal });
  if (!response.ok || response.body == null) {
    throw new Error(`${file.path}: HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(file.bytes);
  let received = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      throwIfAborted(deps.signal);
      if (received + value.byteLength > bytes.byteLength) {
        throw new Error(
          `${file.path}: expected ${file.bytes} bytes, received more`,
        );
      }
      bytes.set(value, received);
      received += value.byteLength;
      onBytes(value.byteLength);
    }
  } catch (error) {
    // Lets the browser close the connection rather than finish a body nobody
    // is reading.
    void reader.cancel().catch(() => undefined);
    throw error;
  }

  // The size is instant and catches a cut connection; the digest is the only
  // thing that catches a proxy that answered 200 with a login page.
  if (received !== file.bytes) {
    throw new Error(
      `${file.path}: expected ${file.bytes} bytes, received ${received}`,
    );
  }
  if ((await deps.digest(bytes)) !== file.sha256) {
    throw new Error(`${file.path}: checksum did not match`);
  }
  return bytes;
}

/**
 * Put the whole model in the cache, fetching only what is missing.
 *
 * Sequential, for the reason the desktop download is: four sockets do not make
 * a home connection faster, and they turn one legible bar into four. Throws
 * `ModelDownloadCancelled` when `signal` aborts; files that finished before
 * that are kept, so the next attempt resumes.
 */
export async function downloadModelToCache(
  deps: ModelDownloadDeps,
): Promise<{ downloaded: string[] }> {
  const files = deps.files ?? MODEL_FILES;
  const state = await modelState(deps.cache, files);
  let received = state.presentBytes;
  const downloaded: string[] = [];
  const report = () =>
    deps.onProgress?.(
      state.totalBytes > 0 ? Math.min(1, received / state.totalBytes) : 1,
    );

  report();
  if (state.complete) {
    return { downloaded };
  }

  // Asked before the first byte rather than discovered at the last `put`,
  // which would cost the user several minutes of download to learn it.
  const needed = state.totalBytes - state.presentBytes;
  const free = await deps.freeBytes?.().catch(() => null);
  if (free != null && free < needed) {
    throw new Error(storageMessage(needed, free));
  }

  try {
    for (const file of state.missing) {
      throwIfAborted(deps.signal);
      const before = received;
      const bytes = await fetchFile(file, deps, (delta) => {
        received += delta;
        report();
      });
      throwIfAborted(deps.signal);
      try {
        await deps.cache.put(downloadUrl(file), bytes);
      } catch (error) {
        throw isQuotaError(error) ? new Error(storageMessage(needed)) : error;
      }
      downloaded.push(file.path);
      // Re-seat on the manifest's figure, so a transport that reported a
      // different byte count cannot carry the bar past 100%.
      received = before + file.bytes;
      report();
    }
  } catch (error) {
    // A fetch aborted by the signal rejects with the browser's own AbortError.
    if (deps.signal?.aborted === true) {
      throw new ModelDownloadCancelled();
    }
    throw error;
  }

  return { downloaded };
}

/** One stored file's bytes, for the worker. Throws if it is not stored. */
export async function readModelFile(
  cache: ModelCache,
  path: string,
  files: readonly ModelFile[] = MODEL_FILES,
): Promise<Uint8Array> {
  const file = files.find((one) => one.path === path);
  if (file == null) {
    throw new Error(`${path} is not part of the voice model.`);
  }
  const buffer = await cache.read(downloadUrl(file));
  if (buffer == null) {
    throw new Error(
      "The voice model is missing a file. Download the voices again.",
    );
  }
  return new Uint8Array(buffer);
}

/** The real cache, over the browser's Cache Storage. */
export async function openModelCache(storage: CacheStorage): Promise<ModelCache> {
  const cache = await storage.open(MODEL_CACHE);
  return {
    keys: async () => (await cache.keys()).map((request) => request.url),
    put: (url, bytes) =>
      cache.put(
        url,
        new Response(bytes, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(bytes.byteLength),
          },
        }),
      ),
    read: async (url) => {
      const response = await cache.match(url);
      return response == null ? null : response.arrayBuffer();
    },
  };
}
