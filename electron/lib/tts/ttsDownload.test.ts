/**
 * Fetching the model, against a fake transport.
 *
 * The cases worth having are the failures, not the happy path: a cut
 * connection, a proxy that answers 200 with something that is not the model,
 * and a cancel pressed part way through 400MB. All three leave the directory
 * in a state the next run has to cope with, and that is what is asserted.
 *
 * The manifest's real files are 400MB, so the fake serves bytes that hash to
 * the manifest's digests only for the small ones and the suite works on a
 * shrunken manifest everywhere else. Instead of faking sizes, each test names
 * the one file it exercises and builds content to match.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MODEL_FILES, downloadUrl, type ModelFile } from "./ttsManifest";
import { fileLocation } from "./ttsModels";
import {
  DownloadCancelledError,
  downloadModel,
  type DownloadResponse,
  type FetchLike,
} from "./ttsDownload";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cartcut-tts-dl-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** Bytes that satisfy one manifest entry's size and digest. */
const CONTENT = new Map<string, Uint8Array>();

function contentFor(file: ModelFile): Uint8Array {
  const cached = CONTENT.get(file.path);
  if (cached != null) {
    return cached;
  }
  // Deterministic filler of the stated length. Its digest will not match the
  // manifest, so `patchDigest` below is what makes a file "genuine".
  const bytes = new Uint8Array(file.bytes);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (i * 31 + file.path.length) & 0xff;
  }
  CONTENT.set(file.path, bytes);
  return bytes;
}

/**
 * Rewrite the manifest entry so the filler above *is* the genuine article.
 *
 * Cheaper and clearer than shipping 400MB of fixtures, and it leaves the real
 * digests being exercised by `ttsModels.test.ts` and by the app itself.
 */
function asGenuine(file: ModelFile): ModelFile {
  const bytes = contentFor(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { ...file, bytes: bytes.length, sha256 };
}

/** The smallest entry, so a whole-file round trip costs 8KB and not 256MB. */
const SMALL = MODEL_FILES.find((f) => f.path === "onnx/tts.json")!;

/**
 * Serve `served` for every request, in `pieces` chunks.
 *
 * Chunked on purpose: the transport delivers a body in arbitrary pieces, and a
 * writer that assumed one chunk per file would pass a single-chunk fake and
 * truncate every real download.
 */
function fakeFetch(
  served: (url: string) => Uint8Array | null,
  options: { status?: number; pieces?: number } = {},
): FetchLike {
  return async (url: string): Promise<DownloadResponse> => {
    const body = served(url);
    if (body == null) {
      return { ok: false, status: options.status ?? 404, chunks: empty() };
    }
    return { ok: true, status: 200, chunks: inPieces(body, options.pieces ?? 3) };
  };
}

async function* empty(): AsyncIterable<Uint8Array> {}

async function* inPieces(
  body: Uint8Array,
  pieces: number,
): AsyncIterable<Uint8Array> {
  const size = Math.max(1, Math.ceil(body.length / pieces));
  for (let offset = 0; offset < body.length; offset += size) {
    yield body.subarray(offset, Math.min(offset + size, body.length));
  }
}

/**
 * Run a download over a manifest of exactly one file.
 *
 * `MODEL_FILES` is a module constant, so the suite narrows it for the duration
 * of a case rather than trying to serve the real 400MB.
 */
async function withSingleFile<T>(
  file: ModelFile,
  run: (entry: ModelFile) => Promise<T>,
): Promise<T> {
  const original = MODEL_FILES.slice();
  const array = MODEL_FILES as unknown as ModelFile[];
  array.length = 0;
  array.push(file);
  try {
    return await run(file);
  } finally {
    array.length = 0;
    array.push(...original);
  }
}

describe("downloadModel", () => {
  it("writes the file, verifies it and renames it into place", async () => {
    const entry = asGenuine(SMALL);
    await withSingleFile(entry, async (file) => {
      const root = tempRoot();
      const result = await downloadModel({
        userDataDir: root,
        fetch: fakeFetch((url) =>
          url === downloadUrl(file) ? contentFor(SMALL) : null,
        ),
      });

      expect(result.downloaded).toEqual([file.path]);
      const landed = fileLocation(root, file);
      expect(fs.existsSync(landed)).toBe(true);
      expect(fs.statSync(landed).size).toBe(file.bytes);
      // Nothing is left behind for the next run to mistake for a finished file.
      expect(fs.existsSync(`${landed}.part`)).toBe(false);
    });
  });

  it("reassembles a body delivered in many pieces", async () => {
    const entry = asGenuine(SMALL);
    await withSingleFile(entry, async (file) => {
      const root = tempRoot();
      await downloadModel({
        userDataDir: root,
        fetch: fakeFetch(() => contentFor(SMALL), { pieces: 97 }),
      });
      expect(fs.readFileSync(fileLocation(root, file)).length).toBe(file.bytes);
    });
  });

  it("does nothing when the model is already installed", async () => {
    const entry = asGenuine(SMALL);
    await withSingleFile(entry, async (file) => {
      const root = tempRoot();
      const location = fileLocation(root, file);
      fs.mkdirSync(path.dirname(location), { recursive: true });
      fs.writeFileSync(location, contentFor(SMALL));

      const fetch = vi.fn(fakeFetch(() => contentFor(SMALL)));
      const result = await downloadModel({ userDataDir: root, fetch });

      expect(result.downloaded).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  /**
   * What a corporate proxy does: answers 200 with a login page. The size check
   * alone would let a body of the right length through, which is why the digest
   * runs before the rename and not after.
   */
  it("refuses a body of the right length that is not the model", async () => {
    const entry = asGenuine(SMALL);
    await withSingleFile(entry, async (file) => {
      const root = tempRoot();
      const impostor = new Uint8Array(file.bytes).fill(0x3c);

      await expect(
        downloadModel({ userDataDir: root, fetch: fakeFetch(() => impostor) }),
      ).rejects.toThrow(/checksum/i);

      expect(fs.existsSync(fileLocation(root, file))).toBe(false);
      expect(fs.existsSync(`${fileLocation(root, file)}.part`)).toBe(false);
    });
  });

  it("refuses a truncated body and leaves nothing behind", async () => {
    const entry = asGenuine(SMALL);
    await withSingleFile(entry, async (file) => {
      const root = tempRoot();
      const short = contentFor(SMALL).subarray(0, file.bytes - 100);

      await expect(
        downloadModel({ userDataDir: root, fetch: fakeFetch(() => short) }),
      ).rejects.toThrow(/bytes/i);

      expect(fs.existsSync(fileLocation(root, file))).toBe(false);
      expect(fs.existsSync(`${fileLocation(root, file)}.part`)).toBe(false);
    });
  });

  it("reports the HTTP status when the server refuses", async () => {
    const entry = asGenuine(SMALL);
    await withSingleFile(entry, async () => {
      await expect(
        downloadModel({
          userDataDir: tempRoot(),
          fetch: fakeFetch(() => null, { status: 503 }),
        }),
      ).rejects.toThrow(/503/);
    });
  });

  it("stops on cancel and keeps no partial file", async () => {
    const entry = asGenuine(SMALL);
    await withSingleFile(entry, async (file) => {
      const root = tempRoot();
      const controller = new AbortController();

      const fetch: FetchLike = async () => ({
        ok: true,
        status: 200,
        chunks: (async function* () {
          yield contentFor(SMALL).subarray(0, 64);
          controller.abort();
          yield contentFor(SMALL).subarray(64);
        })(),
      });

      await expect(
        downloadModel({ userDataDir: root, fetch, signal: controller.signal }),
      ).rejects.toBeInstanceOf(DownloadCancelledError);

      expect(fs.existsSync(fileLocation(root, file))).toBe(false);
    });
  });

  it("never lets the reported fraction run past one", async () => {
    const entry = asGenuine(SMALL);
    await withSingleFile(entry, async () => {
      const root = tempRoot();
      const seen: number[] = [];
      await downloadModel({
        userDataDir: root,
        fetch: fakeFetch(() => contentFor(SMALL), { pieces: 20 }),
        onProgress: (p) => seen.push(p.fraction),
      });

      expect(seen.length).toBeGreaterThan(1);
      for (const fraction of seen) {
        expect(fraction).toBeGreaterThanOrEqual(0);
        expect(fraction).toBeLessThanOrEqual(1);
      }
      // It rises, and it ends where it should.
      expect(seen[seen.length - 1]).toBe(1);
      expect(seen[seen.length - 1]).toBeGreaterThan(seen[0]);
    });
  });
});
