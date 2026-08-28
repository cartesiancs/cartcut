/**
 * The stress run.
 *
 * One test, because the app restarts between tests and a five-minute
 * twenty-clip project is not something to build three times. `test.step` gives
 * the phases their own timing and their own line in the report.
 *
 * Assertions are ordered so that the first failure is the *cause* rather than a
 * symptom, and the ones after it are skipped:
 *
 *   1. the export finished at all
 *   2. the container is the shape the settings asked for
 *   3. the colour round trip is honest      (else every fidelity number is noise)
 *   4. every frame carries its own index    (else every comparison is misaligned)
 *   5. sampled frames match the reference
 *   6. the preview shows what the export drew
 *   7. the audio is where the scenario put it
 */

import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../harness/test";
import { agent, timelineDocument, listClips } from "../harness/agent";
import { runExport, exportModalState } from "../harness/export";
import {
  countFrames,
  decodeFrames,
  decodeIndexMap,
  probeOutput,
  singleFrameCommand,
} from "../harness/decode";
import {
  CODEC_THRESHOLDS,
  MIN_ALIGNMENT_MARGIN,
  HEALTHY_ALIGNMENT_MARGIN,
  checkColorCanary,
  decodeFrameIndex,
  diffStats,
  downsample,
  findBestAlignment,
  inkBounds,
  judge,
  meanAbs,
  type FrameBuffer,
} from "../harness/compare";
import {
  primeAssets,
  renderReferenceFrames,
  capturePreviewCanvas,
  settlePreviewAt,
} from "../harness/reference";
import { crop, heatmap, sideBySide, writeJson, writePng, writeText } from "../harness/artifacts";
import { detectSilence, loudness, peakTimes, rmsEnvelope } from "../harness/audio";
import {
  setProjectFolder, setDuration, setResolution, setBackgroundColor,
  setFps, setExportPreset, clearSelection,
} from "../harness/ui";
import { buildKitchenSink } from "../scenario/kitchenSink";
import { chooseSampleFrames } from "../scenario/sampling";
import { frameCount, frameTimeMs } from "../harness/paths";

test("every editing element survives a full-length export, frame for frame", async ({
  session, profile, fixtures, instruments, artifactDir,
}, testInfo) => {
  // The profile's own Playwright timeout governs; this keeps the step budget
  // from being the thing that fails on a slow machine.
  test.setTimeout(testInfo.project.timeout);

  const { page } = session;
  const totalFrames = frameCount(profile);

  // Set to carry on past the known microsecond-seek defect so the checks after
  // it still get exercised. It downgrades those assertions to soft failures —
  // the run still ends red. See FINDINGS.md.
  const softKnownDefect = process.env.CARTCUT_E2E_ALLOW_KNOWN_SEEK_OFFSET === "1";
  const destination = path.join(artifactDir, `export.${profile.name}.mp4`);
  const projectDir = path.join(artifactDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const summary: Record<string, unknown> = {
    profile,
    totalFrames,
    destination,
    startedAt: new Date().toISOString(),
  };

  // ---------------------------------------------------------------- set up

  await test.step("configure the project through its own settings panel", async () => {
    await setProjectFolder(session, projectDir);
    await setResolution(page, profile.width, profile.height);
    await setDuration(page, profile.durationSec);
    await setBackgroundColor(page, "#000000");
    await setFps(page, profile.fps);
    await setExportPreset(page, "medium");

    const options = await page.evaluate(
      () => (globalThis as any).CARTCUT.renderOptionStore.getState().options,
    );
    expect(options.previewSize).toEqual({ w: profile.width, h: profile.height });
    expect(options.duration).toBe(profile.durationSec);
    expect(options.fps).toBe(profile.fps);
  });

  const scenario = await test.step("build the kitchen-sink timeline", async () => {
    const built = await buildKitchenSink({ session, profile, fixtures, instruments });
    writeJson(path.join(artifactDir, "scenario.json"), built);
    await testInfo.attach("scenario-steps.txt", {
      body: built.steps.join("\n"),
      contentType: "text/plain",
    });
    return built;
  });

  await test.step("the timeline holds every element type the app supports", async () => {
    const doc = await timelineDocument(session);
    const byType = new Map<string, number>();
    for (const element of Object.values(doc)) {
      byType.set(element.filetype, (byType.get(element.filetype) ?? 0) + 1);
    }
    summary.elementCounts = Object.fromEntries(byType);
    writeJson(path.join(artifactDir, "document.json"), doc);

    // The nine filetypes in `@types/timeline.ts`. `group`, `effect` and
    // `transition` are the ones a naive scenario silently omits.
    for (const filetype of ["video", "image", "gif", "shape", "text", "audio", "group", "effect", "transition"]) {
      expect(byType.get(filetype) ?? 0, `no "${filetype}" element was placed`).toBeGreaterThan(0);
    }

    const videos = [...byType.entries()].find(([k]) => k === "video")?.[1] ?? 0;
    expect(videos, "the brief asks for 10+ video samples").toBeGreaterThanOrEqual(10);

    const { clips } = await listClips(session, { filetype: "audio" });
    const audioTracks = new Set(clips.map((c) => c.trackId));
    expect(audioTracks.size, "the brief asks for 5 audio tracks").toBeGreaterThanOrEqual(5);
  });

  await test.step("save the project so a failure can be reproduced without rebuilding", async () => {
    const ngt = path.join(artifactDir, "project.ngt");
    await page.evaluate(
      (dest) => (globalThis as any).CARTCUT.project.saveProjectFile({ projectDestination: dest }),
      ngt,
    );

    // `saveProjectFile` returns before it has written anything: it kicks off
    // `zip.generateAsync(...).then(...)` and does not return that promise, so
    // awaiting the call awaits nothing. Poll for the file instead.
    await expect.poll(() => fs.existsSync(ngt), { timeout: 30_000, intervals: [250] }).toBe(true);
    summary.projectFile = { path: ngt, bytes: fs.statSync(ngt).size };
  });

  // ---------------------------------------------------------------- export

  const outcome = await test.step(`render ${totalFrames} frames through the Render button`, async () => {
    let lastLogged = -10;
    const result = await runExport(session, {
      destination,
      // Four fifths of the test's own budget, leaving the rest for decoding
      // and comparison. Subtracting a flat ten minutes underflows to zero on
      // the smoke profile, whose whole budget is ten.
      timeoutMs: Math.max(2 * 60_000, Math.floor(testInfo.project.timeout * 0.8)),
      onProgress: (percent) => {
        if (percent - lastLogged >= 10) {
          lastLogged = percent;
          process.stdout.write(`      export ${percent}%\n`);
        }
      },
    });
    summary.export = {
      status: result.status,
      elapsedMs: result.elapsedMs,
      error: result.error,
    };
    writeJson(path.join(artifactDir, "export-outcome.json"), result);
    if (result.error?.stderrTail) {
      writeText(path.join(artifactDir, "ffmpeg.stderr.tail.txt"), result.error.stderrTail);
    }
    return result;
  });

  expect(
    outcome.status,
    `export ${outcome.status}: ${outcome.error?.message ?? ""}\n${outcome.error?.stderrTail ?? ""}`,
  ).toBe("finished");
  expect(fs.existsSync(destination)).toBe(true);

  await test.step("the UI agreed it finished", async () => {
    const modal = await exportModalState(page);
    expect(modal.errorVisible, modal.errorMessage).toBe(false);
  });

  // --------------------------------------------------------- 2. container

  const probe = await test.step("the file is the shape the export settings asked for", async () => {
    const result = await probeOutput(destination);
    const frames = await countFrames(destination);
    summary.probe = { ...result, decodedFrames: frames };
    writeJson(path.join(artifactDir, "ffprobe.json"), summary.probe);

    expect(result.video.width).toBe(profile.width);
    expect(result.video.height).toBe(profile.height);
    expect(result.video.pixFmt).toBe("yuv420p");
    expect(result.video.rFrameRate).toBe(`${profile.fps}/1`);
    // Any variation here means a frame was dropped or duplicated by the muxer.
    expect(result.video.avgFrameRate).toBe(`${profile.fps}/1`);
    expect(result.video.startTimeSec ?? 0).toBeCloseTo(0, 3);

    // `frameCount` reads `options.duration` while `buildFFmpegArgs` puts
    // `options.videoDuration` into the output `-t`. They come from the same
    // value today and nothing enforces that; a divergence truncates the tail of
    // every export silently.
    expect(frames, `expected round(${profile.durationSec} * ${profile.fps}) frames`).toBe(totalFrames);

    // Always exactly one audio stream: `anullsrc` covers the no-audible-clip
    // case, so a missing stream is a bug rather than a consequence.
    expect(result.audio).not.toBeNull();
    expect(result.audio!.channels).toBe(2);
    expect(Math.abs(result.formatDurationSec - profile.durationSec)).toBeLessThanOrEqual(0.04);

    return result;
  });

  // ------------------------------------------------- 3 & 4. the instruments

  const sample = chooseSampleFrames({ profile, scenario, totalFrames });
  writeJson(path.join(artifactDir, "sample-anchors.json"), sample);
  summary.sampledFrames = sample.frames.length;

  const window = 3;
  const wanted = new Set<number>();
  for (const frame of sample.frames) {
    for (let d = -window; d <= window; d++) {
      const candidate = frame.index + d;
      if (candidate >= 0 && candidate < totalFrames) wanted.add(candidate);
    }
  }

  const decoded = await test.step("decode the sampled frames and their alignment windows", async () => {
    const result = await decodeFrames(destination, [...wanted], profile.width, profile.height);
    return new Map(result.indices.map((index, i) => [index, { data: result.frames[i], width: profile.width, height: profile.height } as FrameBuffer]));
  });

  await test.step("the instruments are actually visible in the export", async () => {
    // An instrument that is covered fails *silently*: the band reads a constant
    // colour, every candidate scores the same, and the alignment search reports
    // "no winner" rather than "I could not see anything". That happened — all
    // four instruments were put on one track, they fought for the same span,
    // and the ticker ended up beneath a video clip. So the instruments are
    // checked before anything is concluded from them.
    const probeFrames = sample.frames.slice(0, 4).map((f) => f.index);
    const withNeighbour = probeFrames.flatMap((n) => [n, n + 1]).filter((n) => n < totalFrames);
    const band = await decodeFrames(
      destination, withNeighbour, profile.width, profile.height, instruments.regions.ticker,
    );
    const byIndex = new Map(band.indices.map((n, i) => [n, band.frames[i]]));

    const region = { x: 0, y: 0, w: instruments.regions.ticker.w, h: instruments.regions.ticker.h };
    const movement: number[] = [];
    for (const n of probeFrames) {
      const a = byIndex.get(n);
      const b = byIndex.get(n + 1);
      if (a == null || b == null) continue;
      movement.push(
        diffStats(
          { data: a, width: region.w, height: region.h },
          { data: b, width: region.w, height: region.h },
          region,
        ).mean,
      );
    }
    summary.tickerMovement = movement;

    // The ticker scrolls 32px per frame over a high-frequency pattern; adjacent
    // frames measured ~107 apart in isolation. Anything near zero means the
    // band is not on screen.
    expect(
      Math.max(...movement, 0),
      `the ticker band does not change between adjacent frames (${movement.map((m) => m.toFixed(2)).join(", ")}). ` +
      `It is being composited over, so the alignment search is measuring nothing.`,
    ).toBeGreaterThan(5);
  });

  await test.step("the colour round trip is honest", async () => {
    const first = decoded.get(sample.frames[0].index)!;
    const canary = checkColorCanary(first, instruments.regions.swatch);
    summary.colorCanary = canary;
    writeJson(path.join(artifactDir, "color-canary.json"), canary);

    // When this fails it fails *instead of* the fidelity thresholds: a wrong
    // matrix moves every pixel, and five red assertions for one root cause
    // buries the cause.
    expect(canary.pass, canary.verdict).toBe(true);
  });

  await test.step("every one of the exported frames carries its own index", async () => {
    const map = await decodeIndexMap(destination, instruments.regions.code);
    const indexSummary = {
      frames: map.frames,
      anomalyRuns: map.anomalies.length,
      wrongFrames: map.anomalies.reduce((n, a) => n + (a.to - a.from + 1), 0),
      offsetsSeen: [...new Set(map.anomalies.map((a) => a.offset))],
      elapsedMs: map.elapsedMs,
    };
    summary.indexMap = indexSummary;
    writeJson(path.join(artifactDir, "index-map.json"), {
      ...indexSummary,
      anomalies: map.anomalies.slice(0, 500),
    });

    expect(map.frames).toBe(totalFrames);

    const wrong = indexSummary.wrongFrames;

    // This assertion currently fails against the shipping app — see FINDINGS.md
    // and `seek-diagnosis.spec.ts`. It is left as a hard failure because it is
    // measuring a real defect, but a run can be told to carry on so the checks
    // after it still get exercised while the bug is open:
    //
    //     CARTCUT_E2E_ALLOW_KNOWN_SEEK_OFFSET=1 npm run test:e2e:smoke
    //
    // The flag downgrades it to a soft failure — the run still ends red, and
    // the number still has to not get worse — rather than hiding it.
    const assertAnomalies = softKnownDefect ? expect.soft : expect;

    if (softKnownDefect) {
      testInfo.annotations.push({
        type: "known-defect",
        description:
          `${wrong}/${totalFrames} frames carry the previous source frame ` +
          `(${((wrong / totalFrames) * 100).toFixed(1)}%) — the microsecond seek truncation, see FINDINGS.md`,
      });
    }

    assertAnomalies(
      map.anomalies,
      `${wrong} of ${totalFrames} exported frames carry the wrong source frame ` +
      `(offsets ${[...new Set(map.anomalies.map((a) => a.offset))].join(", ")}).\n` +
      `\n` +
      `Known mechanism: the frame loop asks for exactly the frame boundary\n` +
      `  frameTimeMs(N, fps) / 1000  ->  video.currentTime\n` +
      `and Chromium truncates that assignment to whole microseconds. Whenever\n` +
      `1e6/fps is not an integer, the truncated value lands one microsecond\n` +
      `*below* the frame's presentation timestamp and the decoder correctly\n` +
      `returns the previous frame. It affects 24, 30 and 60 fps (1 frame in 3)\n` +
      `and not 25 or 50, where 1e6/fps is exact.\n` +
      `See tests/e2e/specs/seek-diagnosis.spec.ts and FINDINGS.md.`,
    ).toEqual([]);
  });

  // ------------------------------------------------ 5. reference vs decoded

  await test.step("sampled frames match a reference render of the same moment", async () => {
    const primed = await primeAssets(page);
    summary.primedVideos = primed;

    // A reference frame rendered without one of its clips does not look
    // broken — it looks like the export drew something extra. Refuse to
    // compare anything until every clip the timeline references is decoded.
    expect(
      primed.videos,
      `only ${primed.videos} of ${primed.expected} video clips decoded, so a reference ` +
      `render would be missing content the export has`,
    ).toBe(primed.expected);

    const failures: string[] = [];
    const weakMargins: string[] = [];
    const rows: unknown[] = [];

    // Small batches: each reference frame crosses the Playwright bridge as
    // base64, and at 1080p that is ~11 MB per frame encoded.
    const BATCH = 4;
    for (let i = 0; i < sample.frames.length; i += BATCH) {
      const batch = sample.frames.slice(i, i + BATCH);
      const references = await renderReferenceFrames(
        page,
        batch.map((s) => frameTimeMs(s.index, profile.fps)),
        "export",
      );

      for (let k = 0; k < batch.length; k++) {
        const anchor = batch[k];
        const reference = references[k];
        const target = decoded.get(anchor.index);
        if (target == null) continue;

        const content = instruments.regions.content;
        const stats = diffStats(reference.frame, target, content);
        const verdict = judge(stats, CODEC_THRESHOLDS, `frame ${anchor.index}`);

        const candidates = [];
        for (let d = -window; d <= window; d++) {
          const frame = decoded.get(anchor.index + d);
          if (frame != null) candidates.push({ index: anchor.index + d, frame });
        }
        const alignment = findBestAlignment(reference.frame, candidates, instruments.regions.ticker);
        const burned = decodeFrameIndex(target, instruments.regions.code);

        const row = {
          index: anchor.index,
          anchor: anchor.label,
          timeMs: frameTimeMs(anchor.index, profile.fps),
          stats,
          alignment: {
            bestIndex: alignment.bestIndex,
            margin: Number.isFinite(alignment.margin) ? Number(alignment.margin.toFixed(1)) : "inf",
            table: alignment.table.map((t) => ({ index: t.index, mae: Number(t.mae.toFixed(3)) })),
          },
          burnedIndex: burned.value,
          reproduce: singleFrameCommand(destination, anchor.index, profile.fps).join(" "),
        };
        rows.push(row);

        if (!verdict.pass) failures.push(`${anchor.label}: ${verdict.failures.join("; ")}`);
        if (burned.value !== anchor.index) {
          failures.push(`${anchor.label}: frame carries index ${burned.value}, expected ${anchor.index}`);
        }
        if (alignment.bestIndex !== anchor.index) {
          failures.push(
            `${anchor.label}: best ticker match is decoded frame ${alignment.bestIndex}, not ${anchor.index}`,
          );
        } else if (alignment.margin < MIN_ALIGNMENT_MARGIN) {
          failures.push(
            `${anchor.label}: alignment margin ${alignment.margin.toFixed(2)}x — the ticker found no winner at all, ` +
            `so the instrument is not measuring anything here`,
          );
        } else if (alignment.margin < HEALTHY_ALIGNMENT_MARGIN) {
          // Recorded, not failed. See MIN_ALIGNMENT_MARGIN for why.
          weakMargins.push(`${anchor.label}: ${alignment.margin.toFixed(1)}x`);
        }

        if (!verdict.pass || burned.value !== anchor.index || alignment.bestIndex !== anchor.index) {
          const dir = path.join(artifactDir, "frames", String(anchor.index));
          const region = instruments.regions.content;
          const a = crop(reference.frame, region);
          const b = crop(target, region);
          writePng(path.join(dir, "reference.png"), a);
          writePng(path.join(dir, "decoded.png"), b);
          writePng(path.join(dir, "sidebyside.png"), sideBySide(a, b, heatmap(a, b)));
          writeJson(path.join(dir, "stats.json"), row);
        }
      }
    }

    writeJson(path.join(artifactDir, "frame-parity.json"), rows);
    summary.weakAlignmentMargins = weakMargins.length;
    if (weakMargins.length > 0) {
      await testInfo.attach("weak-alignment-margins.txt", {
        body:
          `${weakMargins.length} sampled frames separated by less than ${HEALTHY_ALIGNMENT_MARGIN}x.\n` +
          `Expected while the export duplicates frames — neighbouring outputs really are similar.\n\n` +
          weakMargins.join("\n"),
        contentType: "text/plain",
      });
    }
    // Distinct frames, not distinct complaints: one bad frame can trip the
    // fidelity thresholds, the burned index and the alignment search at once,
    // and "120 of 94 frames disagreed" reads as a bug in the counter.
    const badFrames = new Set(failures.map((f) => f.split(":")[0]));
    summary.frameParityFailures = { frames: badFrames.size, complaints: failures.length };
    const assertParity = softKnownDefect ? expect.soft : expect;
    assertParity(
      failures.join("\n"),
      `${badFrames.size} of ${sample.frames.length} sampled frames disagreed ` +
      `(${failures.length} findings)`,
    ).toBe("");
  });

  // ---------------------------------------------- 6. the preview's own claim

  await test.step("the preview shows what the export drew", async () => {
    // The weakest leg in the suite, and deliberately so.
    //
    // `previewCanvas.ts` renders the scene into an offscreen at *device* size
    // with the viewport's pan and zoom baked in, then composites a dimmed
    // full-plane pass, a clipped in-frame pass, the frame guide and any
    // selection chrome over it. What is on screen is therefore the scene
    // resampled at an arbitrary zoom over a dimmed copy of itself — there is no
    // region of it that is pixel-comparable to a reference render without first
    // inverting that transform.
    //
    // So this asserts the one thing that survives: presence. The preview must
    // not be blank while the export has content, or the reverse. That is the
    // shape of the bug this leg exists for — `renderVideoWithoutWait` lets the
    // preview draw whatever frame the `<video>` happens to hold, which is
    // invisible to every other comparison here. The finer numbers are recorded
    // for eyeballing, not thresholded.
    const checks = sample.frames.slice(0, 8);
    const problems: string[] = [];
    const rows: unknown[] = [];

    for (const anchor of checks) {
      const timeMs = frameTimeMs(anchor.index, profile.fps);
      await settlePreviewAt(page, timeMs);
      const shown = await capturePreviewCanvas(page);
      if (shown == null) continue;

      const [reference] = await renderReferenceFrames(page, [timeMs], "export");

      const wholeReference = { x: 0, y: 0, w: reference.frame.width, h: reference.frame.height };
      const wholePreview = { x: 0, y: 0, w: shown.width, h: shown.height };

      const refInk = inkBounds(reference.frame, wholeReference);
      const showInk = inkBounds(shown, wholePreview);

      // Coarse enough that resampling and letterboxing wash out, fine enough
      // that a missing element still moves it.
      const delta = meanAbs(
        downsample(reference.frame, wholeReference, 32, 18),
        downsample(shown, wholePreview, 32, 18),
      );

      rows.push({
        index: anchor.index,
        anchor: anchor.label,
        referenceInk: refInk.count,
        previewInk: showInk.count,
        previewSize: [shown.width, shown.height],
        downsampledMeanAbs: Number(delta.toFixed(2)),
      });

      const referenceHasContent = refInk.count > 0;
      const previewHasContent = showInk.count > 0;
      if (referenceHasContent !== previewHasContent) {
        problems.push(
          `${anchor.label}: preview and export disagree about whether anything is on screen ` +
          `(reference ink ${refInk.count}, preview ink ${showInk.count})`,
        );
      }
    }

    writeJson(path.join(artifactDir, "preview-parity.json"), rows);
    summary.previewParity = rows;
    expect(problems.join("\n")).toBe("");
  });

  // --------------------------------------------------------------- 7. audio

  await test.step("the audio is where the scenario put it", async () => {
    const [silence, envelope, loud] = await Promise.all([
      detectSilence(destination),
      rmsEnvelope(destination),
      loudness(destination),
    ]);

    summary.audio = {
      silenceWindows: silence.length,
      envelopeBuckets: envelope.length,
      ...loud,
    };
    writeJson(path.join(artifactDir, "audio.json"), { silence, loudness: loud, envelope: envelope.slice(0, 4000) });

    expect(envelope.length, "no RMS envelope came back — the audio stream is empty").toBeGreaterThan(0);

    const audible = envelope.filter((b) => Number.isFinite(b.db) && b.db > -45);
    expect(
      audible.length / envelope.length,
      "almost the whole export is silent, but the scenario placed five overlapping audio clips",
    ).toBeGreaterThan(0.3);

    // The sync clicks were generated on the same frame numbers as the flashes,
    // in the same function, so their peaks should land on the 2-second grid.
    const peaks = peakTimes(envelope, -30);
    const nearGrid = peaks.filter((t) => Math.abs(t - Math.round(t / 2) * 2) <= 0.12);
    summary.audioSyncPeaks = { total: peaks.length, onGrid: nearGrid.length };
    expect(peaks.length, "no audible peaks at all").toBeGreaterThan(0);
  });

  writeJson(path.join(artifactDir, "summary.json"), summary);
  await testInfo.attach("summary.json", {
    body: JSON.stringify(summary, null, 2),
    contentType: "application/json",
  });
  await clearSelection(page);
});
