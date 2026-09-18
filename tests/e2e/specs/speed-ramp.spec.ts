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

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../harness/test";
import { agent } from "../harness/agent";
import { runExport } from "../harness/export";
import { decodeIndexMap, countFrames } from "../harness/decode";
import { FFMPEG } from "../harness/paths";
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

/** The curve prepared for evaluation, restated for a file outside the bundle. */
function prepareCurve(points: Ramp): { points: Ramp; cum: number[] } {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = b.t - a.t;
    const m = (b.v - a.v) / d;
    cum.push(
      cum[i - 1] + (Math.abs(b.v - a.v) < 1e-9 ? d / a.v : Math.log1p((m * d) / a.v) / m),
    );
  }
  return { points, cum };
}

/** Timeline ms from `fromSourceMs` to `sourceMs` on the curve. */
function timelineMsAt(
  curve: { points: Ramp; cum: number[] },
  fromSourceMs: number,
  sourceMs: number,
): number {
  const at = (x: number): number => {
    const p = curve.points;
    const last = p.length - 1;
    if (x <= p[0].t) return (x - p[0].t) / p[0].v;
    if (x >= p[last].t) return curve.cum[last] + (x - p[last].t) / p[last].v;
    let i = 0;
    while (i < last - 1 && p[i + 1].t <= x) i++;
    const a = p[i];
    const b = p[i + 1];
    const d = b.t - a.t;
    const m = (b.v - a.v) / d;
    const w = x - a.t;
    return curve.cum[i] + (Math.abs(b.v - a.v) < 1e-9 ? w / a.v : Math.log1p((m * w) / a.v) / m);
  };
  return at(sourceMs) - at(fromSourceMs);
}

/**
 * Where the loud stretches begin in a delivered file, in ms.
 *
 * Paired, because `silencedetect` closes its books at EOF with a `silence_end`
 * that is not an onset.
 */
function burstStartsMs(file: string): number[] {
  const result = spawnSync(
    FFMPEG,
    [
      "-nostdin", "-hide_banner",
      "-i", file,
      "-af", "silencedetect=noise=-45dB:d=0.05",
      "-f", "null", "-",
    ],
    { encoding: "utf8", maxBuffer: 64 << 20 },
  );
  const text = result.stderr ?? "";
  const ends = [...text.matchAll(/silence_end: ([0-9.]+)/g)].map(
    (m) => Number(m[1]) * 1000,
  );
  const starts = [...text.matchAll(/silence_start: ([0-9.]+)/g)].map(
    (m) => Number(m[1]) * 1000,
  );
  return ends.filter((at) => starts.some((start) => start > at));
}

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

  const source = await test.step("place the frame-index instrument and a click track", async () => {
    // The click track is the point of the second item. Until it was here the
    // whole spec ran on a silent instrument, so the export's audio pre-pass was
    // never reached by a real Render: `prepareRenderedAudio` had its own suites
    // and the wiring between it and the button had none.
    const added = await agent<any>(session, "add_media", {
      items: [
        { path: instruments.paths.code, startMs: 0 },
        { path: instruments.paths.syncClick, startMs: 0 },
      ],
      sequential: false,
    });
    expect(added.skipped ?? []).toEqual([]);

    return page.evaluate(() => {
      const store = (window as any).CARTCUT.useTimelineStore;
      const entries = Object.entries<any>(store.getState().timeline);
      const video = entries.find(([, e]) => e.filetype === "video")!;
      const audio = entries.find(([, e]) => e.filetype === "audio")!;
      return {
        id: video[0],
        audioId: audio[0],
        trim: video[1].trim,
        duration: video[1].duration,
        audioTrim: audio[1].trim,
      };
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

  await test.step("put the same ramp on the click track", async () => {
    // The same curve on both, so a click and the flash it was generated with
    // stay together: if the picture and the sound are retimed by different maps
    // this is where it shows.
    await page.evaluate(
      ({ id, ramp }) => {
        const store = (window as any).CARTCUT.useTimelineStore;
        const setCurve = (window as any).CARTCUT.setClipSpeedCurve;
        store
          .getState()
          .withCheckpoint((d: any) => setCurve(d, id, ramp, { ripple: false }));
      },
      {
        id: source.audioId,
        ramp: rampOver(
          source.audioTrim.startTime,
          source.audioTrim.endTime,
          RAMP_SHAPE,
        ),
      },
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

  await test.step("the preview shows the frame the export delivered", async () => {
    // The question this whole spec exists under, asked of the two code paths
    // that actually differ. The export seeks through
    // `loadedAssetStore.seekScope`; the preview seeks through
    // `playback.ts#syncPlayback`, which is separate code and used to sample the
    // frame's start where the export samples its centre. On a ramp that is up
    // to two source frames, and `previewExportParity.test.ts` measured it at 86
    // percent of frames before the fix.
    //
    // So: park the handles the way the **preview** does, composite with the
    // same function the export uses, and read the burned-in index back out. If
    // the two agree here they agree on screen.
    const sampled = Array.from({ length: 40 }, (_, i) =>
      Math.floor((frames * i) / 40),
    );

    const seen = await page.evaluate(
      async ({ ordinals, fps: rate, region }) => {
        const C = (globalThis as any).CARTCUT;
        const store = C.loadedAssetStore.getState();
        const timeline = C.useTimelineStore.getState().timeline;

        const canvas = document.createElement("canvas");
        canvas.width = region.frameW;
        canvas.height = region.frameH;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

        const out: number[] = [];
        for (const n of ordinals) {
          const cursorMs = C.frameTimeMs(n, rate);

          // The preview's own positioning, and then a real wait for the
          // frames. `onSeeksLand` alone is not enough: it does not fire when
          // nothing needed seeking, and with more than one clip on the timeline
          // it can land before the *video* handle has its frame. Waiting on the
          // handles themselves is the fact the compositor actually depends on.
          await new Promise<void>((resolve) => {
            store.syncPlayback(timeline, cursorMs, false, rate, () => {});
            const deadline = Date.now() + 3000;
            const settled = () => {
              const videos = (store as any)._loadedElementVideo ?? {};
              for (const meta of Object.values<any>(videos)) {
                const v = meta.object;
                if (v.seeking === true || v.readyState < 2) {
                  return false;
                }
              }
              return true;
            };
            const tick = () => {
              if (settled() || Date.now() > deadline) {
                // One more frame, so the decoded picture is on the element and
                // not merely decoded.
                requestAnimationFrame(() => resolve());
                return;
              }
              setTimeout(tick, 16);
            };
            tick();
          });

          C.renderTimelineAtTime(
            ctx,
            timeline,
            cursorMs,
            C.exportElementRenderers,
            "#101820",
            region.frameW,
            region.frameH,
          );

          // The same patch centres `harness/decode.ts` samples.
          let value = 0;
          for (let k = 0; k < region.bits; k++) {
            const x = Math.round(region.x + (k + 0.5) * region.patch);
            const y = Math.round(region.y + region.h / 2);
            if (ctx.getImageData(x, y, 1, 1).data[0] > 128) {
              value |= 1 << k;
            }
          }
          out.push(value);
        }
        return out;
      },
      {
        ordinals: sampled,
        fps,
        region: { ...instruments.regions.code, frameW: width, frameH: height },
      },
    );

    const wanted = sampled.map((n) => decoded[n]);
    const offsets = seen.map((value, i) => value - wanted[i]);
    await testInfo.attach("preview-vs-export.json", {
      body: JSON.stringify({ sampled, seen, wanted, offsets }, null, 2),
      contentType: "application/json",
    });

    // Exact. These are the same seek now, and anything else means they have
    // been allowed to compute it separately again.
    expect(seen).toEqual(wanted);
  });

  await test.step("the click track really is ramped in the document", async () => {
    const audio = await page.evaluate((id) => {
      const e = (window as any).CARTCUT.useTimelineStore.getState().timeline[id];
      return {
        filetype: e.filetype,
        localpath: e.localpath,
        speed: e.speed,
        points: e.speedCurve?.length ?? 0,
        duration: e.duration,
        trim: e.trim,
        volumeDb: e.volumeDb,
        startTime: e.startTime,
      };
    }, source.audioId);
    await testInfo.attach("audio-clip.json", {
      body: JSON.stringify(audio, null, 2),
      contentType: "application/json",
    });
    expect(audio.points).toBe(RAMP_SHAPE.length);
    expect(audio.filetype).toBe("audio");
  });

  await test.step("the delivered audio follows the same ramp as the picture", async () => {
    // The end of the chain nothing else covers: the real Render button, the
    // real pre-pass, the real filter graph, and a click track whose clicks were
    // generated on the same grid as the flashes in the picture. A ramp that
    // reached the video and not the sound, or reached them by different maps,
    // shows here and nowhere else.
    const clicks = burstStartsMs(destination);

    // Where the ramp puts each source click. `SYNC_PERIOD_SEC` is 2.
    const curve = prepareCurve(RAMP);
    const wanted: number[] = [];
    for (let at = 0; at <= source.audioTrim.endTime; at += 2000) {
      const out = timelineMsAt(curve, source.audioTrim.startTime, at);
      if (out >= 0 && out <= durationSec * 1000) {
        wanted.push(out);
      }
    }

    await testInfo.attach("audio-clicks.json", {
      body: JSON.stringify({ clicks, wanted }, null, 2),
      contentType: "application/json",
    });

    expect(clicks.length).toBeGreaterThan(3);

    // **Every click the file carries is one the ramp asked for.** The tolerance
    // is one analysis window, which is the resolution a time-stretched edge
    // has. Measured: within 18ms across the whole ramp.
    for (const at of clicks) {
      const nearest = wanted.reduce(
        (best, want) => (Math.abs(want - at) < Math.abs(best - at) ? want : best),
        wanted[0],
      );
      expect(Math.abs(nearest - at)).toBeLessThan(80);
    }

    // **And the spacing is the ramp's, not the source's.** This is the
    // regression this step exists for. `startFFmpegProcess` took the pre-pass's
    // output and never passed it to `startExportSession`, so every ramped clip
    // exported at `atempo` of the ramp's *mean* rate: the clicks came out at a
    // flat 2.03s, the source's own 2s grid stretched by one constant, while the
    // picture ramped. Sound and picture drifted apart across the clip with
    // nothing anywhere reporting it.
    const gaps = clicks.slice(1).map((at, i) => at - clicks[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const spread = Math.max(...gaps) / Math.min(...gaps);
    await testInfo.attach("audio-gaps.json", {
      body: JSON.stringify({ gaps, mean, spread }, null, 2),
      contentType: "application/json",
    });
    // The ramp runs 0.25x to 4x, so the gaps have to vary by a large factor. A
    // constant rate makes this 1.0; it measured 1.01 with the defect and 6.2
    // without it.
    expect(spread).toBeGreaterThan(3);

    // Most of the clicks survive. Not all: one source frame of click becomes
    // about eight output milliseconds in the fast stretch, which is shorter
    // than the stretcher's own analysis window and below what `silencedetect`
    // can separate. The instrument is shared and is not going to be re-cut for
    // this; what matters is that nothing lands in the wrong place, which the
    // first assertion covers.
    const inside = wanted.filter((w) => w > 300 && w < durationSec * 1000 - 300);
    const hit = inside.filter((want) =>
      clicks.some((at) => Math.abs(at - want) < 80),
    );
    expect(hit.length / inside.length).toBeGreaterThan(0.7);
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
