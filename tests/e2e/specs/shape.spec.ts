/**
 * Parametric shapes, in the running app.
 *
 * The generators, the ops, the read/write split and the renderer all have
 * suites of their own, and every one of them runs against a canvas in node.
 * Three things none of them can see:
 *
 *  - **the panel**: that it mounts in the shape inspector and offers the rows
 *    each kind actually has, which is a rule written in a Lit component that
 *    this repo has no DOM test environment to reach;
 *  - **`GestureCommit`**: that a drag across the radius slider is **one** undo
 *    step and not one per `input` event, which is only observable against a
 *    real store with a real history;
 *  - **the delivered file**: that a rounded corner survives the pipe to FFmpeg.
 *    `blend.spec.ts` already showed that renderer-side compositing reaches the
 *    exported file, so what is left is whether this feature is on that path.
 */

import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../harness/test";
import { agent } from "../harness/agent";
import { runExport } from "../harness/export";
import { decodeFrames, probeOutput } from "../harness/decode";
import { writePng } from "../harness/artifacts";
import {
  setProjectFolder,
  setDuration,
  setResolution,
  setFps,
  setBackgroundColor,
  setExportPreset,
} from "../harness/ui";

const WIDTH = 320;
const HEIGHT = 240;
const DURATION_SEC = 2;

/** The square the rounded rectangle is drawn as, centred in the frame. */
const BOX = 160;
const BOX_X = (WIDTH - BOX) / 2;
const BOX_Y = (HEIGHT - BOX) / 2;

test("the Shape section scrubs as one undo step, and a rounded corner reaches the file", async ({
  session,
  profile,
  artifactDir,
}) => {
  test.setTimeout(10 * 60_000);

  const { page } = session;
  const fps = profile.fps;

  const projectDir = path.join(artifactDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const destination = path.join(artifactDir, "shape.mp4");

  await test.step("configure a short project through the settings panel", async () => {
    await setProjectFolder(session, projectDir);
    await setResolution(page, WIDTH, HEIGHT);
    await setDuration(page, DURATION_SEC);
    // Pure black, so a corner that failed to be cut reads as obviously wrong
    // rather than as a near miss.
    await setBackgroundColor(page, "#000000");
    await setFps(page, fps);
    await setExportPreset(page, "low");
  });

  const id = await agent<any>(session, "add_shape", {
    kind: "rectangle",
    startMs: 0,
    durationMs: DURATION_SEC * 1000,
    fillColor: "#ffffff",
    x: BOX_X,
    y: BOX_Y,
    width: BOX,
    height: BOX,
  }).then((r) => r?.created?.[0]);
  expect(id).toBeTruthy();

  /** The clip's recipe as stored, and the depth of the undo stack. */
  const read = () =>
    page.evaluate((elementId) => {
      const state = (globalThis as any).CARTCUT.useTimelineStore.getState();
      return {
        geometry: state.timeline[elementId]?.geometry ?? null,
        points: state.timeline[elementId]?.shape?.length ?? 0,
        history: state.history.timelineHistory.length,
      };
    }, id);

  await test.step("a shape made by naming a kind arrives with a recipe", async () => {
    await expect.poll(async () => (await read()).geometry).toEqual({ kind: "rectangle" });
  });

  // As in `adjust-panel.spec.ts` and `lut-panel.spec.ts`: the inspector learns
  // its clip from a mousedown on the timeline canvas, which an agent selection
  // never produces. So the clip is handed to the *inspector*, which passes its
  // own `elementId` down on every re-render; a section pointed at the clip on
  // its own is emptied again by the first edit that follows.
  await page.evaluate((elementId) => {
    for (const node of document.querySelectorAll("option-shape")) {
      (node as any).elementId = elementId;
      (node as any).requestUpdate?.();
    }
  }, id);

  const section = "option-shape option-shape-section";
  await expect
    .poll(() =>
      page.evaluate((s) => document.querySelectorAll(`${s} [data-shape-kind]`).length, section),
    )
    .toBe(4);

  await test.step("each kind offers the rows it actually has", async () => {
    const rowsFor = async (kind: string) => {
      await agent(session, "set_shape", { elementIds: [id], kind });
      await page.evaluate((elementId) => {
        for (const node of document.querySelectorAll("option-shape")) {
          (node as any).elementId = elementId;
          (node as any).requestUpdate?.();
        }
      }, id);
      return page.evaluate(
        (s) =>
          [...document.querySelectorAll(`${s} [data-shape-row]`)].map((row) =>
            row.getAttribute("data-shape-row"),
          ),
        section,
      );
    };

    // Every kind carries the corner radius; what changes is what sits above it.
    expect(await rowsFor("rectangle")).toEqual(["radius"]);
    expect(await rowsFor("polygon")).toEqual(["count", "radius"]);
    expect(await rowsFor("star")).toEqual(["count", "innerRatio", "radius"]);
    expect(await rowsFor("ellipse")).toEqual(["arcStart", "arcSweep", "hole", "radius"]);
  });

  await test.step("the link toggle is offered for a rectangle alone", async () => {
    const linkFor = async (kind: string) => {
      await agent(session, "set_shape", { elementIds: [id], kind });
      await page.evaluate((elementId) => {
        for (const node of document.querySelectorAll("option-shape")) {
          (node as any).elementId = elementId;
          (node as any).requestUpdate?.();
        }
      }, id);
      return page.evaluate(
        (s) => document.querySelectorAll(`${s} [data-shape-row="radius"] button`).length,
        section,
      );
    };
    // Only a rectangle has four corners to tell apart, so only a rectangle is
    // offered a way to tell them apart.
    expect(await linkFor("star")).toBe(0);
    expect(await linkFor("rectangle")).toBe(1);
  });

  /**
   * The claim that matters most to someone using it. `number-input` and a range
   * slider both emit an event per pixel of a drag; committing each one would
   * push hundreds of entries and evict the whole fifty-deep undo stack.
   */
  await test.step("a drag through ten radii is one undo step", async () => {
    const before = await read();
    await page.evaluate((s) => {
      const slider = document.querySelector(
        `${s} [data-shape-row="radius"] input[type="range"]`,
      ) as HTMLInputElement;
      for (const value of [4, 8, 12, 16, 20, 24, 28, 32, 36, 40]) {
        slider.value = String(value);
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      }
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    }, section);

    await expect
      .poll(async () => (await read()).geometry)
      .toEqual({ kind: "rectangle", radius: 40 });
    expect((await read()).history - before.history).toBe(1);
  });

  /**
   * The mirror moves with the recipe, in the same step. Nothing else in the app
   * writes `shape` beside a recipe, which is what keeps the two from
   * disagreeing, and a rectangle's mirror is four points however round it is
   * drawn: the rounding is deliberately left out of it.
   */
  await test.step("the stored point list follows the kind and ignores the rounding", async () => {
    expect((await read()).points).toBe(4);
    await agent(session, "set_shape", { elementIds: [id], kind: "polygon", count: 9 });
    await expect.poll(async () => (await read()).points).toBe(9);
    await agent(session, "set_shape", { elementIds: [id], kind: "rectangle" });
    await expect.poll(async () => (await read()).points).toBe(4);
  });

  // ------------------------------------------------------- the delivered file

  await agent(session, "set_shape", { elementIds: [id], cornerRadius: 40 });

  const outcome = await test.step("click Render and wait for FFmpeg", () =>
    runExport(session, { destination, timeoutMs: 8 * 60_000 }));

  if (outcome.status !== "finished") {
    throw new Error(
      `export ${outcome.status}: ${outcome.error?.message ?? ""}\n` +
        `${outcome.error?.stderrTail ?? "(no ffmpeg stderr)"}`,
    );
  }
  expect(fs.existsSync(destination)).toBe(true);

  await test.step("the rounded corner is cut in the delivered file", async () => {
    const probe = await probeOutput(destination);
    expect(probe.video.width).toBe(WIDTH);
    expect(probe.video.height).toBe(HEIGHT);

    const frameIndex = Math.floor(fps * 1);
    const decoded = await decodeFrames(destination, [frameIndex], WIDTH, HEIGHT);
    expect(decoded.frames).toHaveLength(1);

    const frame = { data: decoded.frames[0], width: WIDTH, height: HEIGHT };
    writePng(path.join(artifactDir, "decoded.png"), frame);

    const at = (x: number, y: number) => {
      const offset = (y * WIDTH + x) * 4;
      return frame.data[offset];
    };

    // The middle of the white square, and the middle of each edge: filled.
    expect(at(WIDTH / 2, HEIGHT / 2), "centre").toBeGreaterThan(200);
    expect(at(WIDTH / 2, BOX_Y + 2), "top edge").toBeGreaterThan(200);
    expect(at(BOX_X + 2, HEIGHT / 2), "left edge").toBeGreaterThan(200);

    // All four corners, four pixels in on each axis: well inside a radius of
    // 40, so every one of them has been cut away.
    for (const [x, y, label] of [
      [BOX_X + 4, BOX_Y + 4, "top left"],
      [BOX_X + BOX - 5, BOX_Y + 4, "top right"],
      [BOX_X + BOX - 5, BOX_Y + BOX - 5, "bottom right"],
      [BOX_X + 4, BOX_Y + BOX - 5, "bottom left"],
    ] as const) {
      expect(at(x as number, y as number), `${label} corner`).toBeLessThan(60);
    }
  });
});
