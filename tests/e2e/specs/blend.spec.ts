/**
 * Blend modes, end to end, against arithmetic rather than against a reference
 * render.
 *
 * The point of asserting exact colours here is that a reference render would be
 * tautological: `harness/reference.ts` drives the same `renderTimelineAtTime`
 * the export does, so comparing the two proves the export path is consistent
 * and says nothing about whether `multiply` multiplies. So the scene is built
 * out of **solid-colour shapes** — no decoder, no codec on the way in — and
 * every expected colour is computed from the blend formula in this file.
 *
 * The scene is also deliberately short and self-sized. Every spec in this suite
 * runs under every profile, and `full` is already a five-minute export; this one
 * sets its own three-second duration so it costs the same everywhere.
 *
 * What it covers that the vitest suites cannot:
 *
 *  - the modes survive the whole pipeline — the real Render button, the raw
 *    frame pipe, FFmpeg, H.264, and the decode back;
 *  - the preview and the export composite blends identically, using the
 *    `mode: "preview"` leg of `renderReferenceFrames` that nothing else drives;
 *  - the field round-trips through the store and the agent surface as an
 *    ordinary clip property.
 */

import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import { test, expect } from "../harness/test";
import { agent, listClips } from "../harness/agent";
import { runExport, exportModalState } from "../harness/export";
import { decodeFrames, probeOutput } from "../harness/decode";
import {
  diffStats,
  judge,
  pixel,
  DETERMINISM_THRESHOLDS,
  type FrameBuffer,
} from "../harness/compare";
import { primeAssets, renderReferenceFrames } from "../harness/reference";
import { writePng, writeJson } from "../harness/artifacts";
import {
  setProjectFolder,
  setDuration,
  setResolution,
  setBackgroundColor,
  setFps,
  setExportPreset,
} from "../harness/ui";

const WIDTH = 640;
const HEIGHT = 360;
const DURATION_SEC = 3;

/** The backdrop every blended patch is judged against. */
const BACKDROP = { r: 0x80, g: 0x80, b: 0x80 };
/** The blended source. Saturated, so each channel lands on an exact byte. */
const SOURCE = { r: 0xff, g: 0x40, b: 0x00 };

const hex = (c: { r: number; g: number; b: number }) =>
  `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/**
 * The blend formulae, per channel, on 0-255 bytes.
 *
 * Restated here rather than imported: this file is the independent check. If it
 * shared `renderer/blend.ts`'s idea of what a mode means, a wrong mapping would
 * agree with itself and the test would pass.
 */
const FORMULA: Record<string, (s: number, b: number) => number> = {
  multiply: (s, b) => Math.round((s * b) / 255),
  screen: (s, b) => Math.round(255 - ((255 - s) * (255 - b)) / 255),
  darken: (s, b) => Math.min(s, b),
  lighten: (s, b) => Math.max(s, b),
  difference: (s, b) => Math.abs(s - b),
};

/**
 * The cases, one patch each, laid out left to right across the frame.
 *
 * Five separable modes with a closed form. The component modes (hue, colour,
 * luminosity) have no per-channel formula to restate independently, so they are
 * covered by pixel assertions in `renderer/blendComposite.test.ts` instead.
 */
const CASES = ["source-over", "multiply", "screen", "darken", "lighten", "difference"];

const PATCH_W = Math.floor(WIDTH / CASES.length);
const PATCH_Y = Math.floor(HEIGHT * 0.3);
const PATCH_H = Math.floor(HEIGHT * 0.4);

/** The centre of case `i`'s patch, in frame pixels. */
const probePoint = (i: number) => ({
  x: i * PATCH_W + Math.floor(PATCH_W / 2),
  y: PATCH_Y + Math.floor(PATCH_H / 2),
});

/** What case `i` must composite to. */
function expected(mode: string): { r: number; g: number; b: number } {
  if (mode === "source-over") {
    return SOURCE;
  }
  const f = FORMULA[mode];
  return {
    r: f(SOURCE.r, BACKDROP.r),
    g: f(SOURCE.g, BACKDROP.g),
    b: f(SOURCE.b, BACKDROP.b),
  };
}

/** H.264 4:2:0 moves a saturated edge around; the patches are large and flat. */
const CHANNEL_TOLERANCE = 12;

async function addShape(
  session: Parameters<typeof agent>[0],
  spec: {
    fillColor: string;
    x: number;
    y: number;
    width: number;
    height: number;
  },
): Promise<string> {
  const created = await agent<any>(session, "add_shape", {
    kind: "rectangle",
    startMs: 0,
    durationMs: DURATION_SEC * 1000,
    ...spec,
  });
  const id = created?.created?.[0];
  if (id == null) {
    throw new Error(`add_shape did not report an id: ${JSON.stringify(created).slice(0, 300)}`);
  }
  return id;
}

test("blend modes survive the export, and match the preview", async ({
  session,
  profile,
  artifactDir,
}, testInfo) => {
  test.setTimeout(10 * 60_000);

  const { page } = session;
  const fps = profile.fps;

  const projectDir = path.join(artifactDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const destination = path.join(artifactDir, "blend.mp4");

  await test.step("configure a short project through the settings panel", async () => {
    await setProjectFolder(session, projectDir);
    await setResolution(page, WIDTH, HEIGHT);
    await setDuration(page, DURATION_SEC);
    // Pure black, so a patch that failed to draw reads as obviously wrong
    // rather than as a near miss.
    await setBackgroundColor(page, "#000000");
    await setFps(page, fps);
    await setExportPreset(page, "low");
  });

  const sourceIds: string[] = [];

  await test.step("build the backdrop and one blended patch per mode", async () => {
    // One wide backdrop across the whole strip, on the lower track.
    await addShape(session, {
      fillColor: hex(BACKDROP),
      x: 0,
      y: PATCH_Y,
      width: WIDTH,
      height: PATCH_H,
    });

    // The sources go on a track of their own, in front of the backdrop.
    const track = await agent<any>(session, "add_track", { kind: "video" });
    const trackId = track?.tracks?.added?.[0] ?? track?.trackId ?? track?.id;
    expect(trackId, "add_track did not report a new track").toBeTruthy();

    for (const [i, mode] of CASES.entries()) {
      const id = await addShape(session, {
        fillColor: hex(SOURCE),
        x: i * PATCH_W,
        y: PATCH_Y,
        width: PATCH_W,
        height: PATCH_H,
      });
      await agent(session, "move_clips", { elementIds: [id], trackId, startMs: 0 });
      if (mode !== "source-over") {
        await agent(session, "set_blend_mode", { elementIds: [id], blend: mode });
      }
      sourceIds.push(id);
    }

    // The source track must be in front, or every patch is hidden behind the
    // backdrop and every assertion below would read the backdrop's grey.
    await agent(session, "move_track", { trackId, toIndex: 0 });
  });

  await test.step("the agent surface reports the modes back", async () => {
    const { clips } = await listClips(session);
    const byId = new Map(clips.map((c) => [c.id, c]));

    for (const [i, mode] of CASES.entries()) {
      const row = byId.get(sourceIds[i]);
      expect(row, `clip ${sourceIds[i]} missing from list_clips`).toBeTruthy();
      // `clipRow` reports the field only when it is not the default.
      expect((row as any).blend ?? "source-over").toBe(mode);
    }

    const detail = await agent<any>(session, "get_clip", {
      elementId: sourceIds[1],
    });
    expect(detail?.clip?.blend ?? detail?.blend).toBe("multiply");
  });

  await test.step("the modes reach timeline.json inside the real .ngt", async () => {
    // The one thing no node test can reach: whether the field actually rides
    // along into the archive the app writes. `blend` is a plain string on the
    // element, so it should come for free — and "comes for free" is exactly the
    // claim that stops being true the day someone adds a projection to the save
    // path.
    //
    // Only the write half is checked here, and deliberately so: `project.load`
    // refuses outright once the timeline has been edited in this session
    // ("Needs to restart"), so a reopen is not reachable from a spec that had to
    // build a timeline first. The read half is covered where it can be —
    // `renderer/blend.ts#blendOf` resolves whatever the archive holds, and
    // `blend.test.ts` drives it with every malformed value worth worrying about.
    const file = path.join(artifactDir, "blend.ngt");
    // The artifact directory is keyed by test name and survives between runs,
    // so a file left by the last one would satisfy the poll below instantly and
    // this step would assert against the previous run's ids.
    fs.rmSync(file, { force: true });

    await session.answerSaveDialog(file);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.save());
    await expect.poll(() => fs.existsSync(file), { timeout: 30_000 }).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const elements = JSON.parse(
      await zip.file("timeline.json")!.async("string"),
    );

    for (const [i, mode] of CASES.entries()) {
      const saved = elements[sourceIds[i]];
      expect(
        saved,
        `clip ${sourceIds[i]} missing from timeline.json; it holds ` +
          `${Object.keys(elements).join(", ")}`,
      ).toBeTruthy();
      expect(saved.blend ?? "source-over").toBe(mode);
    }

    // And the default is stored as an absent key rather than the string, so a
    // project saved before this feature and one saved after it are byte-equal
    // for a clip nobody has blended.
    expect("blend" in elements[sourceIds[0]]).toBe(false);
  });

  // ------------------------------------------------------ preview vs export

  await test.step("the preview composites blends the same way the export does", async () => {
    await primeAssets(page);
    const times = [0, 1000, 2000];

    const asExport = await renderReferenceFrames(page, times, "export");
    const asPreview = await renderReferenceFrames(page, times, "preview");

    expect(asExport).toHaveLength(times.length);
    expect(asPreview).toHaveLength(times.length);

    for (const [i, timeMs] of times.entries()) {
      // No encoder between them, so the bar is determinism, not codec noise.
      const stats = diffStats(asExport[i].frame, asPreview[i].frame, {
        x: 0,
        y: 0,
        w: WIDTH,
        h: HEIGHT,
      });
      const verdict = judge(stats, DETERMINISM_THRESHOLDS, `preview vs export @${timeMs}ms`);
      expect(verdict.failures.join("; ")).toBe("");
    }

    writePng(path.join(artifactDir, "preview-0ms.png"), asPreview[0].frame);
    writePng(path.join(artifactDir, "export-0ms.png"), asExport[0].frame);
  });

  // ------------------------------------------------------- the delivered file

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

  await test.step("the file is the shape the settings asked for", async () => {
    const probe = await probeOutput(destination);
    expect(probe.video.width).toBe(WIDTH);
    expect(probe.video.height).toBe(HEIGHT);
    expect(probe.video.rFrameRate).toBe(`${fps}/1`);
  });

  await test.step("every patch carries the colour the blend formula predicts", async () => {
    // A frame from the middle of the clip: past any first-frame settling, and
    // well inside the span every shape occupies.
    const frameIndex = Math.floor(fps * 1.5);
    const decoded = await decodeFrames(destination, [frameIndex], WIDTH, HEIGHT);
    expect(decoded.frames).toHaveLength(1);

    const frame: FrameBuffer = {
      data: decoded.frames[0],
      width: WIDTH,
      height: HEIGHT,
    };
    writePng(path.join(artifactDir, "decoded.png"), frame);

    const readings = CASES.map((mode, i) => {
      const point = probePoint(i);
      const got = pixel(frame, point.x, point.y);
      const want = expected(mode);
      return {
        mode,
        point,
        want,
        got: { r: got.r, g: got.g, b: got.b },
        delta: {
          r: Math.abs(got.r - want.r),
          g: Math.abs(got.g - want.g),
          b: Math.abs(got.b - want.b),
        },
      };
    });
    writeJson(path.join(artifactDir, "readings.json"), {
      backdrop: BACKDROP,
      source: SOURCE,
      tolerance: CHANNEL_TOLERANCE,
      readings,
    });

    for (const reading of readings) {
      const detail =
        `${reading.mode} at (${reading.point.x}, ${reading.point.y}): ` +
        `expected rgb(${reading.want.r}, ${reading.want.g}, ${reading.want.b}), ` +
        `got rgb(${reading.got.r}, ${reading.got.g}, ${reading.got.b})`;
      expect(reading.delta.r, detail).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
      expect(reading.delta.g, detail).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
      expect(reading.delta.b, detail).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
    }

    // The modes must actually differ from one another. Without this, a build in
    // which every blend was silently ignored would still pass whenever the
    // formulae happened to sit inside the tolerance of plain stacking.
    const distinct = new Set(
      readings.map((r) => `${r.got.r},${r.got.g},${r.got.b}`),
    );
    expect(
      distinct.size,
      `all six patches decoded to the same colour: ${[...distinct].join(" | ")}`,
    ).toBeGreaterThanOrEqual(4);
  });

  await test.step("the UI reported completion too", async () => {
    const modal = await exportModalState(page);
    expect(modal.errorVisible, modal.errorMessage).toBe(false);
  });
});
