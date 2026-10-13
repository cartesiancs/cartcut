/**
 * Stabilize, in the running app, through the real Render button.
 *
 * The node suites prove the lock with matrices (`stabilizeOp.test.ts`), with
 * the compositor's pixels on a still image (`stabilizeComposite.test.ts`) and
 * from the real tracker on synthetic frames (`stabilizeChain.test.ts`). None
 * of them decodes a video. Here the footage is a real H.264 file that Chromium
 * decodes frame by frame and FFmpeg encodes again, so what is measured is the
 * frame the decoder actually showed, which is the one thing the display-aligned
 * null (`trackToTimeline.ts#toDisplayedPath`) is a prediction of.
 *
 * The clip is generated here: a grey picture larger than the frame with a red
 * square on it, moved over a black frame on an integer path, so the square's
 * position in every source frame is known exactly without tracking. The null
 * is written from that path over `set_keyframes`, one key per project frame at
 * the source frame that project frame shows, and the timeline's own "Stabilize
 * on null" entry builds the rig.
 *
 * Two rate pairs, because they are the two cases the display alignment has to
 * get right: 30fps footage in a 60fps project (each source frame on show for
 * two project frames, where a linearly interpolated null would be half a step
 * out on every other one) and 60fps in 30 (each project frame's centre lands
 * exactly on a source frame's start, so which frame shows is the decoder's
 * rounding: measured, the earlier one on two frames in three, which is what
 * the null predicts, and the later on the third, which is a decoder fault the
 * spec bounds and reports rather than hides).
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import JSZip from "jszip";

import { test, expect } from "../harness/test";
import { agent, selectClips, setPlayhead, timelineDocument } from "../harness/agent";
import { dismissExportModals, runExport } from "../harness/export";
import { decodeFrames } from "../harness/decode";
import { writePng } from "../harness/artifacts";
import { FFMPEG } from "../harness/paths";
import {
  openTab,
  setProjectFolder,
  setDuration,
  setResolution,
  setFps,
  setBackgroundColor,
  setExportPreset,
} from "../harness/ui";

const W = 320;
const H = 240;
const DURATION_SEC = 2;
const TARGET = { x: W / 2, y: H / 2 };

/** The red square's top-left in the picture, and its side. Centre (238, 178). */
const SQUARE = { x: 234, y: 174, side: 8 };
const SQUARE_CENTRE = { x: SQUARE.x + SQUARE.side / 2, y: SQUARE.y + SQUARE.side / 2 };

/**
 * Where the picture's top-left is in source frame `n`: integer triangle waves,
 * so FFmpeg's overlay places it exactly here with nothing to round. The
 * overlay is driven by `round(t * fps)` rather than its own `n`, which counts
 * from 1 here, and composited in RGBA, because a YUV overlay rounds the
 * position to the chroma grid. `makeClip` checks the result against this.
 */
const pictureAt = (n: number) => ({
  x: -98 + Math.abs(((n * 2) % 80) - 40),
  y: -68 + Math.abs(((n * 3) % 40) - 20),
});

/**
 * Where the square's centre is on the frame in source frame `n`: within 20px
 * of the centre across and 10px down, so holding it there moves the video
 * frame by at most that and a zoom of about 1.15 hides the edge. The picture
 * always covers the video frame, so before stabilizing nothing is black.
 */
const squareAt = (n: number) => ({
  x: pictureAt(n).x + SQUARE_CENTRE.x,
  y: pictureAt(n).y + SQUARE_CENTRE.y,
});

/**
 * The same clip on a picture with texture in it, which the tracker needs: a
 * flat grey patch has nothing to correlate. Static value noise, scaled up
 * with nearest-neighbour so it survives H.264, as the Auto Track memory
 * found works (`geq=random` stripes, a checkerboard aliases a period off).
 */
function makeTexturedClip(dir: string, file: string, fps: number): void {
  const noise = path.join(dir, "noise.png");
  run([
    "-f", "lavfi", "-i", "color=c=gray:s=120x90",
    "-vf", "noise=alls=100:allf=u,format=gray,scale=480:360:flags=neighbor",
    "-frames:v", "1", noise,
  ]);
  run([
    "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${fps}:d=${DURATION_SEC}`,
    "-loop", "1", "-framerate", String(fps), "-t", String(DURATION_SEC), "-i", noise,
    "-filter_complex",
    `[0]format=rgba[b];` +
      `[1]format=rgba,drawbox=x=${SQUARE.x}:y=${SQUARE.y}:w=${SQUARE.side}:h=${SQUARE.side}:color=red:t=fill[p];` +
      `[b][p]overlay=x='-98+abs(mod(round(t*${fps})*2\\,80)-40)':` +
      `y='-68+abs(mod(round(t*${fps})*3\\,40)-20)':eval=frame:format=rgb,format=yuv420p`,
    "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast", "-crf", "10",
    "-r", String(fps), "-frames:v", String(DURATION_SEC * fps),
    file,
  ]);
}

function run(args: string[]): void {
  const result = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr}`);
  }
}

function makeClip(file: string, fps: number): void {
  const result = spawnSync(
    FFMPEG,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${fps}:d=${DURATION_SEC}`,
      "-f", "lavfi", "-i", `color=c=gray:s=480x360:r=${fps}:d=${DURATION_SEC}`,
      "-filter_complex",
      `[0]format=rgba[b];` +
        `[1]format=rgba,drawbox=x=${SQUARE.x}:y=${SQUARE.y}:w=${SQUARE.side}:h=${SQUARE.side}:color=red:t=fill[p];` +
        `[b][p]overlay=x='-98+abs(mod(round(t*${fps})*2\\,80)-40)':` +
        `y='-68+abs(mod(round(t*${fps})*3\\,40)-20)':eval=frame:format=rgb,format=yuv420p`,
      "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast", "-crf", "10",
      "-r", String(fps),
      file,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`could not make the fixture: ${result.stderr}`);
  }
}

/** The red square's centre, weighted by how red each pixel is. */
function redCentroid(data: Uint8Array | Uint8ClampedArray): { x: number; y: number } | null {
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const redness = data[i] - (data[i + 1] + data[i + 2]) / 2;
      if (redness > 40) {
        sum += redness;
        sx += redness * (x + 0.5);
        sy += redness * (y + 0.5);
      }
    }
  }
  return sum > 0 ? { x: sx / sum, y: sy / sum } : null;
}

/**
 * Close the finish modal an export leaves up, which would take the next click
 * on Render. `dismissExportModals` does it; when its `hide()` lands inside
 * Bootstrap 5.0.2's fade-in the modal still closes but the backdrop can be
 * left behind for good, so a backdrop with no open modal under it is removed
 * here. The export UI is not what this spec is about.
 */
async function clearExportModals(page: import("playwright").Page): Promise<void> {
  try {
    await dismissExportModals(page);
    return;
  } catch {
    // Fall through: see below.
  }
  // Whatever is still open, closed through Bootstrap's own API, then any
  // backdrop with no open modal under it removed.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const open = [...document.querySelectorAll<HTMLElement>(".modal.show")];
          for (const el of open) {
            (globalThis as any).bootstrap?.Modal?.getInstance?.(el)?.hide();
          }
          if (open.length === 0) {
            document.querySelectorAll(".modal-backdrop").forEach((node) => node.remove());
            document.body.classList.remove("modal-open");
            document.body.style.removeProperty("overflow");
            document.body.style.removeProperty("padding-right");
          }
          return open.map((el) => el.id || el.className).join(",");
        }),
      { message: "a modal would not close", timeout: 15_000 },
    )
    .toBe("");
}

function isDark(data: Uint8Array | Uint8ClampedArray, x: number, y: number): boolean {
  const i = (y * W + x) * 4;
  return data[i] < 40 && data[i + 1] < 40 && data[i + 2] < 40;
}

const CORNERS: Array<[number, number]> = [
  [0, 0],
  [W - 1, 0],
  [0, H - 1],
  [W - 1, H - 1],
];

for (const { sourceFps, projectFps } of [
  { sourceFps: 30, projectFps: 60 },
  { sourceFps: 60, projectFps: 30 },
]) {
  test(`a ${sourceFps}fps clip in a ${projectFps}fps project holds its point on the centre of the delivered file`, async ({
    session,
    artifactDir,
  }) => {
    test.setTimeout(10 * 60_000);
    const { page } = session;

    const projectDir = path.join(artifactDir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    const clipFile = path.join(artifactDir, `square-${sourceFps}.mp4`);
    makeClip(clipFile, sourceFps);

    await test.step("the fixture puts the square where the model says", async () => {
      const count = DURATION_SEC * sourceFps;
      const decoded = await decodeFrames(clipFile, Array.from({ length: count }, (_, n) => n), W, H);
      expect(decoded.frames).toHaveLength(count);
      for (let n = 0; n < count; n++) {
        const dot = redCentroid(decoded.frames[n]);
        const want = squareAt(n);
        expect(Math.hypot(dot!.x - want.x, dot!.y - want.y), `source frame ${n}`).toBeLessThan(0.25);
      }
    });

    await test.step("configure the project", async () => {
      await setProjectFolder(session, projectDir);
      await setResolution(page, W, H);
      await setDuration(page, DURATION_SEC);
      await setBackgroundColor(page, "#000000");
      await setFps(page, projectFps);
      await setExportPreset(page, "low");
    });

    const added = await agent<any>(session, "add_media", {
      items: [{ path: clipFile, startMs: 0 }],
    });
    expect(added.skipped ?? []).toEqual([]);

    const doc = await timelineDocument(session);
    const [clipId, clip] = Object.entries<any>(doc).find(([, e]) => e.filetype === "video")!;
    const box = { x: clip.location.x, y: clip.location.y, sx: clip.width / W, sy: clip.height / H };
    const onFrame = (p: { x: number; y: number }) => ({ x: box.x + p.x * box.sx, y: box.y + p.y * box.sy });

    /**
     * The source frame project frame `k` shows: the centre of `k`, held, and
     * on a tie the frame before it (`trackToTimeline.ts#SHOWN_FRAME_TIE_MS`).
     */
    const shown = (k: number) => Math.floor(((k + 0.5) * sourceFps) / projectFps - 1e-6);
    const frames = DURATION_SEC * projectFps;
    const frameMs = (k: number) => (k * 1000) / projectFps;

    const nullId = await agent<any>(session, "create_null", { name: "Track" }).then((r) => r.nullId);
    expect(nullId).toBeTruthy();
    await agent(session, "set_keyframes", {
      writes: [
        {
          elementId: nullId,
          property: "position",
          replace: true,
          keyframes: Array.from({ length: frames }, (_, k) => {
            const at = onFrame(squareAt(shown(k)));
            // `location` is the pivot's top-left; the pivot is 100 square.
            return { atMs: frameMs(k), x: at.x - 50, y: at.y - 50 };
          }),
        },
      ],
    });

    const rig = await test.step("Stabilize on null, from the timeline's menu", async () => {
      await page.evaluate(
        ([clip, track]) => {
          const canvas: any = document.querySelector("element-timeline-canvas");
          canvas.targetIdDuringRightClick = [clip, track];
          canvas.stabilizeSelected();
        },
        [clipId, nullId],
      );
      const after = await timelineDocument(session);
      const zoom = Object.entries<any>(after).find(([, e]) => e.rig === "stabilize-zoom");
      const camera = Object.entries<any>(after).find(([, e]) => e.rig === "stabilize-camera");
      expect(zoom).toBeTruthy();
      expect(camera).toBeTruthy();
      expect(after[clipId].parentId).toBe(camera![0]);
      expect(after[nullId].parentId).toBe(camera![0]);
      return { zoomId: zoom![0], zoomScale: zoom![1].scale };
    });
    expect(rig.zoomScale).toBeGreaterThan(10);

    const render = async (name: string) => {
      const destination = path.join(artifactDir, `${name}.mp4`);
      const outcome = await runExport(session, { destination, timeoutMs: 6 * 60_000 });
      if (outcome.status !== "finished") {
        throw new Error(
          `export ${outcome.status}: ${outcome.error?.message ?? ""}\n${outcome.error?.stderrTail ?? ""}`,
        );
      }
      await clearExportModals(page);
      const wanted = Array.from({ length: frames }, (_, k) => k);
      const decoded = await decodeFrames(destination, wanted, W, H);
      expect(decoded.frames).toHaveLength(frames);
      return decoded.frames;
    };

    const stabilized = await test.step("render, and measure every frame", () => render("stabilized"));
    const report: Array<Record<string, unknown>> = [];
    let later = 0;
    for (let k = 0; k < frames; k++) {
      const data = stabilized[k];
      const dot = redCentroid(data);
      expect(dot, `frame ${k} has a square`).not.toBeNull();
      const error = Math.hypot(dot!.x - TARGET.x, dot!.y - TARGET.y);

      // One source frame of the square's own motion, on the frame: the most a
      // decoder rounding a boundary the other way can move it.
      const j = shown(k);
      const before = onFrame(squareAt(Math.max(0, j - 1)));
      const now = onFrame(squareAt(j));
      const step = Math.hypot(now.x - before.x, now.y - before.y) * (rig.zoomScale / 10);
      const exact = error < 1.5;
      if (exact) later++;
      report.push({ k, j, error, step });

      if (sourceFps <= projectFps) {
        // Every shown frame is a whole source frame, held: exact up to the
        // encoder's chroma and the square's anti-aliasing.
        expect(error, `frame ${k}`).toBeLessThan(1.5);
      } else {
        expect(error, `frame ${k}`).toBeLessThan(step + 1.5);
      }
      for (const [x, y] of CORNERS) {
        expect(isDark(data, x, y), `frame ${k} corner ${x},${y}`).toBe(false);
      }
      if (k === 0 || k === frames - 1) {
        writePng(path.join(artifactDir, `stabilized-${k}.png`), { data, width: W, height: H } as any);
      }
    }
    fs.writeFileSync(
      path.join(artifactDir, "stabilized.json"),
      JSON.stringify({ sourceFps, projectFps, zoom: rig.zoomScale / 10, onTheFrameItPredicted: later, frames, report }, null, 2),
    );
    test.info().annotations.push({
      type: "shown frame",
      description: `${later}/${frames} frames showed the source frame the null predicted`,
    });

    await test.step("delete the Stabilize bar: the footage is back on its path", async () => {
      await agent(session, "delete_clips", { elementIds: [rig.zoomId] });
      const after = await timelineDocument(session);
      expect(after[clipId]).toBeTruthy();
      expect(after[clipId].parentId ?? null).toBeNull();
      expect(after[nullId].parentId ?? null).toBeNull();

      const original = await render("unstabilized");
      for (let k = 0; k < frames; k++) {
        const dot = redCentroid(original[k]);
        const j = shown(k);
        const want = onFrame(squareAt(j));
        const error = Math.hypot(dot!.x - want.x, dot!.y - want.y);
        if (sourceFps <= projectFps) {
          expect(error, `frame ${k}`).toBeLessThan(1.5);
        } else {
          const before = onFrame(squareAt(Math.max(0, j - 1)));
          expect(error, `frame ${k}`).toBeLessThan(Math.hypot(want.x - before.x, want.y - before.y) + 1.5);
        }
      }
    });
  });
}

// ------------------------------------------------------------ the panel

/**
 * The real Auto Track panel: a click on its stage, Track, then Stabilize.
 *
 * The click is placed by probing: two clicks a known distance apart read back
 * the box the panel put under each, which gives the stage's scale and offset
 * in the frame's own pixels without reaching into the viewport arithmetic.
 */
async function trackInPanel(
  session: Parameters<Parameters<typeof test>[2]>[0]["session"],
  clipId: string,
): Promise<void> {
  const { page } = session;
  // The panel adopts a clip when the selection changes while it is open, so
  // it is opened first and the clip selected after.
  await setPlayhead(session, 0);
  await openTab(page, "#nav-util");
  await page.locator("control-ui-util .asset", { hasText: "Auto Track" }).click();
  await selectClips(session, []);
  await selectClips(session, [clipId]);

  const panelState = () =>
    page.evaluate(() => {
      const panel: any = document.querySelector("auto-track-panel");
      return {
        phase: panel?.phase,
        shownMs: panel?.shownMs,
        clipId: panel?.clipId,
        box: panel?.box ?? null,
        path: panel?.path?.length ?? 0,
        frameMs: panel?.sourceFrameMs ?? null,
        working: panel?.source == null ? null : { w: panel.source.workingWidth, h: panel.source.workingHeight },
        count: document.querySelectorAll("auto-track-panel").length,
        connected: panel?.isConnected ?? false,
        visible: panel == null ? false : panel.getBoundingClientRect().width > 0,
        selection: (globalThis as any).CARTCUT.selectionStore.getState().ids,
        error: panel?.error ?? "",
      };
    });
  await expect
    .poll(async () => {
      const state = await panelState();
      const ready = state.phase === "ready" && Number.isFinite(state.shownMs) && state.clipId === clipId;
      return ready ? "ready" : JSON.stringify({ ...state, want: clipId });
    }, { timeout: 30_000 })
    .toBe("ready");

  const stage = (await page.locator("auto-track-panel .auto-track-canvas").boundingBox())!;
  const clickAt = async (x: number, y: number) => {
    await page.mouse.click(stage.x + x, stage.y + y);
    return (await panelState()).box as { cx: number; cy: number };
  };
  const a = await clickAt(stage.width / 2, stage.height / 2);
  const b = await clickAt(stage.width / 2 + 40, stage.height / 2 + 30);
  const scale = { x: (b.cx - a.cx) / 40, y: (b.cy - a.cy) / 30 };
  const working = (await panelState()).working!;
  const want = squareAt(0);
  const target = {
    x: (want.x * working.w) / W,
    y: (want.y * working.h) / H,
  };
  const placed = await clickAt(
    stage.width / 2 + (target.x - a.cx) / scale.x,
    stage.height / 2 + (target.y - a.cy) / scale.y,
  );
  expect(Math.hypot(placed.cx - target.x, placed.cy - target.y)).toBeLessThan(1.5);

  await page.locator("auto-track-panel .auto-track-btn", { hasText: "Track" }).click();
  await expect
    .poll(async () => {
      const state = await panelState();
      return state.phase === "ready" && state.path >= DURATION_SEC * 30 - 1;
    }, { timeout: 120_000 })
    .toBe(true);
  // The harvest measured one source frame of the 30fps clip.
  expect((await panelState()).frameMs).toBeCloseTo(1000 / 30, 3);
}

/** Every exported frame's square, against the centre: the worst miss. */
async function measureLock(
  session: Parameters<Parameters<typeof test>[2]>[0]["session"],
  artifactDir: string,
  name: string,
  frames: number,
): Promise<{ worst: number; corners: number }> {
  const destination = path.join(artifactDir, `${name}.mp4`);
  const outcome = await runExport(session, { destination, timeoutMs: 6 * 60_000 });
  if (outcome.status !== "finished") {
    throw new Error(`export ${outcome.status}: ${outcome.error?.message ?? ""}`);
  }
  await clearExportModals(session.page);
  const decoded = await decodeFrames(destination, Array.from({ length: frames }, (_, k) => k), W, H);
  expect(decoded.frames).toHaveLength(frames);
  let worst = 0;
  let corners = 0;
  for (const data of decoded.frames) {
    const dot = redCentroid(data);
    expect(dot).not.toBeNull();
    worst = Math.max(worst, Math.hypot(dot!.x - TARGET.x, dot!.y - TARGET.y));
    corners += CORNERS.filter(([x, y]) => isDark(data, x, y)).length;
  }
  return { worst, corners };
}

const rigOf = (doc: Record<string, any>) => ({
  zoom: Object.entries<any>(doc).find(([, e]) => e.rig === "stabilize-zoom")?.[0] ?? null,
  camera: Object.entries<any>(doc).find(([, e]) => e.rig === "stabilize-camera")?.[0] ?? null,
});

async function texturedProject(
  session: Parameters<Parameters<typeof test>[2]>[0]["session"],
  artifactDir: string,
): Promise<string> {
  const { page } = session;
  const projectDir = path.join(artifactDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const clipFile = path.join(artifactDir, "textured-30.mp4");
  makeTexturedClip(artifactDir, clipFile, 30);
  await setProjectFolder(session, projectDir);
  await setResolution(page, W, H);
  await setDuration(page, DURATION_SEC);
  await setBackgroundColor(page, "#000000");
  await setFps(page, 30);
  await setExportPreset(page, "low");
  const added = await agent<any>(session, "add_media", { items: [{ path: clipFile, startMs: 0 }] });
  expect(added.skipped ?? []).toEqual([]);
  const doc = await timelineDocument(session);
  return Object.entries<any>(doc).find(([, e]) => e.filetype === "video")![0];
}

test("Track and Stabilize in the Auto Track panel hold the tracked point on the centre", async ({
  session,
  artifactDir,
}) => {
  test.setTimeout(10 * 60_000);
  const { page } = session;
  const clipId = await texturedProject(session, artifactDir);
  await test.step("track the square in the panel", () => trackInPanel(session, clipId));

  const stabilizeButton = page.locator("auto-track-panel .auto-track-btn", { hasText: "Stabilize" });
  await page.locator("auto-track-panel").screenshot({ path: path.join(artifactDir, "panel.png") });

  await test.step("while the caption panel holds the timeline, Stabilize does nothing", async () => {
    await page.evaluate(() => (globalThis as any).CARTCUT.timelineLockStore.getState().lock("captionSession"));
    await stabilizeButton.click();
    expect(rigOf(await timelineDocument(session)).zoom).toBeNull();
    await page.evaluate(() => (globalThis as any).CARTCUT.timelineLockStore.getState().unlock());
  });

  await test.step("Stabilize builds the rig in one undo step", async () => {
    const before = await page.evaluate(
      () => (globalThis as any).CARTCUT.useTimelineStore.getState().history.timelineHistory.length,
    );
    await stabilizeButton.click();
    const doc = await timelineDocument(session);
    const rig = rigOf(doc);
    expect(rig.zoom).not.toBeNull();
    expect(doc[clipId].parentId).toBe(rig.camera);
    const after = await page.evaluate(
      () => (globalThis as any).CARTCUT.useTimelineStore.getState().history.timelineHistory.length,
    );
    expect(after - before).toBe(1);
    // The zoom is what is selected afterwards, for adjusting.
    expect(await page.evaluate(() => (globalThis as any).CARTCUT.selectionStore.getState().ids)).toEqual([rig.zoom]);
  });

  const { worst, corners } = await test.step("the delivered file holds the square on the centre", () =>
    measureLock(session, artifactDir, "panel", DURATION_SEC * 30));
  fs.writeFileSync(path.join(artifactDir, "panel.json"), JSON.stringify({ worst, corners }, null, 2));
  test.info().annotations.push({ type: "worst miss", description: `${worst.toFixed(3)}px` });
  // The tracker's own error on decoded H.264 and the thinning's half pixel,
  // magnified by the zoom: two pixels is the budget.
  expect(worst).toBeLessThan(2);
  expect(corners).toBe(0);
});

test("a null saved in one session stabilizes from the timeline's menu in the next", async ({
  session,
  artifactDir,
}) => {
  test.setTimeout(10 * 60_000);
  const { page, answerSaveDialog, answerOpenDialog } = session;
  const clipId = await texturedProject(session, artifactDir);
  await test.step("track the square in the panel", () => trackInPanel(session, clipId));

  await page.locator("auto-track-panel .auto-track-btn", { hasText: "Create Null" }).click();
  const nullId = (await page.evaluate(() => (globalThis as any).CARTCUT.selectionStore.getState().ids))[0] as string;
  expect((await timelineDocument(session))[nullId]?.filetype).toBe("group");

  const file = path.join(artifactDir, "saved.ngt");
  const saveAndReopen = async (to: string) => {
    await answerSaveDialog(to);
    await page.evaluate(() => {
      const field = document.querySelector("#projectFile") as any;
      if (field != null) field.value = "";
      return (globalThis as any).CARTCUT.project.save();
    });
    await expect.poll(() => fs.existsSync(to), { timeout: 30_000 }).toBe(true);
    await answerOpenDialog([to]);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.load());
    await expect
      .poll(async () => (await timelineDocument(session))[nullId] != null, { timeout: 30_000 })
      .toBe(true);
  };
  await test.step("save and reopen", () => saveAndReopen(file));

  const fromMenu = () =>
    page.evaluate(
      ([clip, track]) => {
        const canvas: any = document.querySelector("element-timeline-canvas");
        canvas.targetIdDuringRightClick = [clip, track];
        canvas.stabilizeSelected();
      },
      [clipId, nullId],
    );

  await test.step("the menu refuses while the timeline is held, and works once it is not", async () => {
    await page.evaluate(() => (globalThis as any).CARTCUT.timelineLockStore.getState().lock("captionSession"));
    await fromMenu();
    expect(rigOf(await timelineDocument(session)).zoom).toBeNull();
    await page.evaluate(() => (globalThis as any).CARTCUT.timelineLockStore.getState().unlock());
    await fromMenu();
    const doc = await timelineDocument(session);
    expect(doc[nullId].parentId).toBe(rigOf(doc).camera);
  });

  await test.step("the rig survives a save and a reopen", async () => {
    await saveAndReopen(path.join(artifactDir, "stabilized.ngt"));
    const doc = await timelineDocument(session);
    const rig = rigOf(doc);
    expect(rig.zoom).not.toBeNull();
    expect(doc[clipId].parentId).toBe(rig.camera);
  });

  const { worst, corners } = await test.step("the delivered file holds the square on the centre", () =>
    measureLock(session, artifactDir, "menu", DURATION_SEC * 30));
  fs.writeFileSync(path.join(artifactDir, "menu.json"), JSON.stringify({ worst, corners }, null, 2));
  test.info().annotations.push({ type: "worst miss", description: `${worst.toFixed(3)}px` });
  expect(worst).toBeLessThan(2);
  expect(corners).toBe(0);
});

// ------------------------------------------------------- a template's tab

/** A template whose own frame is 640x360: one grey shape filling it. */
async function installTemplate(userDataDir: string): Promise<{ w: number; h: number }> {
  const frame = { w: 640, h: 360 };
  const scalar = () => ({ isActivate: false, x: [], ax: [] });
  const vector = () => ({ isActivate: false, x: [], y: [], ax: [], ay: [] });
  const ngt = new JSZip();
  ngt.file("project.json", JSON.stringify({ schemaVersion: 2 }));
  ngt.file(
    "timeline.json",
    JSON.stringify({
      bg: {
        key: "bg",
        filetype: "shape",
        localpath: "SHAPE",
        trackId: "tv",
        priority: 1,
        blob: "",
        startTime: 0,
        duration: 4000,
        location: { x: 0, y: 0 },
        timelineOptions: { color: "#777777" },
        width: frame.w,
        height: frame.h,
        ratio: frame.w / frame.h,
        opacity: 100,
        rotation: 0,
        animation: { position: vector(), opacity: scalar(), scale: scalar(), rotation: scalar(), size: vector() },
        oWidth: frame.w,
        oHeight: frame.h,
        shape: [[0, 0], [frame.w, 0], [frame.w, frame.h], [0, frame.h]],
        option: { fillColor: "#333333" },
      },
    }),
  );
  ngt.file("tracks.json", JSON.stringify([{ id: "tv", kind: "video", name: "V1", index: 0 }]));
  ngt.file("renderOptions.json", JSON.stringify({ previewSize: frame, videoDuration: 4, fps: 30 }));
  ngt.file("assetPaths.json", JSON.stringify({ version: 1, entries: {} }));
  const dir = path.join(userDataDir, "templates", "stab");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "template.ngt"), await ngt.generateAsync({ type: "nodebuffer" }));
  fs.writeFileSync(path.join(dir, "template.json"), JSON.stringify({ name: "Stab" }));
  return frame;
}

test("in a template's own tab, Stabilize holds the point on that template's centre and edits only it", async ({
  session,
  artifactDir,
}) => {
  test.setTimeout(10 * 60_000);
  const { page } = session;
  const projectDir = path.join(artifactDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  await setProjectFolder(session, projectDir);
  await setResolution(page, W, H);
  await setDuration(page, DURATION_SEC);
  await setFps(page, 30);

  const frame = await installTemplate(session.userDataDir);
  await test.step("place the template and expand it into its tab", async () => {
    const placed = await page.evaluate(async () => {
      const C = (globalThis as any).CARTCUT;
      await C.refreshTemplateLibrary();
      return C.addTemplateToTimeline("stab", { startMs: 0 });
    });
    expect(placed.ok).toBe(true);
    await page.evaluate(() => {
      const C = (globalThis as any).CARTCUT;
      const id = Object.keys(C.useTimelineStore.getState().timeline)[0];
      const canvas: any = document.querySelector("element-timeline-canvas");
      canvas.targetIdDuringRightClick = [id];
      canvas.showMenuDropdown({ x: 400, y: 600 });
    });
    await page.locator('#menuRightClick menu-dropdown-item[item-name="Expand Template"]').click();
    await expect
      .poll(() => page.evaluate(() => (globalThis as any).CARTCUT.useTimelineStore.getState().activeTimelineId))
      .not.toBe("main");
    expect(await page.evaluate(() => (globalThis as any).CARTCUT.renderOptionStore.getState().options.previewSize)).toEqual(frame);
  });

  const clipFile = path.join(artifactDir, "square-30.mp4");
  makeClip(clipFile, 30);
  const added = await agent<any>(session, "add_media", { items: [{ path: clipFile, startMs: 0 }] });
  expect(added.skipped ?? []).toEqual([]);
  const doc = await timelineDocument(session);
  const [clipId, clip] = Object.entries<any>(doc).find(([, e]) => e.filetype === "video")!;
  const onFrame = (p: { x: number; y: number }) => ({
    x: clip.location.x + (p.x * clip.width) / W,
    y: clip.location.y + (p.y * clip.height) / H,
  });

  const nullId = await agent<any>(session, "create_null", { name: "Track" }).then((r) => r.nullId);
  await agent(session, "set_keyframes", {
    writes: [
      {
        elementId: nullId,
        property: "position",
        replace: true,
        keyframes: Array.from({ length: DURATION_SEC * 30 }, (_, k) => {
          const at = onFrame(squareAt(k));
          return { atMs: (k * 1000) / 30, x: at.x - 50, y: at.y - 50 };
        }),
      },
    ],
  });

  await page.evaluate(
    ([clipKey, track]) => {
      const canvas: any = document.querySelector("element-timeline-canvas");
      canvas.targetIdDuringRightClick = [clipKey, track];
      canvas.stabilizeSelected();
    },
    [clipId, nullId],
  );

  const result = await page.evaluate(() => {
    const s = (globalThis as any).CARTCUT.useTimelineStore.getState();
    const live = Object.values<any>(s.timeline);
    const zoom = live.find((e) => e.rig === "stabilize-zoom");
    const mainRig = Object.values<any>(s.parked.main?.elements ?? {}).some((e) => e.rig != null);
    return {
      active: s.activeTimelineId,
      zoomCentre: zoom == null ? null : { x: zoom.location.x + zoom.width / 2, y: zoom.location.y + zoom.height / 2 },
      mainRig,
    };
  });
  expect(result.active).not.toBe("main");
  // The template's frame centre, not the project's (160, 120).
  expect(result.zoomCentre).toEqual({ x: frame.w / 2, y: frame.h / 2 });
  expect(result.mainRig).toBe(false);
});
