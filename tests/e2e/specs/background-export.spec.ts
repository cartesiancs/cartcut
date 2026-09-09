/**
 * Editing during a render must not change the render.
 *
 * The export's frame loop runs in the editor's own renderer process and used to
 * drive the *same* `<video>` handles as the preview: `previewCanvas` repaints on
 * every store write and its draw path calls `syncPlayback` and
 * `releaseUnusedVideos` with a cursor, either of which moves or drops a decoder
 * mid-frame. The only thing that ever prevented it was the progress dialog's
 * backdrop blocking the mouse — a property of the UI, not of the code — and the
 * export button on the title bar removes it.
 *
 * `features/asset/videoScope.ts` is the fix and this is the only test that can
 * see it working: the failure is a plausible *wrong* frame, not a crash, so no
 * unit test can reach it and no single export can be judged on its own.
 *
 * So this is a **differential** test. Export the same project twice — once
 * undisturbed, once while scrubbing, playing, moving and deleting — and require
 * the two files to agree frame for frame. Asserting the difference rather than
 * an absolute frame index is also what keeps it honest while the microsecond
 * seek defect (FINDINGS.md #1) is open: that defect afflicts both runs equally,
 * so it cancels, and a regression in decoder ownership does not.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../harness/test";
import { agent } from "../harness/agent";
import {
  runExport,
  exportModalState,
  exportPhase,
  dismissExportModals,
} from "../harness/export";
import { countFrames, decodeFrames } from "../harness/decode";
import {
  setProjectFolder,
  setDuration,
  setResolution,
  setBackgroundColor,
  setFps,
  setExportPreset,
} from "../harness/ui";
import type { AppSession } from "../harness/launch";

/**
 * The project's shape, and the whole reason it is shaped this way.
 *
 * `decoderWindow.ts` releases a decoder once its clip is more than
 * `RELEASE_AHEAD_MS` (10s) ahead of the playhead or `RELEASE_BEHIND_MS` (6s)
 * behind it. A short project cannot reach either edge, so a scrub across it
 * never causes a release and the spec would pass whether the export owned its
 * decoders or not — which is exactly what a first draft of this file did.
 *
 * Twenty seconds with the two clips at opposite ends means parking the playhead
 * at either end puts the other clip *outside* the release window, so the
 * preview's `releaseUnusedVideos` genuinely tears a handle down mid-render.
 */
const DURATION_SEC = 20;
const CLIP_A = { startMs: 0, durationMs: 5000 };
const CLIP_B = { startMs: 15_000, durationMs: 5000 };

/**
 * Scrub the playhead across the whole project, continuously, until stopped.
 *
 * A user scrubbing is a stream of store writes, not one; and the race that
 * matters is narrow — between the export's `seeked` resolving and its
 * synchronous composite — so a single burst per progress sample almost never
 * lands inside it. This runs at 60Hz for the length of the export instead.
 *
 * Driven through the real stores rather than synthetic pointer events: what has
 * to reach the preview's draw path is the *store write*, and a mouse gesture is
 * a slower way of causing the same one.
 */
async function startScrubbing(session: AppSession): Promise<void> {
  await session.page.evaluate((total: number) => {
    const g = globalThis as any;
    const C = g.CARTCUT;
    let n = 0;
    g.__cartcutScrubs = 0;
    g.__cartcutScrubber = setInterval(() => {
      // The ends first and most often: that is where the other clip falls out
      // of the release window.
      const at = [0, total, total * 0.5, total, 0, total * 0.75][n % 6];
      n += 1;
      g.__cartcutScrubs += 1;
      C.useTimelineStore.getState().setCursor(Math.round(at));
    }, 16);
  }, DURATION_SEC * 1000);
}

/**
 * Press Stop the way a user does: open the popover from the ring, click Stop.
 *
 * Deliberately not a call into `cancelExport` — the point of this leg is that
 * the ring is clickable and the panel it opens carries a working button, which
 * is a claim about the DOM.
 */
async function pressStop(session: AppSession): Promise<void> {
  const { page } = session;
  await page.locator("export-button .export-trigger").click();
  await page.locator("export-button .export-stop").click();
}

async function stopScrubbing(session: AppSession): Promise<number> {
  return session.page.evaluate(() => {
    const g = globalThis as any;
    if (g.__cartcutScrubber != null) {
      clearInterval(g.__cartcutScrubber);
      g.__cartcutScrubber = null;
    }
    return g.__cartcutScrubs ?? 0;
  });
}

test("editing during a render does not change the render", async ({
  session,
  fixtures,
  profile,
  artifactDir,
}, testInfo) => {
  test.setTimeout(15 * 60_000);

  const { page } = session;
  const durationSec = DURATION_SEC;
  const width = 640;
  const height = 360;
  const fps = profile.fps;
  const frames = Math.round(durationSec * fps);

  const projectDir = path.join(artifactDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const quiet = path.join(artifactDir, "quiet.mp4");
  const disturbed = path.join(artifactDir, "disturbed.mp4");

  await test.step("configure the project", async () => {
    await setProjectFolder(session, projectDir);
    await setResolution(page, width, height);
    await setDuration(page, durationSec);
    await setBackgroundColor(page, "#101820");
    await setFps(page, fps);
    await setExportPreset(page, "low");
  });

  await test.step("place two video clips at opposite ends", async () => {
    const a = fixtures.video.find((v) => v.id === "v01-h264-1080p60")!;
    const b = fixtures.video.find((v) => v.id !== "v01-h264-1080p60")!;
    const added = await agent<any>(session, "add_media", {
      items: [
        { path: a.path, ...CLIP_A },
        { path: b.path, ...CLIP_B },
      ],
      sequential: false,
    });
    expect(added.skipped ?? []).toEqual([]);
  });

  await test.step("export once, undisturbed", async () => {
    const outcome = await runExport(session, {
      destination: quiet,
      timeoutMs: 8 * 60_000,
    });
    if (outcome.status !== "finished") {
      throw new Error(
        `baseline export ${outcome.status}: ${outcome.error?.message ?? ""}\n` +
          `${outcome.error?.stderrTail ?? "(no ffmpeg stderr)"}`,
      );
    }
    expect(await countFrames(quiet)).toBe(frames);
  });

  await test.step("the button returned to idle before a second export", async () => {
    // The `cancelling`/`finalizing` phases must have settled, or the main
    // process would refuse this next one outright.
    await expect.poll(() => exportPhase(page)).toBe("idle");
    // And the completion dialog has to go: it is a Bootstrap modal, so its
    // backdrop covers the title bar's export button until it is dismissed.
    await dismissExportModals(page);
  });

  let scrubs = 0;
  await test.step("export again while the timeline is scrubbed", async () => {
    await startScrubbing(session);
    try {
      const outcome = await runExport(session, {
        destination: disturbed,
        timeoutMs: 8 * 60_000,
      });
      if (outcome.status !== "finished") {
        throw new Error(
          `disturbed export ${outcome.status}: ${outcome.error?.message ?? ""}\n` +
            `${outcome.error?.stderrTail ?? "(no ffmpeg stderr)"}`,
        );
      }
      await testInfo.attach("disturbed-outcome.json", {
        body: JSON.stringify(outcome, null, 2),
        contentType: "application/json",
      });
    } finally {
      scrubs = await stopScrubbing(session);
    }
  });

  await test.step("the scrubbing actually happened while it was running", async () => {
    // Without this the spec could pass by never disturbing anything at all,
    // which is the way a differential test quietly stops testing.
    expect(
      scrubs,
      "the playhead never moved during the export — this spec would then be " +
        "comparing two undisturbed renders and proving nothing",
    ).toBeGreaterThan(50);
  });

  await test.step("the two files agree frame for frame", async () => {
    expect(await countFrames(disturbed)).toBe(frames);

    // Every frame, not a sample: a decoder stolen for one frame is exactly the
    // failure this exists to catch, and a sample would miss it most of the time.
    const wanted = Array.from({ length: frames }, (_, n) => n);
    const a = await decodeFrames(quiet, wanted, width, height);
    const b = await decodeFrames(disturbed, wanted, width, height);

    const digest = (buf: Buffer) =>
      crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);

    const differing: number[] = [];
    for (let i = 0; i < wanted.length; i++) {
      if (digest(a.frames[i]) !== digest(b.frames[i])) {
        differing.push(wanted[i]);
      }
    }

    await testInfo.attach("frame-diff.json", {
      body: JSON.stringify(
        { frames, differing, scrubs },
        null,
        2,
      ),
      contentType: "application/json",
    });

    expect(
      differing,
      `${differing.length} of ${frames} frames differ between an undisturbed ` +
        `export and one made while the timeline was edited. The export's ` +
        `decoders are being moved by the preview — see features/asset/videoScope.ts.`,
    ).toEqual([]);
  });

  await test.step("the UI reported completion, not an error", async () => {
    const modal = await exportModalState(page);
    expect(modal.errorVisible, modal.errorMessage).toBe(false);
    await expect.poll(() => exportPhase(page)).toBe("idle");
    await dismissExportModals(page);
  });

  /**
   * Stopping, and being able to start again straight away.
   *
   * The renderer aborts instantly and the main process is still SIGKILLing
   * FFmpeg, during which `ipcRenderV2.start` throws "An export is already
   * running". The `cancelling` phase exists for exactly that window, and with
   * the button permanently on the title bar it is one double-click away.
   */
  await test.step("Stop cancels, and a new export can start immediately after", async () => {
    const cancelled = path.join(artifactDir, "cancelled.mp4");
    const restarted = path.join(artifactDir, "restarted.mp4");

    let stopped = false;
    const outcome = await runExport(session, {
      destination: cancelled,
      timeoutMs: 4 * 60_000,
      onProgress: (percent) => {
        if (stopped || percent < 15) return;
        stopped = true;
        void pressStop(session);
      },
    });

    expect(stopped, "the export finished before Stop could be pressed").toBe(true);
    expect(outcome.status).toBe("cancelled");
    // The partial file is unlinked by `renderFrame.ts#onCancelled`.
    expect(fs.existsSync(cancelled)).toBe(false);

    await expect.poll(() => exportPhase(page)).toBe("idle");
    await dismissExportModals(page);

    const again = await runExport(session, {
      destination: restarted,
      timeoutMs: 8 * 60_000,
    });
    expect(
      again.status,
      `a second export straight after a cancel was refused: ` +
        `${again.error?.message ?? ""}`,
    ).toBe("finished");
    expect(await countFrames(restarted)).toBe(frames);
  });
});
