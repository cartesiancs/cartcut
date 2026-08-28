/**
 * The floor the rest of the suite stands on.
 *
 * If these fail, every other failure in the run is downstream of this one, so
 * they are worth stating separately rather than folding into the first spec
 * that happens to need a running app.
 */

import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../harness/test";

test("the editor comes up with its bundle evaluated and isolated from the user's install", async ({
  session,
  profile,
}) => {
  const { page, app, userDataDir } = session;

  // Counted, not asserted visible: `element-timeline-canvas` is a
  // `display: inline` wrapper with a 0x0 box. Its canvas is the thing on
  // screen, so that is what gets the visibility assertion.
  await expect(page.locator("element-timeline-canvas")).toHaveCount(1);
  await expect(page.locator("#elementTimelineCanvasRef")).toBeVisible();
  await expect(page.locator("preview-canvas #elementPreviewCanvasRef")).toBeVisible();

  // The diagnostics surface the frame-parity check reads. Asserting it here
  // means a missing bridge export reads as "the bridge is missing" rather than
  // as a mysterious undefined deep inside a comparison.
  const bridge = await page.evaluate(() => {
    const c = (globalThis as any).CARTCUT;
    return {
      keys: c == null ? [] : Object.keys(c).sort(),
      rendererFiletypes: c?.exportElementRenderers ? Object.keys(c.exportElementRenderers).sort() : [],
    };
  });

  expect(bridge.keys).toEqual(
    expect.arrayContaining([
      "createExportFxRuntime",
      "exportElementRenderers",
      "frameCount",
      "frameTimeMs",
      "loadedAssetStore",
      "previewFxRuntime",
      "previewViewportStore",
      "renderOptionStore",
      "renderTimelineAtTime",
      "selectionStore",
      "useTimelineStore",
    ]),
  );
  // The five visual filetypes an export knows how to draw.
  expect(bridge.rendererFiletypes).toEqual(["gif", "image", "shape", "text", "video"]);

  // Isolation: a temp userData, and no MCP server bound. The developer's own
  // Cartcut may be running and holding port 9826, and the test instance must
  // neither take it from them nor fail because it could not.
  expect(userDataDir).toContain("cartcut-e2e-");
  expect(fs.existsSync(path.join(userDataDir, "config.json"))).toBe(true);

  // `agent:getStatus` reports the server this process owns, which is the
  // property that actually matters — reading the store back would only confirm
  // the file we wrote.
  const mcp = await page.evaluate(
    async () => await (globalThis as any).electronAPI.req.agent.getStatus(),
  );
  expect(mcp.running).toBe(false);
  void app;

  // The default project length before any test touches it, so a later
  // assertion about duration is measuring a change the test made.
  const options = await page.evaluate(() => (globalThis as any).CARTCUT.renderOptionStore.getState().options);
  expect(options.fps).toBeGreaterThan(0);
  expect(options.previewSize.w).toBeGreaterThan(0);

  test.info().annotations.push({
    type: "profile",
    description: `${profile.name}: ${profile.width}x${profile.height}@${profile.fps}, ${profile.durationSec}s`,
  });
});

test("native dialogs are answered by the test, not by a human", async ({ session }) => {
  const { page, answerSaveDialog, answerOpenDialog } = session;

  await answerOpenDialog(["/tmp/cartcut-e2e-open"]);
  const opened = await page.evaluate(
    async () => await (globalThis as any).electronAPI.req.dialog.openDirectory(),
  );
  expect(opened).toBeTruthy();

  await answerSaveDialog("/tmp/cartcut-e2e-out.mp4");
  const saved = await page.evaluate(
    async () => await (globalThis as any).electronAPI.req.dialog.exportVideo("mp4"),
  );
  expect(saved).toBe("/tmp/cartcut-e2e-out.mp4");

  // An unqueued dialog must cancel rather than hang — a hang here would cost
  // the run its whole timeout with nothing to show for it.
  const cancelled = await page.evaluate(
    async () => await (globalThis as any).electronAPI.req.dialog.exportVideo("mp4"),
  );
  expect(cancelled == null || cancelled === "").toBeTruthy();
});
