/**
 * Build the native speech-to-text sidecar into `bin/<platform>-<arch>/`.
 *
 * `native/cartcut-stt/` is committed source; the binary is a build artefact,
 * like `main/` and `apps/overlay-record/dist/`. `bin/` is gitignored, so this
 * is what puts `cartcut-stt` where `electron/lib/speechBin.ts` looks for it.
 *
 * Two thin binaries rather than one `lipo` universal: electron-builder's
 * `extraResources` copies only the matching `bin/${platform}-${arch}` into the
 * DMG, so a universal binary would ship half its bytes unused. That is also why
 * `build:osx` has to build *both* — one electron-builder run reads both
 * directories.
 *
 * Nothing signs it here. electron-builder signs every Mach-O it finds under
 * `Contents/`, deepest-first with the `.app` last — verified against the 0.5.4
 * build, where an entirely unsigned `bin/darwin-x64/ffmpeg` came out carrying
 * Developer ID, the hardened runtime and this repo's `entitlementsInherit`. An
 * `afterSign` hook would be actively wrong: it would invalidate the outer
 * signature that seals `Contents/Resources` and fail notarization.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "native", "cartcut-stt", "Sources");

/** The SDK this needs. `SpeechAnalyzer` does not exist before it. */
const REQUIRED_SDK_MAJOR = 26;

/**
 * Older than everything it uses, on purpose.
 *
 * Swift concurrency is in the OS from 12.0 — below that the binary would want
 * Xcode's back-deployment `libswift_Concurrency.dylib`, whose install name is
 * `@rpath/…`, and a bare CLI has no sane place to put it. Above 12.0 buys
 * nothing: the shipped ffmpeg is already `minos 12.0`.
 */
const DEPLOYMENT_TARGET = "12.0";

const TARGETS = [
  { arch: "arm64", dir: "darwin-arm64", triple: `arm64-apple-macos${DEPLOYMENT_TARGET}` },
  { arch: "x86_64", dir: "darwin-x64", triple: `x86_64-apple-macos${DEPLOYMENT_TARGET}` },
];

/** Skipping is normal on Windows and on a Mac with no Xcode. Saying so is not. */
function skip(reason) {
  console.log(
    `[buildSpeech] Skipping the native speech sidecar: ${reason}.\n` +
      `[buildSpeech] The app will fall back to the OpenAI transcription back end.`,
  );
  process.exit(0);
}

function sdkVersion() {
  const result = spawnSync("xcrun", ["--sdk", "macosx", "--show-sdk-version"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

if (process.platform !== "darwin") {
  skip(`this is ${process.platform}, not macOS`);
}
if (spawnSync("xcrun", ["-f", "swiftc"], { encoding: "utf8" }).status !== 0) {
  skip("no Swift compiler (install Xcode or the Command Line Tools)");
}

const sdk = sdkVersion();
if (sdk == null) {
  skip("could not read the macOS SDK version");
}
if (Number(sdk.split(".")[0]) < REQUIRED_SDK_MAJOR) {
  skip(`macOS ${REQUIRED_SDK_MAJOR} SDK not found (have ${sdk})`);
}

const sources = fs
  .readdirSync(sourceDir)
  .filter((name) => name.endsWith(".swift"))
  .map((name) => path.join(sourceDir, name));

if (sources.length === 0) {
  console.error(`[buildSpeech] No Swift sources in ${sourceDir}`);
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
  const outPath = path.join(outDir, "cartcut-stt");

  // Staleness, so the `npm run dev` hook is free after the first run.
  if (fs.existsSync(outPath) && fs.statSync(outPath).mtimeMs > newestSource) {
    console.log(`[buildSpeech] ${target.dir}/cartcut-stt is up to date`);
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
      "-framework", "Speech",
      "-framework", "AVFoundation",
      "-o", outPath,
      ...sources,
    ],
    { stdio: "inherit" },
  );

  // A compile failure on a machine that *can* build it is a bug, not a reason
  // to ship a DMG with the feature quietly missing.
  if (result.status !== 0) {
    console.error(`[buildSpeech] swiftc failed for ${target.triple}`);
    process.exit(1);
  }

  fs.chmodSync(outPath, 0o755);

  // The check CLAUDE.md makes for ffmpeg, for the same reason: an x86_64 binary
  // in the arm64 slot runs fine under Rosetta and says nothing about it.
  const archs = execFileSync("lipo", ["-archs", outPath], { encoding: "utf8" }).trim();
  if (!archs.split(/\s+/).includes(target.arch)) {
    console.error(`[buildSpeech] ${outPath} is "${archs}", expected ${target.arch}`);
    process.exit(1);
  }

  console.log(`[buildSpeech] built ${target.dir}/cartcut-stt (${archs})`);
}
