/**
 * The model store: path arithmetic, what counts as installed, and the digests.
 *
 * Runs against real temporary directories rather than a mocked `fs`. The rules
 * being checked are all about what the filesystem actually reports (a file that
 * is present but short, a directory that is not there at all), and a mock would
 * only ever return what this file told it to.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MODEL_FILES,
  MODEL_REVISION,
  MODEL_TOTAL_BYTES,
  VOICE_IDS,
  downloadUrl,
  isVoiceId,
} from "./ttsManifest";
import {
  availability,
  digestOf,
  fileLocation,
  installState,
  modelDir,
  speechCacheDir,
  staleRevisions,
} from "./ttsModels";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cartcut-tts-models-"));
  roots.push(root);
  return root;
}

/**
 * Put a file of exactly the manifest's size where the manifest expects it.
 *
 * Truncated to length rather than written, so the whole 400MB set costs no
 * bytes and no wait. `installState` only ever stats, so a sparse file is
 * indistinguishable from a downloaded one to the code under test.
 */
function place(root: string, manifestPath: string, bytes?: number): void {
  const file = MODEL_FILES.find((entry) => entry.path === manifestPath)!;
  const location = fileLocation(root, file);
  fs.mkdirSync(path.dirname(location), { recursive: true });
  const fd = fs.openSync(location, "w");
  try {
    fs.ftruncateSync(fd, bytes ?? file.bytes);
  } finally {
    fs.closeSync(fd);
  }
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("the manifest", () => {
  it("names every file exactly once", () => {
    const paths = MODEL_FILES.map((file) => file.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("states a digest and a size for every file", () => {
    for (const file of MODEL_FILES) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes).toBeGreaterThan(0);
    }
  });

  it("carries the four graphs and all ten voices", () => {
    const paths = MODEL_FILES.map((file) => file.path);
    for (const graph of [
      "duration_predictor",
      "text_encoder",
      "vector_estimator",
      "vocoder",
    ]) {
      expect(paths).toContain(`onnx/${graph}.onnx`);
    }
    for (const voice of VOICE_IDS) {
      expect(paths).toContain(`voice_styles/${voice}.json`);
    }
    expect(VOICE_IDS.length).toBe(10);
  });

  it("adds up to the total the panel shows", () => {
    expect(MODEL_TOTAL_BYTES).toBe(
      MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0),
    );
    // Roughly 400MB. A manifest edit that lost a graph would pass every
    // assertion above and fail this one.
    expect(MODEL_TOTAL_BYTES).toBeGreaterThan(390_000_000);
    expect(MODEL_TOTAL_BYTES).toBeLessThan(410_000_000);
  });

  it("pins every URL to the revision rather than to a branch", () => {
    for (const file of MODEL_FILES) {
      const url = downloadUrl(file);
      expect(url).toContain(MODEL_REVISION);
      expect(url).not.toContain("/main/");
      expect(url.endsWith(file.path)).toBe(true);
    }
  });

  it("recognises the voices it ships and nothing else", () => {
    expect(isVoiceId("M1")).toBe(true);
    expect(isVoiceId("F5")).toBe(true);
    expect(isVoiceId("M6")).toBe(false);
    expect(isVoiceId("")).toBe(false);
    expect(isVoiceId(undefined)).toBe(false);
  });
});

describe("path arithmetic", () => {
  it("puts the revision in the directory name", () => {
    const dir = modelDir("/data");
    expect(dir).toContain(MODEL_REVISION);
    expect(dir).toContain("tts-models");
  });

  it("keeps generated speech apart from the models", () => {
    expect(speechCacheDir("/data")).not.toContain("tts-models");
  });

  it("turns the manifest's posix paths into host paths", () => {
    const file = MODEL_FILES.find((f) => f.path.includes("/"))!;
    const location = fileLocation("/data", file);
    // Whatever the separator is here, the last segment is the file name.
    expect(path.basename(location)).toBe(file.path.split("/").pop());
    expect(location.startsWith(modelDir("/data"))).toBe(true);
  });
});

describe("installState", () => {
  it("reports a first run as nothing present", () => {
    const root = tempRoot();
    const state = installState(root);
    expect(state.complete).toBe(false);
    expect(state.presentBytes).toBe(0);
    expect(state.missing.length).toBe(MODEL_FILES.length);
  });

  it("counts only the files that are the right size", () => {
    const root = tempRoot();
    place(root, "onnx/tts.json");
    const state = installState(root);
    const tts = MODEL_FILES.find((f) => f.path === "onnx/tts.json")!;
    expect(state.presentBytes).toBe(tts.bytes);
    expect(state.missing).not.toContain("onnx/tts.json");
  });

  /**
   * The case that actually happens. A download killed part way leaves a file
   * with the right name and the wrong length, and ONNX Runtime reports that as
   * a protobuf parse error a long way from the cause.
   */
  it("treats a truncated file as missing rather than as present", () => {
    const root = tempRoot();
    place(root, "onnx/tts.json", 10);
    const state = installState(root);
    expect(state.presentBytes).toBe(0);
    expect(state.missing).toContain("onnx/tts.json");
  });

  it("is complete only when every file is there", () => {
    const root = tempRoot();
    for (const file of MODEL_FILES) {
      expect(installState(root).complete).toBe(false);
      place(root, file.path);
    }
    const state = installState(root);
    expect(state.complete).toBe(true);
    expect(state.presentBytes).toBe(MODEL_TOTAL_BYTES);
    expect(state.missing).toEqual([]);
  });
});

describe("availability", () => {
  it("separates a first run from an interrupted one", () => {
    const root = tempRoot();

    const fresh = availability(root);
    expect(fresh.ok).toBe(false);
    expect(fresh.ok === false && fresh.reason).toBe("models_not_installed");

    place(root, "onnx/tts.json");
    const partial = availability(root);
    expect(partial.ok).toBe(false);
    expect(partial.ok === false && partial.reason).toBe("models_incomplete");
    expect(partial.ok === false && partial.presentBytes).toBeGreaterThan(0);
  });

  it("says yes once every file is in place", () => {
    const root = tempRoot();
    for (const file of MODEL_FILES) {
      place(root, file.path);
    }
    expect(availability(root).ok).toBe(true);
  });
});

describe("digestOf", () => {
  it("hashes what is on disk", () => {
    const root = tempRoot();
    const file = path.join(root, "probe.bin");
    fs.writeFileSync(file, "abc");
    // sha256("abc"), which shares no code with the implementation.
    expect(digestOf(file)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes a file larger than one read buffer in one piece", () => {
    const root = tempRoot();
    const file = path.join(root, "big.bin");
    // Two full 1MB buffers and a remainder, so the streaming loop has to run
    // more than once and finish a partial read correctly.
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024 * 2 + 7, 0x41));
    const digest = digestOf(file);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // Compare against the same bytes hashed in one call, not in chunks.
    const oneShot = require("node:crypto")
      .createHash("sha256")
      .update(Buffer.alloc(1024 * 1024 * 2 + 7, 0x41))
      .digest("hex");
    expect(digest).toBe(oneShot);
  });

  it("answers null rather than throwing for a file that is not there", () => {
    expect(digestOf(path.join(tempRoot(), "absent.bin"))).toBe(null);
  });
});

describe("staleRevisions", () => {
  it("lists other revisions and never the current one", () => {
    const root = tempRoot();
    const models = path.dirname(modelDir(root));
    fs.mkdirSync(path.join(models, MODEL_REVISION), { recursive: true });
    fs.mkdirSync(path.join(models, "0000oldrevision"), { recursive: true });

    const stale = staleRevisions(root);
    expect(stale).toEqual(["0000oldrevision"]);
    expect(stale).not.toContain(MODEL_REVISION);
  });

  it("answers nothing rather than throwing before anything is installed", () => {
    expect(staleRevisions(tempRoot())).toEqual([]);
  });
});
