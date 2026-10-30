/**
 * The browser's model store, against a fake cache and a fake network.
 *
 * The rule that matters is the one the module's header states: **a file is in
 * the cache only if it arrived whole and verified**, because availability
 * believes presence and the worker would otherwise load a truncated graph and
 * report a protobuf error a long way from the cause. So every way a download
 * can go wrong is checked for what it leaves behind, not only for the error.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  downloadUrl,
  type ModelFile,
} from "../../../../../../electron/lib/tts/ttsManifest";
import {
  MODEL_CACHE,
  ModelDownloadCancelled,
  downloadModelToCache,
  modelState,
  pruneStaleModelCaches,
  readModelFile,
  type FetchPort,
  type ModelCache,
} from "./webModelStore";

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const digest = async (bytes: Uint8Array) => sha256(bytes);

function fileOf(path: string, content: string): ModelFile & { content: Uint8Array } {
  const bytes = new TextEncoder().encode(content);
  return { path, bytes: bytes.byteLength, sha256: sha256(bytes), content: bytes };
}

const A = fileOf("onnx/a.onnx", "aaaaaaaaaa");
const B = fileOf("onnx/b.onnx", "bbbbbbbbbbbbbbbbbbbb");
const C = fileOf("voice_styles/M1.json", "cccccccccc");
const FILES = [A, B, C];
const TOTAL = A.bytes + B.bytes + C.bytes;

function fakeCache(initial: ModelFile[] = []) {
  const stored = new Map<string, Uint8Array>();
  for (const file of initial) {
    stored.set(downloadUrl(file), (file as typeof A).content);
  }
  let failPut: unknown = null;
  const cache: ModelCache = {
    keys: async () => [...stored.keys()],
    put: async (url, bytes) => {
      if (failPut != null) {
        throw failPut;
      }
      stored.set(url, bytes);
    },
    read: async (url) => {
      const bytes = stored.get(url);
      return bytes == null ? null : (bytes.slice().buffer as ArrayBuffer);
    },
  };
  return {
    cache,
    stored,
    failPutWith: (error: unknown) => {
      failPut = error;
    },
  };
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** Serves each file's content in two chunks, or what `override` says. */
function fakeNetwork(
  override: Record<string, { status?: number; body?: Uint8Array }> = {},
) {
  const requested: string[] = [];
  const fetch: FetchPort = async (url) => {
    requested.push(url);
    const file = FILES.find((one) => downloadUrl(one) === url)!;
    const special = override[file.path];
    const status = special?.status ?? 200;
    const body = special?.body ?? file.content;
    const half = Math.floor(body.byteLength / 2);
    return {
      ok: status >= 200 && status < 300,
      status,
      body: streamOf([body.slice(0, half), body.slice(half)]),
    };
  };
  return { fetch, requested };
}

describe("modelState", () => {
  it("reports nothing present on a first run", async () => {
    const state = await modelState(fakeCache().cache, FILES);
    expect(state).toMatchObject({ complete: false, presentBytes: 0, totalBytes: TOTAL });
    expect(state.missing.map((file) => file.path)).toEqual([A.path, B.path, C.path]);
  });

  it("counts what an interrupted download left, in manifest order", async () => {
    const state = await modelState(fakeCache([B]).cache, FILES);
    expect(state.complete).toBe(false);
    expect(state.presentBytes).toBe(B.bytes);
    expect(state.missing.map((file) => file.path)).toEqual([A.path, C.path]);
  });

  it("is complete when every file is stored", async () => {
    const state = await modelState(fakeCache(FILES).cache, FILES);
    expect(state).toMatchObject({ complete: true, presentBytes: TOTAL, missing: [] });
  });
});

describe("downloadModelToCache", () => {
  it("fetches only what is missing, verifies it and stores it", async () => {
    const { cache, stored } = fakeCache([B]);
    const network = fakeNetwork();
    const result = await downloadModelToCache({ cache, fetch: network.fetch, digest, files: FILES });

    expect(result.downloaded).toEqual([A.path, C.path]);
    expect(network.requested).toEqual([downloadUrl(A), downloadUrl(C)]);
    expect([...stored.get(downloadUrl(A))!]).toEqual([...A.content]);
    expect((await modelState(cache, FILES)).complete).toBe(true);
  });

  it("starts the bar at what was already stored and ends it at one", async () => {
    const fractions: number[] = [];
    await downloadModelToCache({
      cache: fakeCache([A]).cache,
      fetch: fakeNetwork().fetch,
      digest,
      files: FILES,
      onProgress: (fraction) => fractions.push(fraction),
    });
    expect(fractions[0]).toBeCloseTo(A.bytes / TOTAL);
    expect(fractions.at(-1)).toBe(1);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
  });

  it("asks nothing of the network when the model is already here", async () => {
    const network = fakeNetwork();
    const result = await downloadModelToCache({
      cache: fakeCache(FILES).cache,
      fetch: network.fetch,
      digest,
      files: FILES,
    });
    expect(result.downloaded).toEqual([]);
    expect(network.requested).toEqual([]);
  });

  it("stores nothing for a file whose digest does not match, and keeps the ones before it", async () => {
    const { cache, stored } = fakeCache();
    // Right length, wrong bytes: what a proxy's login page could look like.
    const impostor = new TextEncoder().encode("x".repeat(B.bytes));
    await expect(
      downloadModelToCache({
        cache,
        fetch: fakeNetwork({ [B.path]: { body: impostor } }).fetch,
        digest,
        files: FILES,
      }),
    ).rejects.toThrow(`${B.path}: checksum did not match`);
    expect(stored.has(downloadUrl(A))).toBe(true);
    expect(stored.has(downloadUrl(B))).toBe(false);
    expect(stored.has(downloadUrl(C))).toBe(false);
  });

  it("refuses a body cut short, and one longer than the manifest says", async () => {
    const short = fakeCache();
    await expect(
      downloadModelToCache({
        cache: short.cache,
        fetch: fakeNetwork({ [A.path]: { body: A.content.slice(0, 3) } }).fetch,
        digest,
        files: FILES,
      }),
    ).rejects.toThrow(`expected ${A.bytes} bytes, received 3`);
    expect(short.stored.size).toBe(0);

    const long = fakeCache();
    await expect(
      downloadModelToCache({
        cache: long.cache,
        fetch: fakeNetwork({
          [A.path]: { body: new TextEncoder().encode("a".repeat(A.bytes + 5)) },
        }).fetch,
        digest,
        files: FILES,
      }),
    ).rejects.toThrow("received more");
    expect(long.stored.size).toBe(0);
  });

  it("reports an HTTP failure with the file it was fetching", async () => {
    await expect(
      downloadModelToCache({
        cache: fakeCache().cache,
        fetch: fakeNetwork({ [A.path]: { status: 404 } }).fetch,
        digest,
        files: FILES,
      }),
    ).rejects.toThrow(`${A.path}: HTTP 404`);
  });

  it("stops on cancel, keeps finished files, and resumes from them", async () => {
    const { cache, stored } = fakeCache();
    const controller = new AbortController();
    // B's body delivers one chunk, then fails the way a browser does when the
    // request's signal aborts.
    const fetch: FetchPort = async (url, init) => {
      if (url !== downloadUrl(B)) {
        return fakeNetwork().fetch(url, init);
      }
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(B.content.slice(0, 4));
            init.signal?.addEventListener("abort", () =>
              stream.error(new DOMException("aborted", "AbortError")),
            );
            controller.abort();
          },
        }),
      };
    };

    await expect(
      downloadModelToCache({ cache, fetch, digest, files: FILES, signal: controller.signal }),
    ).rejects.toBeInstanceOf(ModelDownloadCancelled);
    expect([...stored.keys()]).toEqual([downloadUrl(A)]);

    const network = fakeNetwork();
    await downloadModelToCache({ cache, fetch: network.fetch, digest, files: FILES });
    expect(network.requested).toEqual([downloadUrl(B), downloadUrl(C)]);
  });

  it("says there is no room before fetching anything", async () => {
    const network = fakeNetwork();
    await expect(
      downloadModelToCache({
        cache: fakeCache([A]).cache,
        fetch: network.fetch,
        digest,
        files: FILES,
        freeBytes: async () => 5,
      }),
    ).rejects.toThrow("does not have room for the voice model");
    expect(network.requested).toEqual([]);
  });

  it("goes ahead when the browser will not say how much room there is", async () => {
    const result = await downloadModelToCache({
      cache: fakeCache().cache,
      fetch: fakeNetwork().fetch,
      digest,
      files: FILES,
      freeBytes: async () => null,
    });
    expect(result.downloaded).toHaveLength(3);
  });

  it("turns a full cache into a sentence about room", async () => {
    const store = fakeCache();
    store.failPutWith(new DOMException("full", "QuotaExceededError"));
    await expect(
      downloadModelToCache({ cache: store.cache, fetch: fakeNetwork().fetch, digest, files: FILES }),
    ).rejects.toThrow("does not have room for the voice model");
  });
});

describe("readModelFile", () => {
  it("answers a stored file's bytes", async () => {
    const bytes = await readModelFile(fakeCache(FILES).cache, B.path, FILES);
    expect([...bytes]).toEqual([...B.content]);
  });

  it("says to download again when a file has gone", async () => {
    await expect(readModelFile(fakeCache([A]).cache, B.path, FILES)).rejects.toThrow(
      "Download the voices again",
    );
  });

  it("refuses a path the manifest does not name", async () => {
    await expect(
      readModelFile(fakeCache(FILES).cache, "../secret", FILES),
    ).rejects.toThrow("not part of the voice model");
  });
});

describe("pruneStaleModelCaches", () => {
  it("drops other revisions and leaves this one and everything else alone", async () => {
    const names = [MODEL_CACHE, "cartcut-tts-oldrevision", "some-other-cache"];
    const deleted: string[] = [];
    const answer = await pruneStaleModelCaches({
      keys: async () => names,
      delete: async (name) => {
        deleted.push(name);
        return true;
      },
    });
    expect(answer).toEqual(["cartcut-tts-oldrevision"]);
    expect(deleted).toEqual(["cartcut-tts-oldrevision"]);
  });
});
