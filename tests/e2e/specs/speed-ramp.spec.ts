/**
 * A speed ramp, measured frame by frame in the delivered file.
 *
 * Every other check on the ramp is arithmetic about arithmetic: the node suites
 * prove the integral is right and the parity suite proves the retimed audio
 * lands where the integral says. This one asks the only question that matters
 * to somebody watching the export, and asks it of the real app through the real
 * Render button: **is output frame N the source frame the ramp says it is?**
 *
 * Ordinary footage cannot answer that. The `code` instrument can: it burns its
 * own frame index into a band of every frame, so a full decode of the delivered
 * file reads back exactly which source frame each output frame shows.
 * `decodeIndexMap` compares that against the identity, which is right for a 1x
 * clip and meaningless here, so this spec builds its own expectation from
 * `sourceTimeAt` and compares against that instead.
 *
 * The last step hands the same decoded file a *different* ramp's expectation and
 * requires it to fail. Without it, a spec that silently measured an un-ramped
 * export would pass everything above.
 */

import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../harness/test";
import { agent } from "../harness/agent";
import { runExport } from "../harness/export";
import { decodeIndexMap, countFrames } from "../harness/decode";
import {
  setProjectFolder,
  setDuration,
  setResolution,
  setBackgroundColor,
  setFps,
  setExportPreset,
} from "../harness/ui";

/**
 * The ramp under test, as fractions of whatever source window the clip lands
 * with.
 *
 * Fractions rather than milliseconds because `add_media` places the instrument
 * at its own full length, which is the profile's duration and not a number this
 * file should be restating. Slow into the middle and fast out of it, so one
 * export covers both directions and both limits of the range, and so a sign
 * error anywhere in the integral moves the answer rather than cancelling.
 */
const RAMP_SHAPE: Array<[number, number]> = [
  [0, 1],
  [0.33, 0.25],
  [0.67, 4],
  [1, 1],
];

/** The same shape reversed, for the step that proves the check discriminates. */
const OTHER_SHAPE: Array<[number, number]> = [
  [0, 4],
  [0.33, 4],
  [0.67, 0.25],
  [1, 0.25],
];

type Ramp = Array<{ t: number; v: number }>;

function rampOver(fromMs: number, toMs: number, shape: Array<[number, number]>): Ramp {
  const span = toMs - fromMs;
  return shape.map(([fraction, v]) => ({ t: fromMs + span * fraction, v }));
}

test("a speed ramp delivers the frames its integral names", async ({
  session,
  instruments,
  profile,
  artifactDir,
}, testInfo) => {
  test.setTimeout(10 * 60_000);

  const { page } = session;
  const width = profile.width;
  const height = profile.height;
  const fps = profile.fps;

  const projectDir = path.join(artifactDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const destination = path.join(artifactDir, "ramp.mp4");

  await test.step("configure the project", async () => {
    await setProjectFolder(session, projectDir);
    await setResolution(page, width, height);
    await setBackgroundColor(page, "#101820");
    await setFps(page, fps);
    await setExportPreset(page, "low");
  });

  const source = await test.step("place the frame-index instrument", async () => {
    const added = await agent<any>(session, "add_media", {
      items: [{ path: instruments.paths.code, startMs: 0 }],
      sequential: false,
    });
    expect(added.skipped ?? []).toEqual([]);

    return page.evaluate(() => {
      const store = (window as any).CARTCUT.useTimelineStore;
      const id = Object.keys(store.getState().timeline)[0];
      const element = store.getState().timeline[id];
      return { id, trim: element.trim, duration: element.duration };
    });
  });

  const RAMP = rampOver(source.trim.startTime, source.trim.endTime, RAMP_SHAPE);

  const placed = await test.step("put the ramp on it", async () => {
    // Through the same pure op the graph in the option panel calls. Driving the
    // canvas with synthetic pointer events instead would prove Playwright can
    // hit a pixel; what is under test is whether the ramp reaches the file.
    return page.evaluate(
      ({ id, ramp }) => {
        const store = (window as any).CARTCUT.useTimelineStore;
        const setCurve = (window as any).CARTCUT.setClipSpeedCurve;
        store
          .getState()
          .withCheckpoint((d: any) => setCurve(d, id, ramp, { ripple: true }));
        const element = store.getState().timeline[id];
        return {
          id,
          speed: element.speed,
          duration: element.duration,
          trim: element.trim,
          spanMs: element.duration / element.speed,
          points: element.speedCurve,
        };
      },
      { id: source.id, ramp: RAMP },
    );
  });

  await testInfo.attach("ramped-clip.json", {
    body: JSON.stringify(placed, null, 2),
    contentType: "application/json",
  });

  expect(placed.points).toHaveLength(RAMP.length);
  // The source window is untouched, which is the invariant a retime must not
  // break: none of the footage is gained or lost, only how long it takes.
  expect(placed.duration).toBeCloseTo(source.duration, 3);
  expect(placed.trim.endTime - placed.trim.startTime).toBeCloseTo(
    source.duration,
    3,
  );
  // And the clip got longer, because most of this ramp is slow motion.
  expect(placed.spanMs).toBeGreaterThan(source.duration);

  // Whole **seconds** of the ramped span: the duration field is two integer
  // boxes, minutes and seconds, so a fractional length is not a thing the
  // settings panel can be asked for. Flooring keeps every output frame inside
  // the clip, so none of them reads the background.
  const durationSec = Math.floor(placed.spanMs / 1000);
  const frames = durationSec * fps;

  await test.step("set the project to the length the ramp asks for", async () => {
    await setDuration(page, durationSec);
  });

  const outcome = await test.step("click Render and wait for FFmpeg", async () => {
    const result = await runExport(session, { destination, timeoutMs: 8 * 60_000 });
    await testInfo.attach("export-outcome.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
    return result;
  });

  if (outcome.status !== "finished") {
    throw new Error(
      `export ${outcome.status}: ${outcome.error?.message ?? ""}\n` +
        `${outcome.error?.stderrTail ?? "(no ffmpeg stderr)"}`,
    );
  }

  expect(fs.existsSync(destination)).toBe(true);
  expect(await countFrames(destination)).toBeGreaterThanOrEqual(frames);

  const map = await decodeIndexMap(destination, instruments.regions.code);

  /** Which source frame the ramp says output frame `i` shows. */
  const expectedAt = (i: number, ramp: Ramp): number => {
    // `sourceTimeAt`, restated: the export seeks to the *centre* of each output
    // frame, carried into source time by the ramp's integral. Restated rather
    // than imported because this file runs outside the bundle's type program,
    // and `speedCurve.test.ts` is what holds the two forms to each other.
    const timelineMs = ((i + 0.5) / fps) * 1000;
    let cum = 0;
    for (let s = 0; s < ramp.length - 1; s++) {
      const [a, b] = [ramp[s], ramp[s + 1]];
      const d = b.t - a.t;
      const m = (b.v - a.v) / d;
      const width = Math.abs(m) < 1e-9 ? d / a.v : Math.log1p((m * d) / a.v) / m;
      if (cum + width >= timelineMs) {
        const u = timelineMs - cum;
        const w = Math.abs(m) < 1e-9 ? a.v * u : (a.v * Math.expm1(m * u)) / m;
        return Math.floor(((a.t + w) / 1000) * fps);
      }
      cum += width;
    }
    const last = ramp[ramp.length - 1];
    return Math.floor(((last.t + (timelineMs - cum) * last.v) / 1000) * fps);
  };

  const wanted = Array.from({ length: frames }, (_, i) => expectedAt(i, RAMP));
  const decoded = map.decoded.slice(0, frames);

  const offsets = decoded.map((value, i) => value - wanted[i]);
  const worst = offsets.reduce((a, b) => Math.max(a, Math.abs(b)), 0);
  const exact = offsets.filter((offset) => offset === 0).length;

  await testInfo.attach("ramp-index-map.json", {
    body: JSON.stringify(
      {
        frames,
        exact,
        worst,
        histogram: offsets.reduce<Record<string, number>>((acc, offset) => {
          acc[String(offset)] = (acc[String(offset)] ?? 0) + 1;
          return acc;
        }, {}),
        head: decoded.slice(0, 24),
        wantedHead: wanted.slice(0, 24),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });

  await test.step("every frame is the one the ramp's integral names", () => {
    // Measured:
    //
    //   smoke, 640x360 @30, 20s   600 of 600 exact,        worst offset 0
    //   full, 1920x1080 @60, 304s 18,239 of 18,240 exact,  worst offset 1
    //
    // The one frame at 1080p60 is the coincidence the slack is here for: the
    // seek lands on a source instant the map computes, and an instant that
    // falls within a rounding of a frame boundary can resolve either side of
    // it. One frame in a hundred is left for that and nothing else. At 4x a
    // single output frame advances four source frames, so a real error in the
    // map cannot hide under either bound.
    expect(worst).toBeLessThanOrEqual(1);
    expect(exact / frames).toBeGreaterThanOrEqual(0.99);
  });

  await test.step("the footage never runs backwards", () => {
    // A ramp only ever slows the source down or speeds it up; a decoded index
    // that went back would mean the map is not monotone, which no positive
    // speed can produce.
    const regressions = decoded.filter((value, i) => i > 0 && value < decoded[i - 1]);
    expect(regressions).toEqual([]);
  });

  await test.step("the ramp is visible in the delivered file's own pacing", () => {
    // Slow in the middle, fast after it: measured as source frames advanced per
    // output frame, which is the rate the ramp asks for and nothing else.
    const rateOver = (from: number, to: number) =>
      (decoded[to] - decoded[from]) / (to - from);
    const slowest = rateOver(Math.round(frames * 0.25), Math.round(frames * 0.35));
    const fastest = rateOver(Math.round(frames * 0.75), Math.round(frames * 0.85));
    expect(slowest).toBeLessThan(0.6);
    expect(fastest).toBeGreaterThan(1.8);
  });

  await test.step("the expectation is measuring something", () => {
    // The same decoded file against a ramp that runs the other way. If this
    // agreed, the check above would be reading its own assumptions back.
    const other = rampOver(
      source.trim.startTime,
      source.trim.endTime,
      OTHER_SHAPE,
    );
    const wrong = Array.from({ length: frames }, (_, i) => expectedAt(i, other));
    const worstWrong = decoded.reduce(
      (most, value, i) => Math.max(most, Math.abs(value - wrong[i])),
      0,
    );
    expect(worstWrong).toBeGreaterThan(10);
  });
});
