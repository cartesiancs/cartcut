/**
 * Where things are, and what the profile in force says.
 *
 * Everything else in the harness resolves paths through here so there is one
 * answer to "which profile am I" — the specs, the fixture loader and the
 * artifact writer all have to agree, and a second `process.env` read is a
 * second place for them to disagree.
 */

import fs from "node:fs";
import path from "node:path";

// See the note in playwright.config.ts: these TS files are transpiled to CJS,
// so `import.meta.url` is not available here.
const HERE = __dirname;

export const E2E_ROOT = path.resolve(HERE, "..");
export const REPO_ROOT = path.resolve(E2E_ROOT, "../..");
export const FIXTURE_DIR = path.join(E2E_ROOT, ".fixtures");
export const OUT_DIR = path.join(E2E_ROOT, ".out");

/**
 * The same per-target layout `electron/lib/ffmpeg.ts` reads in development.
 *
 * The harness has to measure the delivered file with the *same* binary the app
 * encoded it with, or a decoder difference reads as a defect in the export. It
 * also has to be the native one: an x86_64 build under Rosetta would make every
 * timing number in `FINDINGS.md` describe a machine nobody is running.
 */
const BIN_DIR = path.join(
  REPO_ROOT,
  "bin",
  `${process.platform}-${process.arch}`,
);
const EXE = process.platform === "win32" ? ".exe" : "";

export const FFMPEG = path.join(BIN_DIR, `ffmpeg${EXE}`);
export const FFPROBE = path.join(BIN_DIR, `ffprobe${EXE}`);

export type ProfileName = "smoke" | "smoke120" | "full" | "extreme";

export type Profile = {
  name: ProfileName;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  note: string;
};

const PROFILES: Record<string, Omit<Profile, "name">> = JSON.parse(
  fs.readFileSync(path.join(E2E_ROOT, "profiles.json"), "utf8"),
);

export function profileNamed(name: string): Profile {
  const found = PROFILES[name];
  if (found == null) {
    throw new Error(
      `unknown profile "${name}" — expected one of ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  return { name: name as ProfileName, ...found };
}

/**
 * The profile this worker is running.
 *
 * Playwright sets it per project (see `playwright.config.ts`); the env var is
 * how it reaches code that has no access to the `testInfo`.
 */
export function activeProfile(): Profile {
  return profileNamed(process.env.CARTCUT_E2E_PROFILE ?? "full");
}

/** Frames an export of this profile produces — mirrors `features/export/frames.ts`. */
export function frameCount(profile: Profile): number {
  return Math.round(profile.durationSec * profile.fps);
}

/** The timeline position, in ms, of an absolute frame index. */
export function frameTimeMs(frameIndex: number, fps: number): number {
  return (frameIndex / fps) * 1000;
}

// ---------------------------------------------------------------- fixtures

export type ProbedStream = {
  bytes: number;
  durationSec: number;
  video?: {
    codec: string;
    width: number;
    height: number;
    pixFmt: string;
    frameRate: string;
    avgFrameRate: string;
    rotation: number | null;
  };
  audio?: { codec: string; sampleRate: number; channels: number };
};

export type FixtureEntry = ProbedStream & {
  id: string;
  path: string;
  describes: string;
};

export type Region = { x: number; y: number; w: number; h: number };
export type CodeRegion = Region & { bits: number; patch: number };
export type SwatchRegion = Region & { count: number; patchW: number };

export type Regions = {
  code: CodeRegion;
  swatch: SwatchRegion;
  ticker: Region;
  content: Region;
};

export type InstrumentSet = {
  paths: {
    code: string;
    tickerTile: string;
    ticker: string;
    swatch: string;
    syncFlash: string;
    syncClick: string;
    carrierBlock: string;
  };
  probed: Record<string, ProbedStream>;
  regions: Regions;
  frames: number;
};

export type FixtureManifest = {
  generatedAt: string;
  fixtureDir: string;
  ffmpeg: string;
  ffprobe: string;
  video: FixtureEntry[];
  audio: FixtureEntry[];
  instruments: Record<string, InstrumentSet>;
};

const MANIFEST_PATH = path.join(FIXTURE_DIR, "manifest.json");

/**
 * The fixtures as they exist on disk, not as they were planned.
 *
 * The manifest is written by `fixtures/fetch.mjs` from ffprobe output, so what
 * the scenario places on the timeline is what ffmpeg actually produced —
 * including any respect in which it declined to do what it was asked. A plan
 * read directly would describe a file that might not exist.
 */
export function loadFixtures(): FixtureManifest {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(
      `No fixture manifest at ${MANIFEST_PATH}.\nRun: npm run test:e2e:fixtures`,
    );
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

export function instrumentsFor(profile: Profile): InstrumentSet {
  const manifest = loadFixtures();
  const set = manifest.instruments[profile.name];
  if (set == null) {
    throw new Error(
      `No instruments built for profile "${profile.name}".\n` +
      `Run: node tests/e2e/fixtures/fetch.mjs --profile ${profile.name}`,
    );
  }
  if (set.frames !== frameCount(profile)) {
    throw new Error(
      `Instruments for "${profile.name}" were built for ${set.frames} frames, ` +
      `profile now wants ${frameCount(profile)}. Rebuild with --force.`,
    );
  }
  return set;
}

export function videoFixture(manifest: FixtureManifest, id: string): FixtureEntry {
  const found = manifest.video.find((v) => v.id === id);
  if (found == null) throw new Error(`no video fixture "${id}"`);
  return found;
}

export function audioFixture(manifest: FixtureManifest, id: string): FixtureEntry {
  const found = manifest.audio.find((a) => a.id === id);
  if (found == null) throw new Error(`no audio fixture "${id}"`);
  return found;
}
