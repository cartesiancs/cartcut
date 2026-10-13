/**
 * A template's own timeline, opened, edited, saved and opened again.
 *
 * The unit suites prove the pieces: the fork (`composition/fork.test.ts`),
 * the store's one history and its tabs (`timelineStore.composition.test.ts`),
 * the switch's effects, the file entry, the nested effects runtime. This
 * proves the app wires them together: the clip's context menu expands it, the
 * tabs above the timeline switch, an edit made in the template's tab reaches main's
 * picture and length in one undo step, the `.ngt` carries the template and
 * opens again, and Save as Template installs a copy in the library.
 *
 * The template is written straight into the isolated `userData/templates`:
 * a red frame with the built-in Invert effect over it, so the picture reads
 * cyan where the template's own effect ran and red where it did not. That one
 * colour is what tells "the effect inside the template reached main's
 * composite" apart from "the template drew without it", the gap this work
 * closed.
 */

import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import { test, expect } from "../harness/test";

const W = 640;
const H = 360;

/** The template's document: a red frame on V1, Invert over it on E1. */
function templateDocument() {
  const scalar = () => ({ isActivate: false, x: [], ax: [] });
  const vector = () => ({ isActivate: false, x: [], y: [], ax: [], ay: [] });
  return {
    tracks: [
      { id: "te", kind: "effect", name: "E1", index: 0 },
      { id: "tv", kind: "video", name: "V1", index: 1 },
    ],
    elements: {
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
        timelineOptions: { color: "#c0392b" },
        width: W,
        height: H,
        ratio: W / H,
        opacity: 100,
        rotation: 0,
        animation: {
          position: vector(),
          opacity: scalar(),
          scale: scalar(),
          rotation: scalar(),
          size: vector(),
        },
        oWidth: W,
        oHeight: H,
        shape: [
          [0, 0],
          [W, 0],
          [W, H],
          [0, H],
        ],
        option: { fillColor: "#ff0000" },
      },
      grade: {
        key: "grade",
        filetype: "effect",
        localpath: "EFFECT",
        trackId: "te",
        priority: 2,
        blob: "",
        startTime: 0,
        duration: 4000,
        location: { x: 0, y: 0 },
        timelineOptions: { color: "#8e44ad" },
        presetId: "com.cartcut.invert",
        params: { mode: 0 },
        intensity: 100,
        animation: { opacity: scalar() },
      },
    },
  };
}

/** Install the template the way a `.cttpl` import leaves one on disk. */
async function installTemplate(userDataDir: string): Promise<void> {
  const doc = templateDocument();
  const ngt = new JSZip();
  ngt.file("project.json", JSON.stringify({ schemaVersion: 2 }));
  ngt.file("timeline.json", JSON.stringify(doc.elements));
  ngt.file("tracks.json", JSON.stringify(doc.tracks));
  ngt.file(
    "renderOptions.json",
    JSON.stringify({ previewSize: { w: W, h: H }, videoDuration: 4, fps: 30 }),
  );
  ngt.file("assetPaths.json", JSON.stringify({ version: 1, entries: {} }));
  const dir = path.join(userDataDir, "templates", "graded");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "template.ngt"),
    await ngt.generateAsync({ type: "nodebuffer" }),
  );
  fs.writeFileSync(path.join(dir, "template.json"), JSON.stringify({ name: "Graded" }));
}

async function entryIn(file: string, name: string): Promise<any> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const entry = zip.file(name);
  return entry ? JSON.parse(await entry.async("string")) : null;
}

test("a template's own timeline: expand, edit, switch, save, reopen", async ({
  session,
  artifactDir,
}) => {
  const { page, answerSaveDialog, answerOpenDialog } = session;
  const tabs = page.locator("timeline-tabs .tb-tab");
  const projectFile = path.join(artifactDir, "templates.ngt");
  const savedTemplate = path.join(artifactDir, "Graded Edit.cttpl");

  /** The store's state the steps below assert on. */
  const state = () =>
    page.evaluate(() => {
      const C = (globalThis as any).CARTCUT;
      const s = C.useTimelineStore.getState();
      const main = s.activeTimelineId === "main" ? s.timeline : s.parked.main.elements;
      const clip: any = Object.values(main).find((e: any) => e.filetype === "template");
      return {
        active: s.activeTimelineId,
        compositions: Object.keys(s.compositions),
        frame: C.renderOptionStore.getState().options.previewSize,
        clipTemplateId: clip?.templateId ?? null,
        clipDuration: clip?.duration ?? null,
        historyLength: s.history.timelineHistory.length,
      };
    });

  /**
   * Main's composite at 0.5s through the exporter's renderer, sampled left
   * and right of centre. `fx: false` draws it with no effects runtime, the
   * way a template's contents were drawn before this work.
   */
  const composite = (fx = true) =>
    page.evaluate((withFx) => {
      const C = (globalThis as any).CARTCUT;
      const s = C.useTimelineStore.getState();
      const main = s.activeTimelineId === "main" ? s.timeline : s.parked.main.elements;
      const o = C.renderOptionStore.getState().options;
      const frame = C.projectSnapshot().options.previewSize;
      const canvas = document.createElement("canvas");
      canvas.width = frame.w;
      canvas.height = frame.h;
      const ctx = canvas.getContext("2d")!;
      C.renderTimelineAtTime(
        ctx,
        main,
        500,
        C.exportElementRenderers,
        o.backgroundColor,
        frame.w,
        frame.h,
        undefined,
        undefined,
        withFx ? C.createExportFxRuntime(o.fps) : null,
      );
      const at = (x: number) => [...ctx.getImageData(x, frame.h / 2, 1, 1).data];
      return { left: at(frame.w * 0.2), right: at(frame.w * 0.8) };
    }, fx);

  let projectFrame = { w: 0, h: 0 };

  await test.step("place the template", async () => {
    await installTemplate(session.userDataDir);
    const placed = await page.evaluate(async () => {
      const C = (globalThis as any).CARTCUT;
      await C.refreshTemplateLibrary();
      return C.addTemplateToTimeline("graded", { startMs: 0 });
    });
    expect(placed.ok).toBe(true);
    projectFrame = (await state()).frame;
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toHaveClass(/is-on/);
  });

  await test.step("expand it from the clip's context menu", async () => {
    await page.evaluate(() => {
      const C = (globalThis as any).CARTCUT;
      const id = Object.keys(C.useTimelineStore.getState().timeline)[0];
      const canvas: any = document.querySelector("element-timeline-canvas");
      canvas.targetIdDuringRightClick = [id];
      canvas.showMenuDropdown({ x: 400, y: 600 });
    });
    await page
      .locator('#menuRightClick menu-dropdown-item[item-name="Expand Template"]')
      .click();

    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveClass(/is-on/);
    await expect(tabs.nth(1)).toContainText("Graded");
    const now = await state();
    expect(now.active).not.toBe("main");
    expect(now.clipTemplateId).toBe(`project:${now.active}`);
    expect(now.frame).toEqual({ w: W, h: H });
  });

  await test.step("main's picture carries the template's own effect", async () => {
    const drawn = await composite();
    expect(drawn.left).toEqual([0, 255, 255, 255]);
    // The harness measures something: with no runtime the frame stays red.
    expect((await composite(false)).left).toEqual([255, 0, 0, 255]);
  });

  await test.step("an edit in the template's tab reaches main in one step", async () => {
    const before = await state();
    await page.evaluate(() => {
      const C = (globalThis as any).CARTCUT;
      C.useTimelineStore.getState().withCheckpoint((doc: any) => {
        const bg: any = Object.entries(doc.elements).find(
          ([, e]: any) => e.filetype === "shape",
        );
        const [id, element] = bg;
        const half = element.width / 2;
        return {
          ...doc,
          elements: {
            ...doc.elements,
            [id]: {
              ...element,
              width: half,
              oWidth: half,
              shape: [
                [0, 0],
                [half, 0],
                [half, element.height],
                [0, element.height],
              ],
              duration: 6000,
            },
          },
        };
      });
    });
    expect((await state()).historyLength).toBe(before.historyLength + 1);

    await tabs.first().click();
    await expect(tabs.first()).toHaveClass(/is-on/);
    const now = await state();
    expect(now.active).toBe("main");
    expect(now.frame).toEqual(projectFrame);
    expect(now.clipDuration).toBe(6000);
    const drawn = await composite();
    expect(drawn.left).toEqual([0, 255, 255, 255]);
    expect(drawn.right).not.toEqual([0, 255, 255, 255]);
  });

  await test.step("one undo from main takes the template edit back", async () => {
    await page.evaluate(() => (globalThis as any).CARTCUT.editorActions.undo());
    expect((await state()).clipDuration).toBe(4000);
    expect((await state()).active).toBe("main");
    await page.evaluate(() => (globalThis as any).CARTCUT.editorActions.redo());
    expect((await state()).clipDuration).toBe(6000);
  });

  await test.step("save it from the template's tab", async () => {
    await tabs.nth(1).click();
    await answerSaveDialog(projectFile);
    const saved = await page.evaluate(() => (globalThis as any).CARTCUT.project.save());
    expect(saved.ok).toBe(true);

    expect(await entryIn(projectFile, "project.json")).toEqual({ schemaVersion: 4 });
    const owned = await entryIn(projectFile, "compositions.json");
    expect(owned.compositions).toHaveLength(1);
    expect(owned.compositions[0].size).toEqual({ w: W, h: H });
    // The project's own frame and main's document, though a template showed.
    expect((await entryIn(projectFile, "renderOptions.json")).previewSize).toEqual(projectFrame);
    const timeline = await entryIn(projectFile, "timeline.json");
    expect(Object.values<any>(timeline).map((e) => e.filetype)).toEqual(["template"]);
  });

  await test.step("open it again, from a template's tab", async () => {
    await answerOpenDialog([projectFile]);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.openProjectFile());
    await expect.poll(async () => (await state()).active).toBe("main");
    const now = await state();
    expect(now.frame).toEqual(projectFrame);
    expect(now.compositions).toHaveLength(1);
    expect(now.clipDuration).toBe(6000);
    await expect(tabs).toHaveCount(1);
    const drawn = await composite();
    expect(drawn.left).toEqual([0, 255, 255, 255]);
    expect(drawn.right).not.toEqual([0, 255, 255, 255]);
  });

  await test.step("save the template to the library from its tab", async () => {
    await page.evaluate(async () => {
      const C = (globalThis as any).CARTCUT;
      const id = Object.keys(C.useTimelineStore.getState().timeline)[0];
      await C.expandTemplate(id);
    });
    await expect(tabs).toHaveCount(2);
    await tabs.nth(1).click({ button: "right" });
    await answerSaveDialog(savedTemplate);
    await page
      .locator('#menuRightClick menu-dropdown-item[item-name="Save as Template…"]')
      .click();
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (globalThis as any).CARTCUT.installedTemplates().map((t: any) => t.name),
          ),
        { timeout: 30_000 },
      )
      .toContain("Graded Edit");
    expect(fs.existsSync(savedTemplate)).toBe(true);
  });
});
