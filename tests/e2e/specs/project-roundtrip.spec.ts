/**
 * A project's frame rate has to survive being saved and reopened.
 *
 * The unit suite proves the two pure functions round-trip
 * (`features/project/renderOptionsFile.test.ts`). This proves the app actually
 * calls them: the rate reaches `renderOptions.json` inside the real `.ngt` zip,
 * and the real load path reads it back rather than substituting a literal 60 —
 * which is exactly what it used to do.
 *
 * Also the backward-compatibility check. `SCHEMA_VERSION` deliberately did not
 * move for the new field, so every project anyone has already saved arrives
 * with no `fps` key at all and has to open as the 60fps project it is. That
 * case is manufactured here by stripping the key back out of a file the app
 * just wrote, which is a truer stand-in for an old project than a hand-built
 * fixture would be.
 */

import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import { test, expect } from "../harness/test";
import { setDuration, setFps, setResolution } from "../harness/ui";

/** What the running app currently believes the project is. */
const optionsOf = (page: any) =>
  page.evaluate(
    () => (globalThis as any).CARTCUT.renderOptionStore.getState().options,
  );

/** Read `renderOptions.json` out of a written `.ngt`. */
async function renderOptionsIn(file: string): Promise<any> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  return JSON.parse(await zip.file("renderOptions.json")!.async("string"));
}

/** Rewrite a `.ngt` with `renderOptions.json` transformed. */
async function rewriteRenderOptions(
  file: string,
  fn: (options: any) => any,
): Promise<void> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const options = JSON.parse(
    await zip.file("renderOptions.json")!.async("string"),
  );
  zip.file("renderOptions.json", JSON.stringify(fn(options)));
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

test("the project frame rate survives a save and a reopen", async ({
  session,
  artifactDir,
}) => {
  const { page, answerSaveDialog, answerOpenDialog } = session;
  const file = path.join(artifactDir, "roundtrip.ngt");

  await test.step("configure the project at a non-default rate", async () => {
    await setResolution(page, 640, 360);
    await setDuration(page, 3);
    await setFps(page, 30);
    expect((await optionsOf(page)).fps).toBe(30);
  });

  await test.step("save it", async () => {
    await answerSaveDialog(file);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.save());
    await expect.poll(() => fs.existsSync(file), { timeout: 30_000 }).toBe(true);
  });

  await test.step("the rate is in the file, not merely in the store", async () => {
    const written = await renderOptionsIn(file);
    expect(written.fps).toBe(30);
    // The rest of the entry has to keep its historical shape, or older builds
    // stop opening what this one writes.
    expect(written.videoDuration).toBe(3);
    expect(written.previewSize).toEqual({ w: 640, h: 360 });
  });

  await test.step("the playhead reads as a timecode at the project rate", async () => {
    // The readout is `HH:MM:SS:FF` now, and the frame field is what makes the
    // rate visible at all — `00:00:01.016` said nothing about which frame that
    // was. Asserted here because it is the one part of the frame-rate surface
    // no node test can reach: `formatTimecode` is pure and covered, but whether
    // `Timeline.ts` actually calls it with the project's rate is not.
    const readout = page.locator("timeline-ui b.text-light");

    await page.evaluate(() =>
      (globalThis as any).CARTCUT.useTimelineStore.getState().setCursor(0),
    );
    await expect(readout).toHaveText("00:00:00:00");

    // Frame 7 of a 30fps project is 233.33ms — a time the old millisecond
    // readout could not have named without lying about the grid.
    await page.evaluate(() =>
      (globalThis as any).CARTCUT.useTimelineStore
        .getState()
        .setCursor((7 / 30) * 1000),
    );
    await expect(readout).toHaveText("00:00:00:07");

    // And the same instant is a different frame at a different rate, which is
    // the whole point of the field being there.
    await setFps(page, 60);
    await expect(readout).toHaveText("00:00:00:14");
    await setFps(page, 30);
  });

  await test.step("move the project somewhere else entirely", async () => {
    // So that reading 30 back afterwards cannot be the store having simply kept
    // what it already had.
    await setFps(page, 120);
    expect((await optionsOf(page)).fps).toBe(120);
  });

  await test.step("reopen it", async () => {
    await answerOpenDialog([file]);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.load());

    await expect
      .poll(async () => (await optionsOf(page)).fps, { timeout: 30_000 })
      .toBe(30);

    const options = await optionsOf(page);
    expect(options.duration).toBe(3);
    expect(options.previewSize).toEqual({ w: 640, h: 360 });
  });
});

test("a project written before frame rates were configurable opens at 60", async ({
  session,
  artifactDir,
}) => {
  const { page, answerSaveDialog, answerOpenDialog } = session;
  const file = path.join(artifactDir, "legacy.ngt");

  await test.step("write a project, then strip the field an old build lacked", async () => {
    await setResolution(page, 640, 360);
    await setFps(page, 24);

    await answerSaveDialog(file);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.save());
    await expect.poll(() => fs.existsSync(file), { timeout: 30_000 }).toBe(true);

    await rewriteRenderOptions(file, (options) => {
      const { fps, ...rest } = options;
      void fps;
      return rest;
    });
    expect(await renderOptionsIn(file)).not.toHaveProperty("fps");
  });

  await test.step("it opens, and it opens at 60", async () => {
    await setFps(page, 120);

    await answerOpenDialog([file]);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.load());

    await expect
      .poll(async () => (await optionsOf(page)).fps, { timeout: 30_000 })
      .toBe(60);

    // And without the "made with an older version" refusal, which is what a
    // bumped schema version would have produced for every existing project.
    await expect(page.locator("#whenTimelineChangedMsg")).not.toContainText(
      "older version",
    );
  });
});
