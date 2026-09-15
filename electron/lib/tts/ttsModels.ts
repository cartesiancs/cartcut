/**
 * Where the model lives on this machine, and whether it is usable.
 *
 * The user data root arrives as an argument rather than being read from
 * `app.getPath`, for the reason `features/project/assetPaths.ts` takes its path
 * flavour explicitly: Electron cannot be loaded in a suite, and path arithmetic
 * that only runs inside the app is arithmetic nothing checks. `tts.ts` supplies
 * the real root.
 *
 * Availability is decided here, in JS, before any process is started. That is
 * the rule `lib/speechBin.ts` states: it is cheaper than spawning something to
 * be told no, and the answer survives as a reason code the panel can act on.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  MODEL_FILES,
  MODEL_REVISION,
  totalBytesOf,
  type ModelFile,
} from "./ttsManifest";

/** Derived media and models live beside the app, never beside the footage. */
export function modelsRoot(userDataDir: string): string {
  return path.join(userDataDir, "tts-models", "supertonic-3");
}

/** This revision's directory. A different revision is a different directory. */
export function modelDir(userDataDir: string): string {
  return path.join(modelsRoot(userDataDir), MODEL_REVISION);
}

/** Where the generated .wav files are cached. */
export function speechCacheDir(userDataDir: string): string {
  return path.join(userDataDir, "tts");
}

export function fileLocation(userDataDir: string, file: ModelFile): string {
  // The manifest is posix-separated because it mirrors URL paths; on Windows
  // `path.join` is what turns that into something the filesystem accepts.
  return path.join(modelDir(userDataDir), ...file.path.split("/"));
}

export type InstallState = {
  /** Every file is present at its stated size. */
  complete: boolean;
  /** Bytes on disk that count towards the total, for a resumed download. */
  presentBytes: number;
  totalBytes: number;
  /** Manifest paths still to fetch. */
  missing: string[];
};

/**
 * What is on disk, by name and size only.
 *
 * Deliberately does not hash. This runs every time the panel opens, and
 * digesting 400MB to draw a button would cost about a second of the main
 * process each time. Size catches the case that actually happens, an
 * interrupted download, and `verifyFile` is the expensive check that runs once
 * where it earns its keep.
 */
export function installState(userDataDir: string): InstallState {
  let presentBytes = 0;
  const missing: string[] = [];

  for (const file of MODEL_FILES) {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(fileLocation(userDataDir, file));
    } catch {
      stat = null;
    }
    if (stat != null && stat.isFile() && stat.size === file.bytes) {
      presentBytes += file.bytes;
    } else {
      missing.push(file.path);
    }
  }

  return {
    complete: missing.length === 0,
    presentBytes,
    totalBytes: totalBytesOf(MODEL_FILES),
    missing,
  };
}

/**
 * The digest of what is actually on disk, or null if it cannot be read.
 *
 * Streamed rather than read whole: `vector_estimator.onnx` is 256MB and
 * `readFileSync` would hold all of it plus the hash state at once, in the
 * process that also runs the app's windows.
 */
export function digestOf(location: string): string | null {
  try {
    const hash = createHash("sha256");
    const fd = fs.openSync(location, "r");
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (read <= 0) {
          break;
        }
        hash.update(buffer.subarray(0, read));
      }
    } finally {
      fs.closeSync(fd);
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/** Whether one file is the one the manifest names, contents and all. */
export function verifyFile(userDataDir: string, file: ModelFile): boolean {
  return digestOf(fileLocation(userDataDir, file)) === file.sha256;
}

/**
 * Why synthesis cannot run, or null when it can.
 *
 * A code rather than a sentence, for the reason `Emitter.swift` gives for the
 * STT sidecar's codes: "the model is still downloading" and "the model is not
 * there" call for different buttons, and the distinction has to survive the
 * trip to the renderer.
 */
export type TtsUnavailable = "models_not_installed" | "models_incomplete";

export type TtsAvailability =
  | { ok: true; totalBytes: number }
  | {
      ok: false;
      reason: TtsUnavailable;
      presentBytes: number;
      totalBytes: number;
    };

/**
 * Note there is no platform gate here, unlike the speech sidecar's.
 * ONNX Runtime ships for darwin, win32 and linux alike, so this works
 * everywhere the app does.
 */
export function availability(userDataDir: string): TtsAvailability {
  const state = installState(userDataDir);
  if (state.complete) {
    return { ok: true, totalBytes: state.totalBytes };
  }
  return {
    ok: false,
    // Nothing at all reads as a first run; a partial set reads as an
    // interrupted one, which the panel offers to resume rather than restart.
    reason:
      state.presentBytes === 0 ? "models_not_installed" : "models_incomplete",
    presentBytes: state.presentBytes,
    totalBytes: state.totalBytes,
  };
}

/**
 * Revision directories other than the current one.
 *
 * Handed to the panel so a model the app no longer uses can be removed without
 * the renderer ever naming a path to delete, which is the rule
 * `autosave:dropRings` follows.
 */
export function staleRevisions(userDataDir: string): string[] {
  try {
    return fs
      .readdirSync(modelsRoot(userDataDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== MODEL_REVISION)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
