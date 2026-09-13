/**
 * Our level envelope against FFmpeg's, on the same curve.
 *
 * Every other test of this feature checks the implementation against *itself*:
 * `audioEnvelope.test.ts` checks the simplifier against its own tolerance,
 * `ffmpegArgs.test.ts` checks two hand copies of the same arithmetic agree.
 * All of them would go on passing against a wrong-but-consistent idea of what
 * the emitted expression means: an off-by-one in the breakpoint times, a
 * slope with the wrong sign on one side of a corner, a `between` whose bounds
 * overlap and double the gain at every seam.
 *
 * This one cannot. It builds a curve the way the app builds one, through the
 * real `keyframeOps`, asks `audioEnvelope.ts` for the expression the exporter
 * would actually emit, runs it through the **bundled ffmpeg**, and measures the
 * delivered level with `volumedetect` against what the **renderer's own
 * sampler** says the clip plays at the same instants. The two sides share no
 * code: one is a piecewise-linear expression evaluated in C, the other is a
 * nearest-sample read of a baked lane in JS.
 *
 * ## The tolerance, and why it is not zero
 *
 * Three things separate the two sides, and none of them is arithmetic. The
 * preview reads the baked lane by nearest-sample snap, so it *steps* at the
 * bake rate, while the export interpolates between the simplified points, so it
 * *ramps*. The simplifier is allowed `ENVELOPE_TOLERANCE_DB` of its own.
 * And `volumedetect` reports a mean over a window, to one decimal place.
 *
 * Measured on the cases below, the worst disagreement is **0.3 dB** and most
 * are 0.10, which is `volumedetect`'s own resolution. The check is stated at
 * 0.35 rather than pretending the two are identical, and it is tight enough
 * that the defect it was written against (interpolating gain where the curve is
 * drawn in dB, which put a linear fade 3.9 dB out at its quarter point) fails
 * it by an order of magnitude.
 *
 * Every probe window is short and sits where the curve is locally flat enough
 * for its mean to mean something. A window straddling a steep corner would
 * measure the window, not the curve.
 *
 * ## It proves it is measuring something
 *
 * The last case hands the two sides *different* curves and requires them to
 * disagree loudly. Without it a harness that silently measured the unfiltered
 * tone would pass every case above.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { envelopeFor, volumeExprOf } from "./audioEnvelope";
// Reaching across the rootDir boundary is safe in a test file and nowhere else.
import { volumeDbAt } from "../../apps/app/src/features/timeline/audio";
import {
  addKeyframe,
  setTrackActive,
} from "../../apps/app/src/features/animation/keyframeOps";
import { audioElement } from "../../apps/app/src/features/renderer/testing";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../../apps/app/src/features/timeline/tracks";

const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * The bundled binary for this machine.
 *
 * `electron/lib/ffmpeg.ts` picks the same directory from `process.arch`; this
 * repeats the rule rather than importing it, because that module reaches
 * Electron and cannot be loaded here. `lut/ffmpegParity.test.ts` says the same.
 */
function ffmpegPath(): string | null {
  const dir =
    process.platform === "win32"
      ? "win32-x64"
      : process.arch === "arm64"
        ? "darwin-arm64"
        : "darwin-x64";
  const binary = path.join(
    REPO_ROOT,
    "bin",
    dir,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  return fs.existsSync(binary) ? binary : null;
}

const FFMPEG = ffmpegPath();
const CLIP_MS = 4000;

/** A document holding one four-second audio clip, and nothing else. */
function baseDoc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("a1", "audio", 0)],
    elements: {
      a: audioElement({
        trackId: "a1",
        startTime: 0,
        duration: CLIP_MS,
        trim: { startTime: 0, endTime: CLIP_MS },
        sourceDuration: CLIP_MS,
      }),
    },
  });
}

/**
 * Build a level envelope the way the app does, through the real ops.
 *
 * Deliberately not a hand-written `animation` literal. Going through
 * `setTrackActive` and `addKeyframe` is what makes the baked lane this test
 * reads the same lane the app would have written, handles and all, so a change
 * to how curves are baked shows up here rather than being papered over by a
 * fixture that was true once.
 */
function withEnvelope(stops: Array<[number, number]>): any {
  let doc = setTrackActive(baseDoc(), "a", "volumeDb", true, { atMs: 0 });
  for (const [tMs, db] of stops) {
    // `handleMs: 0` is a linear segment. Every NLE's audio keyframes default to
    // linear, and `addKeyframe`'s 100ms handles would otherwise describe an
    // ease-in-out: a fade that starts slow, races, then dawdles reads as a
    // stutter. `applyTypewriter` makes the same call for the same reason.
    doc = addKeyframe(doc, "a", "volumeDb", "x", tMs, db, 0);
  }
  return doc.elements.a;
}

let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartcut-envelope-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The mean level of one window of a tone, in dBFS, after `filters`.
 *
 * A constant-amplitude sine rather than a file: the source level is then the
 * same everywhere, so the difference between two measurements is entirely the
 * filter's doing. No codec anywhere, for the reason the LUT parity test gives.
 */
function measureDb(filters: string, fromSec: number, toSec: number): number {
  // `spawnSync` rather than `execFileSync`, because `volumedetect` reports on
  // **stderr** and `execFileSync` returns stdout alone. The first draft read an
  // empty string and every case skipped itself with a parse error.
  const run = spawnSync(
    FFMPEG!,
    [
      "-nostdin",
      "-hide_banner",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=1000:duration=${CLIP_MS / 1000}:sample_rate=48000`,
      "-af",
      `${filters},atrim=start=${fromSec}:end=${toSec},volumedetect`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const stderr = `${run.stderr ?? ""}`;
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  if (match == null) {
    throw new Error(`no mean_volume in ffmpeg output:\n${stderr}`);
  }
  return Number(match[1]);
}

// Same chain the exporter builds, minus `adelay`: this clip sits at 0 and the
// measurement is in clip-local seconds either way.
function chainFor(element: any): string {
  const envelope = envelopeFor(element);
  if (envelope == null) {
    throw new Error("expected an envelope");
  }
  return `asetnsamples=n=256:p=0,volume=eval=frame:volume='${volumeExprOf(envelope)}'`;
}

describe.skipIf(FFMPEG == null)("level envelope, against ffmpeg", () => {
  /** The unfiltered tone, so every case measures a difference rather than a level. */
  let unity = 0;

  beforeAll(() => {
    unity = measureDb("anull", 0.9, 1.1);
  });

  const cases: Array<{
    name: string;
    stops: Array<[number, number]>;
    probes: number[];
  }> = [
    {
      name: "a linear fade out",
      stops: [
        [0, 0],
        [CLIP_MS, -40],
      ],
      probes: [500, 1500, 2500, 3500],
    },
    {
      name: "a fade in then out",
      stops: [
        [0, -40],
        [CLIP_MS / 2, 0],
        [CLIP_MS, -40],
      ],
      probes: [500, 1500, 2500, 3500],
    },
    {
      name: "a hold, a dip, and a recovery",
      stops: [
        [0, 0],
        [1200, 0],
        [1600, -18],
        [2400, -18],
        [2800, 0],
        [CLIP_MS, 0],
      ],
      probes: [600, 2000, 3400],
    },
    {
      name: "a boost above unity",
      stops: [
        [0, 0],
        [CLIP_MS, 9],
      ],
      probes: [500, 1500, 2500, 3500],
    },
  ];

  for (const { name, stops, probes } of cases) {
    it(`matches the renderer's sampler on ${name}`, () => {
      const element = withEnvelope(stops);
      const chain = chainFor(element);

      for (const atMs of probes) {
        const from = (atMs - 100) / 1000;
        const to = (atMs + 100) / 1000;
        const measured = measureDb(chain, from, to) - unity;
        const predicted = volumeDbAt(element, atMs);
        expect(
          Math.abs(measured - predicted),
          `at ${atMs}ms: ffmpeg ${measured.toFixed(2)} dB, sampler ${predicted.toFixed(2)} dB`,
        ).toBeLessThanOrEqual(0.35);
      }
    });
  }

  it("silences the clip where the envelope reaches the floor", () => {
    // -60 dB is a hard zero on both sides, not `10 ** (-60/20)`, which is
    // 0.001 and plainly audible on a loud source. When the user pulls the line
    // to the bottom they mean off.
    const element = withEnvelope([
      [0, 0],
      [2000, -60],
      [CLIP_MS, -60],
    ]);
    const measured = measureDb(chainFor(element), 3.0, 3.5);
    expect(measured).toBeLessThan(-80);
  });

  it("measures something: a different curve disagrees loudly", () => {
    // Without this, a harness that quietly measured the unfiltered tone, or
    // emitted an expression ffmpeg rejected and fell back to unity, would pass
    // every case above.
    const drawn = withEnvelope([
      [0, 0],
      [CLIP_MS, -40],
    ]);
    const other = withEnvelope([
      [0, -40],
      [CLIP_MS, 0],
    ]);
    const measured = measureDb(chainFor(other), 3.4, 3.6) - unity;
    const predicted = volumeDbAt(drawn, 3500);
    expect(Math.abs(measured - predicted)).toBeGreaterThan(20);
  });
});
