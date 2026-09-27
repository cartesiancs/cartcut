/**
 * Where the native input-monitor sidecar is, and whether this Mac can use it.
 *
 * `lib/speechBin.ts`'s sibling, and the same dev/packaged split: in the repo
 * `bin/` holds one directory per target, and electron-builder's
 * `extraResources` copies `bin/${platform}-${arch}` *flat* into `resources/bin`.
 *
 * The binary is built by `scripts/buildInput.mjs` from `native/cartcut-input/`.
 * It is not committed (`bin/` is gitignored) so it can be absent in a checkout
 * that has never run `npm run dev`, and `available` has to say so rather than
 * letting a spawn fail with ENOENT in the middle of starting a recording.
 *
 * There is no OS version gate, unlike the speech sidecar: every API it uses has
 * existed since macOS 10.6. Absence is the only reason it can be unavailable,
 * and absence is never an error: auto-zoom falls back to the cursor track,
 * which is what it ran on before clicks existed.
 */

import fs from "fs";
import path from "path";
import isDev from "electron-is-dev";

const TARGET = `${process.platform}-${process.arch}`;

/** This file compiles to `main/lib/inputBin.js`, so two levels up is the root. */
const devRoot = path.join(__dirname, "..", "..");
const resourcesPath = isDev == true ? devRoot : process.resourcesPath;

export const INPUT_BIN_PATH = path.join(
  isDev ? path.join(resourcesPath, "bin", TARGET) : path.join(resourcesPath, "bin"),
  "cartcut-input",
);

export function isInputMonitorAvailable(): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  return fs.existsSync(INPUT_BIN_PATH);
}

/** Why it is unavailable, for the dev log. Never shown to a user mid-recording. */
export function inputMonitorUnavailableReason(): string | null {
  if (process.platform !== "darwin") {
    return "Click detection is macOS only; auto-zoom will use the cursor track.";
  }
  if (!fs.existsSync(INPUT_BIN_PATH)) {
    return "The input monitor is missing from this build; auto-zoom will use the cursor track.";
  }
  return null;
}
