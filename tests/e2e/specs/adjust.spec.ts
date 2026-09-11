/**
 * Colour adjustments, end to end, against arithmetic restated in this file.
 *
 * Built like `lut.spec.ts`, and for its reason: `harness/reference.ts` drives
 * the same `renderTimelineAtTime` the export does, so comparing the two proves
 * only that they are consistent. So the scene is **solid-colour shapes** — no
 * decoder and no codec on the way in — and every expected colour is computed
 * here, from formulas short enough to restate honestly. Nothing is imported
 * from `apps/app/src`: an expectation that shared `tone.ts` with the thing it
 * checks would agree with it whether or not either was right.
 *
 * ## What it covers that the vitest suites cannot
 *
 *  - the **shaders that ship**: the tone half runs through the LUT GLSL and the
 *    finish half through `renderer/adjust/glsl.ts`, and node has no WebGL, so
 *    `adjustComposite.test.ts` drives the CPU appliers only;
 *  - the preview and the export finish identically, grain included;
 *  - the field round-trips through the agent surface and a real `.ngt`,
 *    sparse, with an unadjusted clip carrying no key at all;
 *  - the adjusted picture survives the real Render button, FFmpeg and a decode.
 */

import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import { test, expect } from "../harness/test";
import { agent, listClips } from "../harness/agent";
import { runExport } from "../harness/export";
import { decodeFrames } from "../harness/decode";
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

/** Off-neutral and off-primary, as in `lut.spec.ts`: a grey hides a channel swap. */
const SOURCE = { r: 0x4d, g: 0x8f, b: 0xc4 };
const GREY = { r: 0x80, g: 0x80, b: 0x80 };

const hex = (c: { r: number; g: number; b: number }) =>
  `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

// ---------------------------------------------------------------- the oracle

type Rgb = [number, number, number];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const luma = (c: Rgb) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

/**
 * One slider per patch, each chosen because its whole effect fits on a line.
 *
 * Exposure is a gain on light through a pure 2.2 power, so on the signal it is
 * a multiply by `gain^(1/2.2)` — `+50` is one stop. Contrast at −100 halves
 * every distance from mid grey. Saturation at −100 is Rec.709 luma. Fade at
 * 100 lifts black to 0.16, pulls white down by 0.06 and keeps 80% of the colour.
 */
const PATCHES: Record<
  string,
  { adjust: Record<string, number>; f: (c: Rgb) => Rgb }
> = {
  "exposure+50": {
    adjust: { exposure: 50 },
    f: (c) => c.map((v) => clamp01(v * Math.pow(2, 1 / 2.2))) as Rgb,
  },
  "exposure-100": {
    adjust: { exposure: -100 },
    f: (c) => c.map((v) => v * Math.pow(0.25, 1 / 2.2)) as Rgb,
  },
  "contrast-100": {
    adjust: { contrast: -100 },
    f: (c) => c.map((v) => (v - 0.5) * 0.5 + 0.5) as Rgb,
  },
  "saturation-100": {
    adjust: { saturation: -100 },
    f: (c) => {
      const l = luma(c);
      return [l, l, l];
    },
  },
  "fade+100": {
    adjust: { fade: 100 },
    f: (c) => {
      const lifted = c.map((v) => 0.16 + v * (1 - 0.16 - 0.06)) as Rgb;
      const l = luma(lifted);
      return lifted.map((v) => l + (v - l) * 0.8) as Rgb;
    },
  },
};

const CASES = Object.keys(PATCHES);

const PATCH_W = Math.floor(WIDTH / CASES.length);
const PATCH_Y = 20;
const PATCH_H = 150;

const probePoint = (i: number) => ({
  x: i * PATCH_W + Math.floor(PATCH_W / 2),
  y: PATCH_Y + Math.floor(PATCH_H / 2),
});

function expected(slug: string): { r: number; g: number; b: number } {
  const out = PATCHES[slug].f([SOURCE.r / 255, SOURCE.g / 255, SOURCE.b / 255]);
  return {
    r: Math.round(out[0] * 255),
    g: Math.round(out[1] * 255),
    b: Math.round(out[2] * 255),
  };
}

/** The second row: three larger grey patches for the spatial stages. */
const VIGNETTE = { x: 20, y: 200, width: 200, height: 140 };
const FLAT = { x: 240, y: 200, width: 160, height: 140 };
const GRAIN = { x: 420, y: 200, width: 200, height: 140 };

/**
 * Vignette at a point in the clip, restated: each axis normalised to its own
 * side, radius scaled so a corner is 1, a smoothstep from 0.35 to 1.05, and at
 * +100 three quarters of that taken off the colour.
 */
function vignetted(value: number, u: number, v: number): number {
  const x = (u - 0.5) * 2;
  const y = (v - 0.5) * 2;
  const r = Math.sqrt((x * x + y * y) / 2);
  const t = clamp01((r - 0.35) / (1.05 - 0.35));
  const weight = t * t * (3 - 2 * t);
  return Math.round(value * (1 - weight * 0.75));
}

/**
 * With no codec between them: the half-float table, the tetrahedral fetch and
 * the two appliers' rounding of a tie. Three steps, one more than `lut.spec.ts`
 * allows, for the baked table's own step.
 */
const GPU_TOLERANCE = 3;

/** After H.264 4:2:0 on large flat patches, as `lut.spec.ts` measured. */
const CHANNEL_TOLERANCE = 8;

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
    throw new Error(`add_shape did not report an id: ${JSON.stringify(created).slice(0, 300)}`);
  }
  return id;
}

function near(
  got: { r: number; g: number; b: number },
  want: { r: number; g: number; b: number },
  tolerance: number,
): boolean {
  return (
    Math.abs(got.r - want.r) <= tolerance &&
    Math.abs(got.g - want.g) <= tolerance &&
    Math.abs(got.b - want.b) <= tolerance
  );
}

/** Mean and standard deviation of red over a rectangle's interior. */
function stats(frame: FrameBuffer, rect: { x: number; y: number; width: number; height: number }) {
  const values: number[] = [];
  for (let y = rect.y + 10; y < rect.y + rect.height - 10; y += 2) {
    for (let x = rect.x + 10; x < rect.x + rect.width - 10; x += 2) {
      values.push(pixel(frame, x, y).r);
    }
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance), values };
}

test("colour adjustments survive the export, and match the arithmetic", async ({
  session,
  profile,
  artifactDir,
}, testInfo) => {
  test.setTimeout(10 * 60_000);

  const { page } = session;
  const fps = profile.fps;

  const projectDir = path.join(artifactDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const destination = path.join(artifactDir, "adjust.mp4");

  await test.step("configure a short project through the settings panel", async () => {
    await setProjectFolder(session, projectDir);
    await setResolution(page, WIDTH, HEIGHT);
    await setDuration(page, DURATION_SEC);
    await setBackgroundColor(page, "#000000");
    await setFps(page, fps);
    await setExportPreset(page, "low");
  });

  const patchIds: string[] = [];
  let vignetteId = "";
  let flatId = "";
  let grainId = "";
  let plainId = "";

  await test.step("one patch per slider, set through the agent surface", async () => {
    for (const [i, slug] of CASES.entries()) {
      const id = await addShape(session, {
        fillColor: hex(SOURCE),
        x: i * PATCH_W,
        y: PATCH_Y,
        width: PATCH_W,
        height: PATCH_H,
      });
      await agent(session, "set_color_adjustments", {
        elementIds: [id],
        adjustments: PATCHES[slug].adjust,
      });
      patchIds.push(id);
    }

    vignetteId = await addShape(session, { fillColor: hex(GREY), ...VIGNETTE });
    await agent(session, "set_color_adjustments", {
      elementIds: [vignetteId],
      adjustments: { vignette: 100 },
    });

    // Sharpen and clarity on a flat patch: nothing to sharpen inside it, and
    // its border against transparency must not grow a rim.
    flatId = await addShape(session, { fillColor: hex(GREY), ...FLAT });
    await agent(session, "set_color_adjustments", {
      elementIds: [flatId],
      adjustments: { sharpen: 100, clarity: 100 },
    });

    grainId = await addShape(session, { fillColor: hex(GREY), ...GRAIN });
    await agent(session, "set_color_adjustments", {
      elementIds: [grainId],
      adjustments: { particles: 100 },
    });

    // One clip left alone, for the byte-equality assertion in the archive step.
    plainId = await addShape(session, { fillColor: "#101010", x: 0, y: 0, width: 8, height: 8 });
  });

  await test.step("the agent surface reports the adjustments back", async () => {
    const { clips } = await listClips(session);
    const byId = new Map(clips.map((c) => [c.id, c as any]));
    for (const [i, slug] of CASES.entries()) {
      expect(byId.get(patchIds[i])?.adjust, slug).toEqual(PATCHES[slug].adjust);
    }
    expect(byId.get(plainId)?.adjust).toBeUndefined();

    const detail = await agent<any>(session, "get_clip", { elementId: vignetteId });
    const clip = detail?.clip ?? detail;
    expect(clip.adjust).toEqual({ vignette: 100 });
  });

  await test.step("the adjustments reach timeline.json inside the real .ngt, sparse", async () => {
    const file = path.join(artifactDir, "adjust.ngt");
    fs.rmSync(file, { force: true });

    await session.answerSaveDialog(file);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.save());
    await expect.poll(() => fs.existsSync(file), { timeout: 30_000 }).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const elements = JSON.parse(await zip.file("timeline.json")!.async("string"));

    for (const [i, slug] of CASES.entries()) {
      expect(elements[patchIds[i]].adjust, slug).toEqual(PATCHES[slug].adjust);
    }
    expect(elements[grainId].adjust).toEqual({ particles: 100 });
    expect(elements[plainId], "the unadjusted clip is missing").toBeTruthy();
    expect("adjust" in elements[plainId]).toBe(false);

    await agent(session, "delete_clips", { elementIds: [plainId] });
  });

  await test.step("the preview finishes the same way the export does, grain included", async () => {
    await primeAssets(page);
    const times = [0, 1000, 2000];
    const asExport = await renderReferenceFrames(page, times, "export");
    const asPreview = await renderReferenceFrames(page, times, "preview");

    for (const [i, timeMs] of times.entries()) {
      const verdict = judge(
        diffStats(asExport[i].frame, asPreview[i].frame, { x: 0, y: 0, w: WIDTH, h: HEIGHT }),
        DETERMINISM_THRESHOLDS,
        `preview vs export @${timeMs}ms`,
      );
      expect(verdict.failures.join("; ")).toBe("");
    }
    writePng(path.join(artifactDir, "preview-1000ms.png"), asPreview[1].frame);
  });

  await test.step("the shaders that ship land on the arithmetic", async () => {
    const [{ frame }] = await renderReferenceFrames(page, [1000], "export");
    writePng(path.join(artifactDir, "reference-1000ms.png"), frame);

    const tone = CASES.map((slug, i) => {
      const point = probePoint(i);
      const got = pixel(frame, point.x, point.y);
      return { slug, want: expected(slug), got: { r: got.r, g: got.g, b: got.b } };
    });

    const vignette = [
      { u: 0.5, v: 0.5 },
      { u: 0.05, v: 0.05 },
      { u: 0.95, v: 0.5 },
      { u: 0.5, v: 0.1 },
    ].map(({ u, v }) => {
      const x = Math.floor(VIGNETTE.x + u * VIGNETTE.width);
      const y = Math.floor(VIGNETTE.y + v * VIGNETTE.height);
      // The pixel centre, back in the clip's own 0-1.
      const uc = (x + 0.5 - VIGNETTE.x) / VIGNETTE.width;
      const vc = (y + 0.5 - VIGNETTE.y) / VIGNETTE.height;
      const want = vignetted(GREY.r, uc, vc);
      return { u, v, want: { r: want, g: want, b: want }, got: pixel(frame, x, y) };
    });

    const flatPoints = [
      [FLAT.x + FLAT.width / 2, FLAT.y + FLAT.height / 2],
      [FLAT.x, FLAT.y + FLAT.height / 2],
      [FLAT.x + FLAT.width - 1, FLAT.y + FLAT.height / 2],
      [FLAT.x + FLAT.width / 2, FLAT.y],
    ].map(([x, y]) => ({ x, y, got: pixel(frame, Math.floor(x), Math.floor(y)) }));

    writeJson(path.join(artifactDir, "gpu-readings.json"), { tone, vignette, flatPoints });

    expect(
      tone
        .filter((r) => !near(r.got, r.want, GPU_TOLERANCE))
        .map((r) => `${r.slug}: want ${JSON.stringify(r.want)} got ${JSON.stringify(r.got)}`),
    ).toEqual([]);
    expect(
      vignette
        .filter((r) => !near(r.got, r.want, GPU_TOLERANCE))
        .map((r) => `(${r.u}, ${r.v}): want ${r.want.r} got ${r.got.r}`),
    ).toEqual([]);
    // Flat inside and no rim at the border — the premultiplied taps.
    expect(
      flatPoints
        .filter((p) => !near(p.got, GREY, GPU_TOLERANCE))
        .map((p) => `(${p.x}, ${p.y}): got ${JSON.stringify(p.got)}`),
    ).toEqual([]);
    // Outside the vignetted clip the frame shows through untouched.
    expect(pixel(frame, VIGNETTE.x - 5, VIGNETTE.y + 20)).toMatchObject({ r: 0, g: 0, b: 0 });

    // The anti-tautology guard: the five sliders really did five different things.
    expect(new Set(tone.map((r) => `${r.got.r >> 2},${r.got.g >> 2},${r.got.b >> 2}`)).size).toBe(
      CASES.length,
    );
  });

  await test.step("grain moves the pixels, not the picture, and re-rolls per frame", async () => {
    const [a, again, b] = await renderReferenceFrames(page, [1000, 1000, 2000], "export");
    const first = stats(a.frame, GRAIN);
    expect(Math.abs(first.mean - GREY.r), "grain shifted the average").toBeLessThan(3);
    expect(first.std, "grain did nothing").toBeGreaterThan(3);
    expect(first.std, "grain is far too strong").toBeLessThan(30);

    expect(stats(again.frame, GRAIN).values).toEqual(first.values);
    expect(stats(b.frame, GRAIN).values).not.toEqual(first.values);
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

  await test.step("every patch carries the colour the arithmetic predicts", async () => {
    const frameIndex = Math.floor(fps * 1.5);
    const decoded = await decodeFrames(destination, [frameIndex], WIDTH, HEIGHT);
    const frame: FrameBuffer = { data: decoded.frames[0], width: WIDTH, height: HEIGHT };
    writePng(path.join(artifactDir, "decoded.png"), frame);

    const readings = CASES.map((slug, i) => {
      const point = probePoint(i);
      const got = pixel(frame, point.x, point.y);
      return { slug, want: expected(slug), got: { r: got.r, g: got.g, b: got.b } };
    });
    writeJson(path.join(artifactDir, "readings.json"), readings);

    expect(
      readings
        .filter((r) => !near(r.got, r.want, CHANNEL_TOLERANCE))
        .map((r) => `${r.slug}: want ${JSON.stringify(r.want)} got ${JSON.stringify(r.got)}`),
    ).toEqual([]);

    const centre = pixel(
      frame,
      VIGNETTE.x + VIGNETTE.width / 2,
      VIGNETTE.y + VIGNETTE.height / 2,
    ).r;
    const corner = pixel(frame, VIGNETTE.x + 10, VIGNETTE.y + 7).r;
    expect(Math.abs(centre - GREY.r)).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
    expect(corner).toBeLessThan(centre - 40);
  });
});
