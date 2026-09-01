/**
 * Masks, end to end, against geometry rather than against a reference render.
 *
 * The point of asserting from geometry is that a reference render would be
 * tautological: `harness/reference.ts` drives the same `renderTimelineAtTime`
 * the export does, so comparing the two proves the export path is consistent
 * and says nothing about whether the mask cut anything. So the scene is built
 * out of **solid-colour shapes** — no decoder, no codec on the way in — and
 * every expected colour comes from asking, independently, whether a probe point
 * is inside the mask's rectangle or outside it.
 *
 * The scene is short and sizes itself, for the reason `blend.spec.ts` gives:
 * every spec here runs under every profile, and `full` is already a five-minute
 * export.
 *
 * What it covers that the vitest suites cannot:
 *
 *  - the cut survives the whole pipeline — the real Render button, the raw
 *    frame pipe, FFmpeg, H.264, and the decode back;
 *  - the preview and the export cut identically, using the `mode: "preview"`
 *    leg of `renderReferenceFrames` that nothing else drives — and this is the
 *    one case where that matters more than it does for blend, because the mask
 *    stencil is filled under a device-space transform that differs between the
 *    two (the preview carries zoom and DPR, the export is 1:1);
 *  - a **keyframed** mask moves over time in the delivered file, which is the
 *    whole feature and which no single-frame check can show;
 *  - the field round-trips through the store, the agent surface and the
 *    real `.ngt`, and an unmasked clip still saves without the key.
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

/** The clip's fill. Saturated, so each channel lands on an exact byte. */
const FILL = { r: 0xff, g: 0x40, b: 0x00 };
/** Pure black, so a pixel the mask removed is unmistakable. */
const BACKGROUND = { r: 0, g: 0, b: 0 };

const hex = (c: { r: number; g: number; b: number }) =>
  `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** One full-frame shape, so mask coordinates and frame coordinates coincide. */
const CLIP = { x: 0, y: 0, width: WIDTH, height: HEIGHT };

/**
 * The static mask: the middle half of the clip, horizontally.
 *
 * Expressed here as **frame pixels**, and converted to the percentages the tool
 * takes at the call site. That is the independent half: this file works out
 * where the edge should be from the geometry, and `set_mask` is told the same
 * thing in its own units. A percentage-to-pixel bug would show up as a
 * disagreement between the two rather than cancelling out.
 */
const MASK_LEFT = WIDTH * 0.25;
const MASK_RIGHT = WIDTH * 0.75;

/** H.264 4:2:0 moves a saturated edge around; probes stay well clear of one. */
const CHANNEL_TOLERANCE = 12;
/** How far from the mask edge a probe has to sit to be safe from chroma bleed. */
const EDGE_MARGIN = 24;

const midY = Math.floor(HEIGHT / 2);

/** Probes across the frame, with what geometry says each must be. */
const STATIC_PROBES = [
  { name: "left of the mask", x: Math.floor(MASK_LEFT - EDGE_MARGIN), want: BACKGROUND },
  { name: "inside, near the left edge", x: Math.floor(MASK_LEFT + EDGE_MARGIN), want: FILL },
  { name: "the middle", x: Math.floor(WIDTH / 2), want: FILL },
  { name: "inside, near the right edge", x: Math.floor(MASK_RIGHT - EDGE_MARGIN), want: FILL },
  { name: "right of the mask", x: Math.floor(MASK_RIGHT + EDGE_MARGIN), want: BACKGROUND },
];

async function addShape(
  session: Parameters<typeof agent>[0],
  spec: { fillColor: string; x: number; y: number; width: number; height: number },
): Promise<string> {
  const created = await agent<any>(session, "add_shape", {
    kind: "rectangle",
    startMs: 0,
    durationMs: DURATION_SEC * 1000,
    ...spec,
  });
  const id = created?.created?.[0];
  if (id == null) {
    throw new Error(
      `add_shape did not report an id: ${JSON.stringify(created).slice(0, 300)}`,
    );
  }
  return id;
}

test("a mask survives the export, matches the preview, and animates", async ({
  session,
  profile,
  artifactDir,
}, testInfo) => {
  test.setTimeout(10 * 60_000);

  const { page } = session;
  const fps = profile.fps;

  const projectDir = path.join(artifactDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const destination = path.join(artifactDir, "mask.mp4");

  await test.step("configure a short project through the settings panel", async () => {
    await setProjectFolder(session, projectDir);
    await setResolution(page, WIDTH, HEIGHT);
    await setDuration(page, DURATION_SEC);
    await setBackgroundColor(page, hex(BACKGROUND));
    await setFps(page, fps);
    await setExportPreset(page, "low");
  });

  let maskedId = "";
  let plainId = "";

  await test.step("build one masked clip and one left alone", async () => {
    // The unmasked one is on the lower track and out of every probe's way; it
    // exists so the save assertion has something to compare against.
    plainId = await addShape(session, {
      fillColor: hex(FILL),
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });

    const track = await agent<any>(session, "add_track", { kind: "video" });
    const trackId = track?.tracks?.added?.[0] ?? track?.trackId ?? track?.id;
    expect(trackId, "add_track did not report a new track").toBeTruthy();

    maskedId = await addShape(session, { fillColor: hex(FILL), ...CLIP });
    await agent(session, "move_clips", {
      elementIds: [maskedId],
      trackId,
      startMs: 0,
    });
    await agent(session, "move_track", { trackId, toIndex: 0 });

    await agent(session, "set_mask", {
      elementIds: [maskedId],
      shape: "rectangle",
      x: 50,
      y: 50,
      // The middle half, in the percentages the tool takes.
      width: ((MASK_RIGHT - MASK_LEFT) / CLIP.width) * 100,
      height: 100,
      feather: 0,
      roundness: 0,
    });
  });

  await test.step("the agent surface reports the mask back", async () => {
    const { clips } = await listClips(session);
    const byId = new Map(clips.map((c) => [c.id, c]));
    expect((byId.get(maskedId) as any)?.mask).toBe("rectangle");
    // Reported only when set, so a clip nobody masked stays out of the list's way.
    expect((byId.get(plainId) as any)?.mask).toBeUndefined();

    const detail = await agent<any>(session, "get_clip", { elementId: maskedId });
    const mask = detail?.clip?.mask ?? detail?.mask;
    expect(mask?.shape).toBe("rectangle");
    expect(mask?.width).toBeCloseTo(
      ((MASK_RIGHT - MASK_LEFT) / CLIP.width) * 100,
      3,
    );
    // The drawn path is never shipped — see `serialize.ts`.
    expect(JSON.stringify(detail)).not.toContain('"path"');
  });

  await test.step("the mask reaches timeline.json inside the real .ngt", async () => {
    // The one thing no node test can reach: whether the field actually rides
    // along into the archive the app writes. Only the write half — `project.load`
    // refuses once the timeline has been edited in this session, the same limit
    // `blend.spec.ts` documents.
    const file = path.join(artifactDir, "mask.ngt");
    fs.rmSync(file, { force: true });

    await session.answerSaveDialog(file);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.save());
    await expect.poll(() => fs.existsSync(file), { timeout: 30_000 }).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const elements = JSON.parse(await zip.file("timeline.json")!.async("string"));

    expect(elements[maskedId]?.mask?.shape).toBe("rectangle");
    // Absent, not `null` — so a project nobody has masked is byte-identical to
    // one written before the feature, which is why SCHEMA_VERSION did not move.
    expect("mask" in elements[plainId]).toBe(false);
    // And the five keyframe tracks exist only on the clip that has a mask.
    expect("maskPosition" in elements[maskedId].animation).toBe(true);
    expect("maskPosition" in elements[plainId].animation).toBe(false);

    const project = JSON.parse(await zip.file("project.json")!.async("string"));
    expect(project.schemaVersion).toBe(2);
  });

  // ------------------------------------------------------ preview vs export

  await test.step("the preview cuts the mask the same way the export does", async () => {
    // Worth more here than for blend: the stencil is filled in device pixels,
    // and the two legs carry different device transforms — the preview's zoom
    // and DPR against the export's 1:1. A mask built from the wrong matrix is
    // exact in every node suite and wrong in the app, and this is the check
    // that would catch it.
    await primeAssets(page);
    const times = [0, 1000, 2000];

    const asExport = await renderReferenceFrames(page, times, "export");
    const asPreview = await renderReferenceFrames(page, times, "preview");

    for (const [i, timeMs] of times.entries()) {
      const stats = diffStats(asExport[i].frame, asPreview[i].frame, {
        x: 0,
        y: 0,
        w: WIDTH,
        h: HEIGHT,
      });
      const verdict = judge(
        stats,
        DETERMINISM_THRESHOLDS,
        `preview vs export @${timeMs}ms`,
      );
      expect(verdict.failures.join("; ")).toBe("");
    }

    writePng(path.join(artifactDir, "preview-0ms.png"), asPreview[0].frame);
    writePng(path.join(artifactDir, "export-0ms.png"), asExport[0].frame);
  });

  // --------------------------------------------------- animate, then deliver

  await test.step("keyframe the mask so it slides across the clip", async () => {
    // Still at 50% for the first second, then travelling to 90% by the end.
    // The static probes above are read from the first second; the animation is
    // judged from a frame near the end, where the mask has visibly moved.
    await agent(session, "add_keyframes", {
      elementId: maskedId,
      property: "maskPosition",
      keyframes: [
        { atMs: 0, x: 50, y: 50 },
        { atMs: 1000, x: 50, y: 50 },
        { atMs: (DURATION_SEC - 0.2) * 1000, x: 90, y: 50 },
      ],
    });

    const curve = await agent<any>(session, "get_keyframes", {
      elementId: maskedId,
      property: "maskPosition",
    });
    expect(JSON.stringify(curve)).toContain("maskPosition");
  });

  const outcome = await test.step("click Render and wait for FFmpeg", async () => {
    const result = await runExport(session, {
      destination,
      timeoutMs: 8 * 60_000,
    });
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

  await test.step("the delivered frames are cut where the geometry says", async () => {
    // Half a second in: past any first-frame settling, and inside the stretch
    // where the mask is still where it started.
    const stillIndex = Math.floor(fps * 0.5);
    // Near the end, where the keyframes have carried the mask to the right.
    const movedIndex = Math.floor(fps * (DURATION_SEC - 0.25));

    const decoded = await decodeFrames(
      destination,
      [stillIndex, movedIndex],
      WIDTH,
      HEIGHT,
    );
    expect(decoded.frames).toHaveLength(2);

    const still: FrameBuffer = {
      data: decoded.frames[0],
      width: WIDTH,
      height: HEIGHT,
    };
    const moved: FrameBuffer = {
      data: decoded.frames[1],
      width: WIDTH,
      height: HEIGHT,
    };
    writePng(path.join(artifactDir, "decoded-still.png"), still);
    writePng(path.join(artifactDir, "decoded-moved.png"), moved);

    const readings = STATIC_PROBES.map((probe) => {
      const got = pixel(still, probe.x, midY);
      return {
        name: probe.name,
        x: probe.x,
        want: probe.want,
        got: { r: got.r, g: got.g, b: got.b },
      };
    });
    writeJson(path.join(artifactDir, "readings.json"), {
      fill: FILL,
      background: BACKGROUND,
      maskLeft: MASK_LEFT,
      maskRight: MASK_RIGHT,
      tolerance: CHANNEL_TOLERANCE,
      readings,
    });

    for (const reading of readings) {
      const detail =
        `${reading.name} at x=${reading.x}: expected ` +
        `rgb(${reading.want.r}, ${reading.want.g}, ${reading.want.b}), got ` +
        `rgb(${reading.got.r}, ${reading.got.g}, ${reading.got.b})`;
      expect(Math.abs(reading.got.r - reading.want.r), detail).toBeLessThanOrEqual(
        CHANNEL_TOLERANCE,
      );
      expect(Math.abs(reading.got.g - reading.want.g), detail).toBeLessThanOrEqual(
        CHANNEL_TOLERANCE,
      );
      expect(Math.abs(reading.got.b - reading.want.b), detail).toBeLessThanOrEqual(
        CHANNEL_TOLERANCE,
      );
    }

    // The mask must actually be doing something. Without this, a build in which
    // masks were silently ignored would fail only on the two background probes,
    // and a build that hid the clip entirely would fail only on the three fill
    // probes — this says the frame contains both, which neither can fake.
    const insideStill = pixel(still, Math.floor(WIDTH / 2), midY);
    const outsideStill = pixel(still, Math.floor(MASK_LEFT - EDGE_MARGIN), midY);
    expect(insideStill.r).toBeGreaterThan(outsideStill.r + 100);

    // And the animation moved it: a point that was outside the mask at 0.5s is
    // inside it near the end, because the mask has slid right.
    const probeX = Math.floor(MASK_RIGHT + EDGE_MARGIN);
    const before = pixel(still, probeX, midY);
    const after = pixel(moved, probeX, midY);
    expect(
      after.r - before.r,
      `x=${probeX} should be background at ${stillIndex} and fill at ` +
        `${movedIndex}; got rgb(${before.r},${before.g},${before.b}) then ` +
        `rgb(${after.r},${after.g},${after.b})`,
    ).toBeGreaterThan(100);
  });

  await test.step("the UI reported completion too", async () => {
    const modal = await exportModalState(page);
    expect(modal.errorVisible, modal.errorMessage).toBe(false);
  });
});
