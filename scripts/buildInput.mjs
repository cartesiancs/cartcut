/**
 * Build the native input-monitor sidecar into `bin/<platform>-<arch>/`.
 *
 * `scripts/buildSpeech.mjs`'s sibling, and everything that file's header says
 * about two thin slices, `extraResources` and electron-builder signing every
 * Mach-O under `Contents/` applies here unchanged. Read that one first.
 *
 * Two differences, both because this binary is much less demanding than the
 * speech one:
 *
 *  - **No SDK gate.** `NSEvent.addGlobalMonitorForEvents` is macOS 10.6 API. The
 *    speech sidecar needs the macOS 26 SDK because `SpeechAnalyzer` does not
 *    exist before it; nothing here does.
 *  - **No frameworks to name beyond AppKit**, which `-framework AppKit` supplies.
 *
 * The macOS 12 deployment target is kept for the reason `buildSpeech.mjs`
 * documents: below 12.0 a binary wanting Swift concurrency's back-deployment
 * dylib has nowhere sane to put it, and above it buys nothing when the shipped
 * ffmpeg is already `minos 12.0`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "native", "cartcut-input", "Sources");

const DEPLOYMENT_TARGET = "12.0";

const TARGETS = [
  { arch: "arm64", dir: "darwin-arm64", triple: `arm64-apple-macos${DEPLOYMENT_TARGET}` },
  { arch: "x86_64", dir: "darwin-x64", triple: `x86_64-apple-macos${DEPLOYMENT_TARGET}` },
];

/** Skipping is normal on Windows and on a Mac with no Xcode. Saying so is not. */
function skip(reason) {
  console.log(
    `[buildInput] Skipping the native input sidecar: ${reason}.\n` +
      `[buildInput] Auto-zoom will run on the cursor track alone, without clicks.`,
  );
  process.exit(0);
}

if (process.platform !== "darwin") {
  skip(`this is ${process.platform}, not macOS`);
}
if (spawnSync("xcrun", ["-f", "swiftc"], { encoding: "utf8" }).status !== 0) {
  skip("no Swift compiler (install Xcode or the Command Line Tools)");
}

const sources = fs
  .readdirSync(sourceDir)
  .filter((name) => name.endsWith(".swift"))
  .map((name) => path.join(sourceDir, name));

if (sources.length === 0) {
  console.error(`[buildInput] No Swift sources in ${sourceDir}`);
  process.exit(1);
}

const newestSource = Math.max(...sources.map((file) => fs.statSync(file).mtimeMs));
const sdkPath = execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
  encoding: "utf8",
}).trim();

/** Only the host arch in dev; both when packaging. */
const wanted = process.argv.includes("--all")
  ? TARGETS
  : TARGETS.filter((target) => target.arch === (process.arch === "arm64" ? "arm64" : "x86_64"));

for (const target of wanted) {
  const outDir = path.join(root, "bin", target.dir);
  const outPath = path.join(outDir, "cartcut-input");

  // Staleness, so the `npm run dev` hook is free after the first run.
  if (fs.existsSync(outPath) && fs.statSync(outPath).mtimeMs > newestSource) {
    console.log(`[buildInput] ${target.dir}/cartcut-input is up to date`);
    continue;
  }

  fs.mkdirSync(outDir, { recursive: true });

  const result = spawnSync(
    "xcrun",
    [
      "--sdk", "macosx", "swiftc",
      "-O", "-wmo",
      "-swift-version", "6",
      "-target", target.triple,
      "-sdk", sdkPath,
      "-framework", "AppKit",
      "-o", outPath,
      ...sources,
    ],
    { stdio: "inherit" },
  );

  // A compile failure on a machine that *can* build it is a bug, not a reason
  // to ship a DMG with the feature quietly missing.
  if (result.status !== 0) {
    console.error(`[buildInput] swiftc failed for ${target.triple}`);
    process.exit(1);
  }

  fs.chmodSync(outPath, 0o755);

  // The check CLAUDE.md makes for ffmpeg, for the same reason: an x86_64 binary
  // in the arm64 slot runs fine under Rosetta and says nothing about it.
  const archs = execFileSync("lipo", ["-archs", outPath], { encoding: "utf8" }).trim();
  if (!archs.split(/\s+/).includes(target.arch)) {
    console.error(`[buildInput] ${outPath} is "${archs}", expected ${target.arch}`);
    process.exit(1);
  }

  console.log(`[buildInput] built ${target.dir}/cartcut-input (${archs})`);
}
