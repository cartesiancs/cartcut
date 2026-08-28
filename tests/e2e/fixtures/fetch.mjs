#!/usr/bin/env node
/**
 * Build the E2E media fixtures.
 *
 * Idempotent by design: a file whose sha256 already matches the lock is left
 * alone, so a second run costs a few hashes and nothing else. Run it with
 * `npm run test:e2e:fixtures`, or let the specs run it — they call the same
 * `ensureFixtures()` entry point and skip instantly when everything is present.
 *
 *   node tests/e2e/fixtures/fetch.mjs                # every profile
 *   node tests/e2e/fixtures/fetch.mjs --profile smoke
 *   node tests/e2e/fixtures/fetch.mjs --force        # rebuild derived files
 *
 * Output goes to `tests/e2e/.fixtures/` (gitignored) together with a
 * `manifest.json` that records what was actually produced, probed with ffprobe
 * rather than assumed. The specs read that manifest; they never read this file.
 * That way what the tests place on the timeline is what is genuinely on disk,
 * including any respect in which ffmpeg declined to do what it was asked.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCES, VIDEO_VARIANTS, AUDIO_VARIANTS, STILL_VARIANTS, SYNTH_AUDIO } from "./plan.mjs";
import { codeStripJob, tickerJobs, swatchJob, syncJobs, carrierBlockJob } from "./instruments.mjs";
import { regionsFor, frameCount } from "./geometry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const E2E_ROOT = path.resolve(HERE, "..");
export const REPO_ROOT = path.resolve(E2E_ROOT, "../..");
export const FIXTURE_DIR = path.join(E2E_ROOT, ".fixtures");

// Per-target, matching `electron/lib/ffmpeg.ts` and `harness/paths.ts`: the
// fixtures have to be built by the same binary that will later decode them.
const BIN_DIR = path.join(REPO_ROOT, "bin", `${process.platform}-${process.arch}`);
const EXE = process.platform === "win32" ? ".exe" : "";
const FFMPEG = path.join(BIN_DIR, `ffmpeg${EXE}`);
const FFPROBE = path.join(BIN_DIR, `ffprobe${EXE}`);
const LOCK = path.join(FIXTURE_DIR, "sources.lock.json");
const MANIFEST = path.join(FIXTURE_DIR, "manifest.json");

const PROFILES = JSON.parse(fs.readFileSync(path.join(E2E_ROOT, "profiles.json"), "utf8"));

// ---------------------------------------------------------------- utilities

function log(...parts) {
  process.stdout.write(`${parts.join(" ")}\n`);
}

async function sha256(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return hash.digest("hex");
}

const exists = (p) => fs.existsSync(p) && fs.statSync(p).size > 0;

/**
 * Run a binary with an argv array and no shell.
 *
 * No shell means no quoting layer, which matters more than it sounds: every
 * ffmpeg filter expression here contains commas that have to reach ffmpeg
 * escaped exactly once. Going through a shell would add a second layer and the
 * escaping would have to be right for both.
 */
function run(bin, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => {
      err += d;
      if (err.length > 64_000) err = err.slice(-32_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${path.basename(bin)} exited ${code}\n${args.join(" ")}\n${err.slice(-3000)}`));
    });
  });
}

async function ffmpeg(args, label) {
  const started = Date.now();
  await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", ...args]);
  log(`    ${label}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/** Everything the specs need to know about a produced file, straight from ffprobe. */
async function probe(file) {
  const { stdout } = await run(FFPROBE, [
    "-hide_banner", "-loglevel", "error",
    "-show_streams", "-show_format", "-of", "json", file,
  ], { capture: true });
  const parsed = JSON.parse(stdout);
  const video = parsed.streams.find((s) => s.codec_type === "video");
  const audio = parsed.streams.find((s) => s.codec_type === "audio");

  return {
    bytes: fs.statSync(file).size,
    durationSec: Number(parsed.format?.duration ?? 0),
    video: video && {
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      pixFmt: video.pix_fmt,
      frameRate: video.r_frame_rate,
      avgFrameRate: video.avg_frame_rate,
      rotation: video.side_data_list?.find((d) => d.rotation != null)?.rotation ?? null,
    },
    audio: audio && {
      codec: audio.codec_name,
      sampleRate: Number(audio.sample_rate),
      channels: audio.channels,
    },
  };
}

async function download(url, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  const response = await fetch(url, {
    headers: {
      // Wikimedia refuses requests without one, and it is polite to say who
      // this is rather than impersonating a browser.
      "user-agent": "cartcut-e2e-fixtures/1.0 (+https://github.com/cartesiancs/cartcut)",
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
  }
  await fsp.writeFile(partial, Buffer.from(await response.arrayBuffer()));
  await fsp.rename(partial, dest);
}

// ------------------------------------------------------------------- stages

async function ensureSources(lock, { force }) {
  log("sources");
  for (const source of SOURCES) {
    const dest = path.join(FIXTURE_DIR, source.file);
    const recorded = source.sha256 ?? lock.sources?.[source.id] ?? null;

    if (!force && exists(dest)) {
      const actual = await sha256(dest);
      if (recorded == null) {
        lock.sources = { ...lock.sources, [source.id]: actual };
        log(`    ${source.id}  cached, recorded ${actual.slice(0, 12)}`);
        continue;
      }
      if (actual === recorded) {
        log(`    ${source.id}  cached`);
        continue;
      }
      log(`    ${source.id}  hash changed (${actual.slice(0, 12)} != ${recorded.slice(0, 12)}), re-downloading`);
    }

    log(`    ${source.id}  GET ${source.url}`);
    await download(source.url, dest);
    const actual = await sha256(dest);

    if (recorded != null && actual !== recorded) {
      throw new Error(
        `${source.id}: downloaded file hashes ${actual}, expected ${recorded}.\n` +
        `The upstream file changed. Verify it is still the media you expect, then update\n` +
        `SOURCES[].sha256 in tests/e2e/fixtures/plan.mjs.`,
      );
    }
    lock.sources = { ...lock.sources, [source.id]: actual };
    log(`    ${source.id}  ${(fs.statSync(dest).size / 1e6).toFixed(1)} MB  ${actual.slice(0, 12)}`);
  }
}

async function ensureVariants(variants, { force }) {
  const produced = [];
  for (const variant of variants) {
    const source = SOURCES.find((s) => s.id === variant.from);
    if (source == null) throw new Error(`variant ${variant.id} names unknown source ${variant.from}`);

    const input = path.join(FIXTURE_DIR, source.file);
    const dest = path.join(FIXTURE_DIR, variant.file);
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    if (force || !exists(dest)) {
      await ffmpeg(
        ["-t", `${variant.trimSec}`, "-i", input, ...variant.args, dest],
        `${variant.id}  ${variant.describes}`,
      );
    } else {
      log(`    ${variant.id}  cached`);
    }
    produced.push({ id: variant.id, path: dest, describes: variant.describes, ...(await probe(dest)) });
  }
  return produced;
}

/**
 * Stills and GIFs.
 *
 * Separate from `ensureVariants` only because `probe()` reports a PNG as a
 * one-frame video stream with a nonsense duration, and pretending otherwise
 * would put misleading numbers in the manifest.
 */
async function ensureStills(variants, { force }) {
  const produced = [];
  for (const variant of variants) {
    const source = SOURCES.find((s) => s.id === variant.from);
    if (source == null) throw new Error(`still ${variant.id} names unknown source ${variant.from}`);
    const input = path.join(FIXTURE_DIR, source.file);
    const dest = path.join(FIXTURE_DIR, variant.file);
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    if (force || !exists(dest)) {
      await ffmpeg(
        ["-t", `${variant.trimSec}`, "-i", input, ...variant.args, dest],
        `${variant.id}  ${variant.describes}`,
      );
    } else {
      log(`    ${variant.id}  cached`);
    }
    const probed = await probe(dest);
    produced.push({
      id: variant.id,
      path: dest,
      describes: variant.describes,
      bytes: probed.bytes,
      width: probed.video?.width ?? null,
      height: probed.video?.height ?? null,
      pixFmt: probed.video?.pixFmt ?? null,
    });
  }
  return produced;
}

async function ensureSynthAudio({ force }) {
  const produced = [];
  for (const item of SYNTH_AUDIO) {
    const dest = path.join(FIXTURE_DIR, item.file);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (force || !exists(dest)) {
      await ffmpeg(["-f", "lavfi", "-i", item.lavfi, ...item.args, dest], `${item.id}  ${item.describes}`);
    } else {
      log(`    ${item.id}  cached`);
    }
    produced.push({ id: item.id, path: dest, describes: item.describes, ...(await probe(dest)) });
  }
  return produced;
}

async function ensureInstruments(name, profile, { force }) {
  const dir = path.join(FIXTURE_DIR, "instruments", name);
  await fsp.mkdir(dir, { recursive: true });

  const paths = {
    code: path.join(dir, "code.mp4"),
    tickerTile: path.join(dir, "ticker-tile.png"),
    ticker: path.join(dir, "ticker.mp4"),
    swatch: path.join(dir, "swatch.png"),
    syncFlash: path.join(dir, "sync-flash.mp4"),
    syncClick: path.join(dir, "sync-click.wav"),
    carrierBlock: path.join(dir, "carrier-block.png"),
  };

  const jobs = [
    codeStripJob(profile, paths.code),
    ...tickerJobs(profile, paths.tickerTile, paths.ticker),
    swatchJob(profile, paths.swatch),
    ...syncJobs(profile, paths.syncFlash, paths.syncClick),
    carrierBlockJob(profile, paths.carrierBlock),
  ];
  const outputs = [paths.code, paths.tickerTile, paths.ticker, paths.swatch, paths.syncFlash, paths.syncClick, paths.carrierBlock];

  if (!force && outputs.every(exists)) {
    log(`    ${name}  cached`);
  } else {
    for (const job of jobs) {
      await ffmpeg(job.args, job.label);
    }
  }

  const probed = {};
  for (const [key, file] of Object.entries(paths)) {
    if (key === "tickerTile" || key === "swatch" || key === "carrierBlock") continue;
    probed[key] = await probe(file);
  }

  // A code strip that is one frame short would make every alignment assertion
  // read as an off-by-one at the tail. Catch it here, where the message can say
  // what actually happened.
  const want = frameCount(profile);
  const { stdout } = await run(FFPROBE, [
    "-hide_banner", "-loglevel", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames", "-of", "default=nk=1:nw=1", paths.code,
  ], { capture: true });
  const got = Number(stdout.trim());
  if (got !== want) {
    throw new Error(`instruments/${name}: code strip has ${got} frames, profile needs ${want}`);
  }

  return { paths, probed, regions: regionsFor(profile), frames: want };
}

// --------------------------------------------------------------------- main

export async function ensureFixtures({ profiles = Object.keys(PROFILES), force = false } = {}) {
  await fsp.mkdir(FIXTURE_DIR, { recursive: true });
  for (const bin of [FFMPEG, FFPROBE]) {
    if (!exists(bin)) {
      throw new Error(`${bin} is missing. See the README — ffmpeg and ffprobe must be in ./bin/${process.platform}-${process.arch}.`);
    }
  }

  const lock = exists(LOCK) ? JSON.parse(await fsp.readFile(LOCK, "utf8")) : {};

  await ensureSources(lock, { force });
  await fsp.writeFile(LOCK, `${JSON.stringify(lock, null, 2)}\n`);

  log("video variants");
  const video = await ensureVariants(VIDEO_VARIANTS, { force });
  log("stills and gifs");
  const still = await ensureStills(STILL_VARIANTS, { force });
  log("audio variants");
  const audio = await ensureVariants(AUDIO_VARIANTS, { force });
  log("synthesised audio");
  const synth = await ensureSynthAudio({ force });

  log("instruments");
  // Carry forward instrument sets this run was not asked to build. A
  // `--profile full` run must not quietly delete `smoke`'s entry from the
  // manifest and leave the smoke specs reporting "no instruments built".
  const previous = exists(MANIFEST) ? JSON.parse(await fsp.readFile(MANIFEST, "utf8")) : {};
  const instruments = { ...(previous.instruments ?? {}) };
  for (const name of profiles) {
    const profile = PROFILES[name];
    if (profile == null) throw new Error(`unknown profile "${name}"`);
    instruments[name] = await ensureInstruments(name, profile, { force });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    fixtureDir: FIXTURE_DIR,
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    video,
    still,
    audio: [...audio, ...synth],
    instruments,
  };
  await fsp.writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`\nmanifest -> ${MANIFEST}`);
  log(`${video.length} video, ${still.length} still/gif, ${manifest.audio.length} audio, ${Object.keys(instruments).length} instrument set(s)`);
  return manifest;
}

const invokedDirectly = process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const at = argv.indexOf("--profile");
  const profiles = at >= 0 ? [argv[at + 1]] : Object.keys(PROFILES);

  ensureFixtures({ profiles, force }).catch((error) => {
    process.stderr.write(`\n${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
