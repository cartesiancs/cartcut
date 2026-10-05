/**
 * HTML graphics in the live preview, under a seeded stress run.
 *
 * The preview draws an HTML graphic from a raster made ahead of the frame, so
 * every way it can go wrong is a race, and each showed up only sometimes: the
 * first frame of a clip drew nothing or the end of its previous pass, a
 * template's graphic never drew at all, and after an export or a contact sheet
 * the paused preview showed whatever moment those had rasterised last.
 *
 * So this does not script one path. It builds a project that has every shape
 * of the problem (adjacent clips, overlapping clips, a split title, a template
 * holding a graphic, a video underneath) and then runs a seeded sequence of
 * what a person and an agent do to it: play from anywhere, seek, scrub, take
 * contact sheets, edit text, split, undo, move clips, hover a preset tile while
 * playing, and export once. After every step it judges what the preview drew,
 * through `harness/graphicProbe.ts`, which reads no app module:
 *
 *  - every frame of playback draws every visible graphic, within a few frames
 *    of its own time;
 *  - once things settle, the preview shows every visible graphic at exactly
 *    its frame;
 *  - a contact sheet leaves no host canvas behind.
 *
 * `CARTCUT_E2E_GRAPHIC_SEEDS=1,2,3` and `CARTCUT_E2E_GRAPHIC_OPS=80` widen it.
 * With the lookahead and the template sweep taken out of `graphicPipeline.ts`,
 * seed 1 reports 451 bad frames out of 1,958 checked; with them in, none.
 */

import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import { test, expect } from "../harness/test";
import { agent } from "../harness/agent";
import { runExport } from "../harness/export";
import {
  discardFrames,
  frameMs,
  installGraphicProbe,
  judgePlayback,
  judgeSettled,
  probeHealth,
  registerTemplate,
  type GraphicFailure,
} from "../harness/graphicProbe";

const SEEDS = (process.env.CARTCUT_E2E_GRAPHIC_SEEDS ?? "1").split(",").map(Number);
const OPS = Number(process.env.CARTCUT_E2E_GRAPHIC_OPS ?? 40);

const GRAPHICS: Array<[string, number, number]> = [
  ["rise-in-out", 1000, 1000],
  ["typewriter-caret", 2000, 1000],
  ["scatter-in", 3000, 1000],
  ["wipe-reveal", 3500, 1000],
  ["flip-3d", 5000, 1000],
  ["draw-on", 6000, 500],
  ["glitch", 8500, 1000],
  ["counter", 9500, 500],
];
const TEMPLATE_AT = 6500;

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)],
  };
}

/** The one graphic a `.cttpl` holds: the archive nests a `.ngt`. */
async function innerKeyOf(templateFile: string): Promise<string> {
  const outer = await JSZip.loadAsync(fs.readFileSync(templateFile));
  const ngt = await JSZip.loadAsync(await outer.file("template.ngt")!.async("nodebuffer"));
  const timeline = JSON.parse(await ngt.file("timeline.json")!.async("string"));
  return Object.keys(timeline)[0];
}

for (const seed of SEEDS) {
  test(`html graphics hold up in the preview under stress, seed ${seed}`, async ({ session, fixtures, artifactDir }) => {
    test.setTimeout(20 * 60_000);
    const { page } = session;
    const R = rng(seed);
    const ev = <T>(fn: string) => page.evaluate(fn) as Promise<T>;

    await installGraphicProbe(page);
    const FRAME = await frameMs(page);

    // A template holding one graphic, made and installed the way a user does.
    const templateFile = path.join(artifactDir, "GraphicTpl.cttpl");
    const seedGraphic = await agent<any>(session, "add_graphic", {
      presetId: "com.cartcut.graphic.rise-in-out",
      startMs: 0,
      durationMs: 2000,
      params: { text: "Inside a template" },
    });
    await session.answerSaveDialog(templateFile);
    await ev(`document.querySelector("control-ui-util")._handleClickExportTemplate()`);
    expect(fs.existsSync(templateFile)).toBe(true);
    const innerKey = await innerKeyOf(templateFile);
    await agent(session, "delete_clips", { elementIds: seedGraphic.created });

    // The project: a video under adjacent, overlapping and split graphics.
    await agent(session, "add_media", { items: [{ path: fixtures.video[0].path, startMs: 0 }] });
    const ids: Record<string, string> = {};
    for (const [preset, startMs, durationMs] of GRAPHICS) {
      const added = await agent<any>(session, "add_graphic", { presetId: `com.cartcut.graphic.${preset}`, startMs, durationMs });
      ids[preset] = added.created[0];
    }
    await agent(session, "split_clip", { elementId: ids["rise-in-out"], atMs: [1500] });

    await session.answerOpenDialog([templateFile]);
    const templateId = await ev<string>(`(async () => {
      document.querySelector('[data-bs-target="#nav-template"]').click();
      await new Promise((r) => setTimeout(r, 400));
      const browser = document.querySelector("template-browser");
      await browser.handleImport();
      await new Promise((r) => setTimeout(r, 600));
      const listing = browser.templates.find((t) => /GraphicTpl/i.test(t.name));
      window.CARTCUT.useTimelineStore.getState().setCursor(${TEMPLATE_AT});
      await new Promise((r) => setTimeout(r, 200));
      await browser.handleAdd(listing);
      await new Promise((r) => setTimeout(r, 300));
      const placed = Object.values(window.CARTCUT.useTimelineStore.getState().timeline).find((e) => e.filetype === "template");
      return placed.templateId;
    })()`);
    await registerTemplate(page, templateId, { key: innerKey, start: 0, duration: 2000 });

    const graphicIds = () =>
      ev<Array<{ id: string; start: number; dur: number }>>(
        `Object.entries(window.CARTCUT.useTimelineStore.getState().timeline).filter(([, e]) => e.filetype === "graphic").map(([id, e]) => ({ id, start: e.startTime, dur: e.duration }))`,
      );
    const setCursor = (ms: number) => ev(`window.CARTCUT.useTimelineStore.getState().setCursor(${ms})`);
    const hostCount = () => ev<number>(`document.querySelectorAll("canvas[data-graphic-host]").length`);

    const log: Array<{ step: number; name: string; args: unknown; checked: number; bad: GraphicFailure[]; extra?: unknown }> = [];
    const record = (name: string, args: unknown, result: { checked: number; bad: GraphicFailure[] }, extra?: unknown) => {
      log.push({ step: log.length + 1, name, args, checked: result.checked, bad: result.bad, extra });
    };

    // The Graphics tab paints all its tiles the first time it opens, a burst
    // of cold mounts and font loads on the main thread that delays the next
    // few preview frames whatever the preview does. Opened once here, so the
    // hover step below measures a tile animating during playback, which is
    // what it is for, and not that one-off burst.
    const tilesReady = await ev<boolean>(`(async () => {
      document.querySelector('[data-bs-target="#nav-fx"]').click();
      await new Promise((r) => setTimeout(r, 100));
      [...document.querySelectorAll("#nav-fx button")].find((b) => b.textContent.includes("Graphics"))?.click();
      const inked = (c) => { const x = document.createElement("canvas"); x.width = 16; x.height = 8; const g = x.getContext("2d"); g.drawImage(c, 0, 0, 16, 8); return g.getImageData(0, 0, 16, 8).data.some((v, i) => i % 4 === 3 && v > 0); };
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const tiles = [...document.querySelectorAll("#nav-fx canvas[data-preset]")].filter((c) => c.offsetParent != null);
        if (tiles.length > 0 && tiles.every(inked)) return true;
      }
      return false;
    })()`);
    expect(tilesReady, "the Graphics tab painted its tiles").toBe(true);

    await setCursor(0);
    record("start", {}, await judgeSettled(page));

    const exportAt = R.int(Math.floor(OPS / 3), Math.floor((2 * OPS) / 3));
    for (let i = 0; i < OPS; i++) {
      if (i === exportAt) {
        const outcome = await runExport(session, { destination: path.join(artifactDir, "export.mp4") });
        expect(outcome.status).toBe("finished");
        record("export", { ms: outcome.elapsedMs }, await judgeSettled(page));
        continue;
      }
      const roll = R.next();
      if (roll < 0.3) {
        const from = R.int(0, 9200);
        const ms = R.int(500, 2500);
        const hover = R.next() < 0.3;
        const tile = R.int(0, 27);
        await setCursor(from);
        record("play-start", { from }, await judgeSettled(page));
        if (hover) {
          await ev(`(async () => {
            document.querySelector('[data-bs-target="#nav-fx"]').click();
            await new Promise((r) => setTimeout(r, 100));
            [...document.querySelectorAll("#nav-fx button")].find((b) => b.textContent.includes("Graphics"))?.click();
            await new Promise((r) => setTimeout(r, 100));
            const tiles = [...document.querySelectorAll("#nav-fx canvas[data-preset]")].filter((c) => c.offsetParent != null);
            window.__hoveredTile = tiles[${tile} % Math.max(1, tiles.length)];
            for (let e = window.__hoveredTile; e && e !== document.body; e = e.parentElement) e.dispatchEvent(new MouseEvent("mouseenter"));
          })()`);
        }
        await discardFrames(page);
        await ev(`document.querySelector("timeline-ui").play()`);
        await page.waitForTimeout(ms);
        await ev(`document.querySelector("timeline-ui").stop()`);
        if (hover) {
          await ev(`(() => { for (let e = window.__hoveredTile; e && e !== document.body; e = e.parentElement) e.dispatchEvent(new MouseEvent("mouseleave")); })()`);
        }
        // Six frames: playback draws the newest raster, which may trail by a
        // frame or two under load; a missed entry trails by a whole clip.
        const played = await judgePlayback(page, 6 * FRAME);
        record("play", { from, ms, hover }, played, { lag: played.lag });
        record("play-end", {}, await judgeSettled(page));
      } else if (roll < 0.45) {
        const at = R.int(0, 10000);
        await setCursor(at);
        record("seek", { at }, await judgeSettled(page));
      } else if (roll < 0.55) {
        const route = Array.from({ length: R.int(8, 30) }, () => R.int(0, 10000));
        const gap = R.int(5, 30);
        await ev(`(async () => { for (const c of ${JSON.stringify(route)}) { window.CARTCUT.useTimelineStore.getState().setCursor(c); await new Promise((r) => setTimeout(r, ${gap})); } })()`);
        record("scrub", { end: route[route.length - 1] }, await judgeSettled(page));
      } else if (roll < 0.72) {
        const atMs = Array.from({ length: R.int(1, 4) }, () => R.int(0, 9999)).sort((a, b) => a - b);
        const before = await hostCount();
        await agent(session, "render_contact_sheet", { atMs }, 120_000);
        const after = await hostCount();
        record("sheet", { atMs }, await judgeSettled(page), { hostsBefore: before, hostsAfter: after });
        expect(after, "a contact sheet leaves no host canvas behind").toBeLessThanOrEqual(before);
      } else if (roll < 0.82) {
        const g = R.pick(await graphicIds());
        const text = `${R.pick(["Hello", "Stress test", "One two three", "A"])} ${R.int(0, 999)}`;
        await agent(session, "set_graphic", { elementId: g.id, params: { text } });
        record("edit", { id: g.id, text }, await judgeSettled(page));
      } else if (roll < 0.9) {
        const all = await graphicIds();
        const g = R.pick(all);
        const frames = Math.floor(g.dur / FRAME);
        if (all.length < 16 && frames >= 4) {
          const at = Math.round(g.start + R.int(1, frames - 1) * FRAME);
          await agent(session, "split_clip", { elementId: g.id, atMs: [at] });
          await setCursor(at);
          record("split", { id: g.id, at }, await judgeSettled(page));
        } else {
          await agent(session, "undo", {});
          record("undo", {}, await judgeSettled(page));
        }
      } else {
        const g = R.pick(await graphicIds());
        const deltaMs = R.pick([-500, -250, 250, 500]);
        await agent(session, "move_clips", { elementIds: [g.id], deltaMs }).catch(() => undefined);
        await setCursor(Math.max(0, g.start + deltaMs + 100));
        record("move", { id: g.id, deltaMs }, await judgeSettled(page));
      }
    }

    const health = await probeHealth(page);
    const checked = log.reduce((sum, step) => sum + step.checked, 0);
    const failures = log.flatMap((step) => step.bad.map((b) => ({ step: step.step, op: step.name, ...b })));
    fs.writeFileSync(path.join(artifactDir, "graphic-stress.json"), JSON.stringify({ seed, ops: OPS, checked, health, log }, null, 1));

    expect(checked).toBeGreaterThan(OPS * 5);
    expect(failures.slice(0, 20)).toEqual([]);
    expect(health.drawElementImageThrows).toBe(0);
    expect(health.paintsNeverCame).toBe(0);
  });
}
