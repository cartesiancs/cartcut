/**
 * Where the native speech-to-text sidecar is, and whether this Mac can use it.
 *
 * The same dev/packaged split `lib/ffmpeg.ts` documents: in the repo `bin/`
 * holds one directory per target, and electron-builder's `extraResources`
 * copies `bin/${platform}-${arch}` *flat* into `resources/bin`.
 *
 * The binary is built by `scripts/buildSpeech.mjs` from `native/cartcut-stt/`.
 * It is not committed — `bin/` is gitignored — so it can be absent in a
 * checkout that has never run `npm run dev`, and `available` has to say so
 * rather than letting a spawn fail with ENOENT somewhere less legible.
 */

import fs from "fs";
import path from "path";
import isDev from "electron-is-dev";

const TARGET = `${process.platform}-${process.arch}`;

/** This file compiles to `main/lib/speechBin.js`, so two levels up is the root. */
const devRoot = path.join(__dirname, "..", "..");
const resourcesPath = isDev == true ? devRoot : process.resourcesPath;

export const SPEECH_BIN_PATH = path.join(
  isDev ? path.join(resourcesPath, "bin", TARGET) : path.join(resourcesPath, "bin"),
  "cartcut-stt",
);

/** macOS 26 is where `SpeechAnalyzer` starts existing. */
const REQUIRED_MAJOR = 26;

/**
 * Decided here, in JS, before anything is spawned.
 *
 * Cheaper than starting a process to be told no, and — more importantly — it
 * cannot be confused by a dyld diagnostic. The sidecar's own `if #available`
 * is the second line of defence, not the first.
 *
 * `process.getSystemVersion()` is Electron's, e.g. `"26.6.2"`. It is not
 * available in a plain node process, which is why this module is the Electron
 * half and `speechStt.ts` — the part with logic worth testing — is not.
 */
export function isNativeSpeechAvailable(): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  const major = Number(process.getSystemVersion().split(".")[0]);
  if (!Number.isFinite(major) || major < REQUIRED_MAJOR) {
    return false;
  }
  return fs.existsSync(SPEECH_BIN_PATH);
}

/** Why it is unavailable, for a message the user can act on. */
export function nativeSpeechUnavailableReason(): string | null {
  if (process.platform !== "darwin") {
    return "On-device transcription is macOS only.";
  }
  const major = Number(process.getSystemVersion().split(".")[0]);
  if (!Number.isFinite(major) || major < REQUIRED_MAJOR) {
    return "On-device transcription needs macOS 26 or later.";
  }
  if (!fs.existsSync(SPEECH_BIN_PATH)) {
    return "The on-device speech component is missing from this build.";
  }
  return null;
}
