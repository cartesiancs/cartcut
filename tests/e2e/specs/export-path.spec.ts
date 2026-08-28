/**
 * The narrowest end-to-end export that still goes through every real step.
 *
 * Two clips, five seconds, the actual Render button. It exists so that a
 * failure in the big stress run can be triaged: if this passes and that fails,
 * the export path works and the problem is load or content; if this fails, the
 * path itself is broken and nothing else in the suite means anything.
 */

import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../harness/test";
import { agent } from "../harness/agent";
import { runExport, exportModalState } from "../harness/export";
import { decodeIndexMap, probeOutput, countFrames } from "../harness/decode";
import {
  setProjectFolder,
  setDuration,
  setResolution,
  setBackgroundColor,
  setFpsThroughStore,
  setExportPreset,
} from "../harness/ui";

test("a short project exports through the real Render button", async ({
  session,
  fixtures,
  instruments,
  profile,
  artifactDir,
}, testInfo) => {
  test.setTimeout(10 * 60_000);

  const { page } = session;
  const durationSec = 5;
  const width = 640;
  const height = 360;
  const fps = 30;
  const frames = Math.round(durationSec * fps);

  const projectDir = path.join(artifactDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const destination = path.join(artifactDir, "out.mp4");

  await test.step("configure the project through the settings panel", async () => {
    await setProjectFolder(session, projectDir);
    await setResolution(page, width, height);
    await setDuration(page, durationSec);
    await setBackgroundColor(page, "#101820");
    // fps has no enabled control — see setFpsThroughStore.
    await setFpsThroughStore(page, fps);
    await setExportPreset(page, "low");
  });

  await test.step("place a video clip and the frame-index instrument", async () => {
    const clip = fixtures.video.find((v) => v.id === "v01-h264-1080p60")!;
    const added = await agent<any>(session, "add_media", {
      items: [
        { path: clip.path, startMs: 0, durationMs: durationSec * 1000 },
        { path: instruments.paths.code, startMs: 0, durationMs: durationSec * 1000 },
      ],
      sequential: false,
    });
    expect(added.skipped ?? []).toEqual([]);
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
  expect(fs.statSync(destination).size).toBeGreaterThan(1000);

  await test.step("the file matches what the export settings asked for", async () => {
    const probe = await probeOutput(destination);
    expect(probe.video.width).toBe(width);
    expect(probe.video.height).toBe(height);
    expect(probe.video.pixFmt).toBe("yuv420p");
    expect(probe.video.rFrameRate).toBe(`${fps}/1`);
    // Always exactly one audio stream: `buildFFmpegArgs` adds `anullsrc` when
    // no clip is audible, so "no audio in, no audio out" would be a bug.
    expect(probe.audio).not.toBeNull();

    expect(await countFrames(destination)).toBe(frames);
  });

  await test.step("every exported frame carries its own index", async () => {
    const map = await decodeIndexMap(destination, instruments.regions.code);
    await testInfo.attach("index-map.json", {
      body: JSON.stringify({ frames: map.frames, anomalies: map.anomalies, elapsedMs: map.elapsedMs }, null, 2),
      contentType: "application/json",
    });
    expect(map.frames).toBe(frames);

    // Honours the same flag as the stress spec: this file exists to answer
    // "does the export path work at all", and while the microsecond-seek defect
    // is open (FINDINGS.md #1) that question is worth being able to ask on its
    // own.
    const assertIndex =
      process.env.CARTCUT_E2E_ALLOW_KNOWN_SEEK_OFFSET === "1" ? expect.soft : expect;
    assertIndex(
      map.anomalies,
      `${map.anomalies.reduce((n, a) => n + (a.to - a.from + 1), 0)} of ${frames} frames ` +
      `carry the wrong source frame — see tests/e2e/FINDINGS.md #1`,
    ).toEqual([]);
  });

  await test.step("the UI reported completion too", async () => {
    const modal = await exportModalState(page);
    expect(modal.errorVisible, modal.errorMessage).toBe(false);
  });

  void profile;
});
