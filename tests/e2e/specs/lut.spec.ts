/**
 * Colour LUTs, end to end, against arithmetic rather than against a
 * reference render.
 *
 * Built on `blend.spec.ts` and for the same reason: `harness/reference.ts`
 * drives the same `renderTimelineAtTime` the export does, so comparing the two
 * proves the export path is *consistent* and says nothing about whether a LUT
 * grades correctly. So the scene is **solid-colour shapes** — no decoder, no
 * codec on the way in — and every expected colour is computed in this file.
 *
 * ## Which LUTs, and why those
 *
 * The six shipped `utility` LUTs, because each is a formula short enough to
 * restate here honestly. "Teal & Orange" is the better demonstration and the
 * worse test: checking it would mean importing `colorMath.ts`, at which point
 * the LUT and its expectation share an idea of what the grade is and a wrong
 * one would agree with itself.
 *
 * What that leaves is the thing actually under test: whether a table on disk,
 * uploaded to a texture, sampled tetrahedrally in GLSL, composited, piped to
 * FFmpeg and decoded back still produces the number the recipe said. The
 * transfer functions in `FORMULA` below are the sRGB EOTF pair and four lines
 * of arithmetic.
 *
 * ## What it covers that the vitest suites cannot
 *
 *  - a LUT survives the whole pipeline — the real Render button, the raw
 *    frame pipe, FFmpeg, H.264 and the decode back;
 *  - the **GPU** applier agrees with the CPU one, which is the only place that
 *    is checkable at all: `renderer/lutComposite.test.ts` drives the CPU path
 *    because node has no WebGL, and `lut/glsl.test.ts` pins the shader's
 *    arithmetic but cannot run it;
 *  - the preview and the export grade identically;
 *  - the field round-trips through the store, the agent surface and a real
 *    `.ngt`;
 *  - an **adjustment layer** grades what is beneath it and not what is above;
 *  - a LUT the *user* installed is scanned, validated and graded like any other.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import { test, expect } from "../harness/test";
import { agent, listClips } from "../harness/agent";
import { runExport } from "../harness/export";
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
import { FFMPEG } from "../harness/paths";
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

/**
 * The colour every patch starts as.
 *
 * Off-neutral and off-primary on purpose: a grey would hide a channel swap, and
 * a saturated primary sits on the edge of the cube where several of these
 * grades clip and stop being distinguishable.
 */
const SOURCE = { r: 0x4d, g: 0x8f, b: 0xc4 };

const hex = (c: { r: number; g: number; b: number }) =>
  `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

// ---------------------------------------------------------------- the oracle

/** sRGB EOTF, restated here so this file owes `colorMath.ts` nothing. */
const toLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
const toSrgb = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * What each shipped `utility` LUT does, per channel on 0-1 floats.
 *
 * Each is the whole recipe from `features/lut/recipes.ts`, written out. They
 * are short enough to restate exactly, which is the property that made them the
 * ones this spec uses.
 */
const FORMULA: Record<string, (c: [number, number, number]) => [number, number, number]> =
  {
    // `steps: []`.
    identity: (c) => c,
    // `exposure(0.67)` — a gain on *light*, so through linear and back.
    "exposure-plus": (c) =>
      c.map((v) => clamp01(toSrgb(toLinear(v) * Math.pow(2, 0.67)))) as [
        number,
        number,
        number,
      ],
    "exposure-minus": (c) =>
      c.map((v) => clamp01(toSrgb(toLinear(v) * Math.pow(2, -0.67)))) as [
        number,
        number,
        number,
      ],
    // `contrast(0.78)`, whose pivot is `colorMath.ts`'s default of 0.435.
    "contrast-minus": (c) =>
      c.map((v) => clamp01((v - 0.435) * 0.78 + 0.435)) as [number, number, number],
    // `asc(slope 219/255, offset 16/255, power 1)`.
    "rec709-legal": (c) =>
      c.map((v) => clamp01(v * ((235 - 16) / 255) + 16 / 255)) as [
        number,
        number,
        number,
      ],
    // `monoMix([0.2126, 0.7152, 0.0722])`, weights already summing to one.
    "mono-neutral": (c) => {
      const l = clamp01(c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722);
      return [l, l, l];
    },
  };

const CASES = Object.keys(FORMULA);

const PATCH_W = Math.floor(WIDTH / CASES.length);
const PATCH_Y = Math.floor(HEIGHT * 0.3);
const PATCH_H = Math.floor(HEIGHT * 0.4);

const probePoint = (i: number) => ({
  x: i * PATCH_W + Math.floor(PATCH_W / 2),
  y: PATCH_Y + Math.floor(PATCH_H / 2),
});

const lutId = (slug: string) => `com.cartcut.lut.${slug}`;

/** What patch `i` must come out as, on 0-255 bytes. */
function expected(
  slug: string,
  source = SOURCE,
  amount = 1,
): { r: number; g: number; b: number } {
  const input: [number, number, number] = [
    source.r / 255,
    source.g / 255,
    source.b / 255,
  ];
  const graded = FORMULA[slug](input);
  const mixed = graded.map((v, i) => input[i] * (1 - amount) + v * amount);
  return {
    r: Math.round(mixed[0] * 255),
    g: Math.round(mixed[1] * 255),
    b: Math.round(mixed[2] * 255),
  };
}

/**
 * H.264 4:2:0 moves a saturated edge around; the patches are large and flat.
 *
 * Set from what the run actually measures rather than from what seemed safe.
 * Through a 17³ table, the GPU's tetrahedral fetch, the raw frame pipe, an
 * H.264 encode and a decode back, every one of these six lands **within one
 * 8-bit step** of the arithmetic above — the readings are attached as
 * `readings.json`. Eight leaves room for a different encoder preset without
 * leaving room for a LUT that is quietly wrong.
 */
const CHANNEL_TOLERANCE = 8;

/**
 * How far the GPU may sit from ffmpeg's `lut3d`, with no codec between them.
 *
 * Much tighter than `CHANNEL_TOLERANCE`, because there is nothing here to be
 * loose about: both sides read the same table and quantise to the same byte.
 * Two steps covers the shader's half-float table precision and the two
 * implementations' different rounding of a tie, and nothing else.
 */
const GPU_TOLERANCE = 2;

/** The repository root, from this spec's own location. */
const REPO_ROOT_FROM_SPEC = path.resolve(__dirname, "../../..");

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
    throw new Error(
      `add_shape did not report an id: ${JSON.stringify(created).slice(0, 300)}`,
    );
  }
  return id;
}

/**
 * A `.cube` written by hand, in the file's own byte order.
 *
 * Used for the imported-LUT step. It swaps red and blue, which is a change no
 * rounding, no codec and no accidental pass-through could produce.
 */
function swapCube(): string {
  const size = 2;
  const rows: string[] = ['TITLE "E2E Swap"', `LUT_3D_SIZE ${size}`, ""];
  // Red varies fastest — the single most consequential fact about the format,
  // written out here rather than generated so this file states it independently.
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        rows.push(`${b} ${g} ${r}`);
      }
    }
  }
  return `${rows.join("\n")}\n`;
}

test("colour LUTs survive the export, and match the preview", async ({
  session,
  profile,
  artifactDir,
}, testInfo) => {
  test.setTimeout(10 * 60_000);

  const { page } = session;
  const fps = profile.fps;

  const projectDir = path.join(artifactDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const destination = path.join(artifactDir, "lut.mp4");

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

  const patchIds: string[] = [];
  let ungradedId = "";

  await test.step("one patch per LUT, each graded through the agent surface", async () => {
    for (const [i, slug] of CASES.entries()) {
      const id = await addShape(session, {
        fillColor: hex(SOURCE),
        x: i * PATCH_W,
        y: PATCH_Y,
        width: PATCH_W,
        height: PATCH_H,
      });
      // `identity` is applied like the rest rather than skipped: a LUT that
      // provably changes nothing is the sharpest check there is that the
      // machinery around it is not changing something on its own.
      await agent(session, "set_lut", {
        elementIds: [id],
        presetId: lutId(slug),
      });
      patchIds.push(id);
    }

    // One clip left ungraded, for the byte-equality assertion in the archive
    // step. Created here rather than there so the whole spec needs exactly one
    // save: `project.save()` remembers its path, so a second call opens no
    // dialog, and a queued answer nobody consumes is taken by the *export*'s
    // dialog instead — which writes the mp4 to the `.ngt` path and fails a
    // hundred lines later with nothing pointing at the cause.
    ungradedId = await addShape(session, {
      fillColor: "#101010",
      x: 0,
      y: 0,
      width: 8,
      height: 8,
    });
  });

  await test.step("the running app has the whole shipped catalogue loaded", async () => {
    // Read from the renderer's registry rather than through `agent()`.
    // `list_luts` is served from the *main* process, straight off `presetLib`,
    // the way the two `list_*_presets` tools are — so it never reaches the
    // renderer command bridge this harness drives, and asking for it there is
    // a category error rather than a missing tool.
    //
    // What this checks is the same thing and one step closer to the panel:
    // the registry the tiles are built from, in a real app, after a real scan.
    const loaded = await page.evaluate(() =>
      (globalThis as any).CARTCUT.presetsOfKind("lut").map((p: any) => ({
        id: p.id,
        category: p.category,
      })),
    );
    expect(loaded).toHaveLength(80);
    const ids = new Set(loaded.map((row: any) => row.id));
    for (const slug of CASES) {
      expect(ids.has(lutId(slug)), `${slug} missing from the registry`).toBe(true);
    }
    // The panel's sections come from these, so an empty one is a blank heading.
    const categories = new Set(loaded.map((row: any) => row.category));
    expect(categories.has("film")).toBe(true);
    expect(categories.has("log-convert")).toBe(true);
  });

  await test.step("the agent surface reports the LUTs back", async () => {
    const { clips } = await listClips(session);
    const byId = new Map(clips.map((c) => [c.id, c]));
    for (const [i, slug] of CASES.entries()) {
      expect((byId.get(patchIds[i]) as any)?.lut).toBe(lutId(slug));
    }

    const detail = await agent<any>(session, "get_clip", {
      elementId: patchIds[1],
    });
    const clip = detail?.clip ?? detail;
    expect(clip.lut).toBe(lutId("exposure-plus"));
    expect(clip.lutIntensity).toBe(100);
  });

  await test.step("the LUTs reach timeline.json inside the real .ngt", async () => {
    // The one thing no node test can reach: whether the field rides along into
    // the archive the app writes.
    //
    // Only the write half, and deliberately so: `project.load` refuses outright
    // once the timeline has been edited in this session ("Needs to restart"),
    // so a reopen is not reachable from a spec that had to build a timeline
    // first. The read half is covered where it can be — `renderer/lut.ts#lutOf`
    // resolves whatever the archive holds, and `lut.test.ts` drives it with
    // every malformed value worth worrying about.
    const file = path.join(artifactDir, "lut.ngt");
    // The artifact directory survives between runs, so a file left by the last
    // one would satisfy the poll instantly and assert against stale ids.
    fs.rmSync(file, { force: true });

    await session.answerSaveDialog(file);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.save());
    await expect.poll(() => fs.existsSync(file), { timeout: 30_000 }).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const elements = JSON.parse(await zip.file("timeline.json")!.async("string"));

    for (const [i, slug] of CASES.entries()) {
      const saved = elements[patchIds[i]];
      expect(saved, `clip ${patchIds[i]} missing from timeline.json`).toBeTruthy();
      expect(saved.lut).toEqual({ presetId: lutId(slug), intensity: 100 });
    }

    // And an ungraded clip has no key at all, so a project saved before this
    // feature and one saved after it are byte-equal for a clip nobody graded.
    expect(elements[ungradedId], "the ungraded clip is missing").toBeTruthy();
    expect("lut" in elements[ungradedId]).toBe(false);

    await agent(session, "delete_clips", { elementIds: [ungradedId] });
  });

  // ------------------------------------------------------ preview vs export

  await test.step("the preview grades the same way the export does", async () => {
    // The only check anywhere that the GPU applier and the shader agree with
    // the CPU one the node suites pin, because it is the only place both run.
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

  await test.step("the GPU grades the way FFmpeg's own lut3d does", async () => {
    /**
     * The check that closes the loop.
     *
     * Everything else about this feature is verified against *us*: the node
     * suites compare the CPU sampler to its own properties, `glsl.test.ts`
     * compares the shader's text to that sampler, and the step above compares
     * the export to arithmetic restated in this file. `ffmpegParity.test.ts`
     * ties the CPU sampler to ffmpeg — but nothing ties the **shader that
     * actually runs** to anything outside this repository.
     *
     * So: take the frame the app's GPU produced, feed the same input colours
     * through the bundled ffmpeg's `lut3d` on the same `.cube`, and require
     * them to agree. Two implementations that share no code arriving at the
     * same colour is the only evidence here that is not self-referential.
     *
     * `renderReferenceFrames` rather than the encoded file, so there is no
     * codec between the shader and the comparison.
     */
    const [{ frame }] = await renderReferenceFrames(page, [1000], "export");

    // One pixel per case, in the order the patches sit.
    const width = CASES.length;
    const input = Buffer.alloc(width * 3);
    for (let i = 0; i < width; i++) {
      input[i * 3] = SOURCE.r;
      input[i * 3 + 1] = SOURCE.g;
      input[i * 3 + 2] = SOURCE.b;
    }
    const dir = path.join(artifactDir, "ffmpeg-parity");
    fs.mkdirSync(dir, { recursive: true });
    const raw = path.join(dir, "in.raw");
    fs.writeFileSync(raw, input);

    const readings = CASES.map((slug, i) => {
      const cube = path.join(
        REPO_ROOT_FROM_SPEC,
        "assets/presets/luts",
        slug,
        "lut.cube",
      );
      const out = path.join(dir, `${slug}.raw`);
      execFileSync(FFMPEG, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x1`,
        "-i", raw,
        "-vf", `lut3d=file=${cube}:interp=tetrahedral`,
        "-f", "rawvideo", "-pix_fmt", "rgb24", out,
      ]);
      const bytes = fs.readFileSync(out);
      const point = probePoint(i);
      const got = pixel(frame, point.x, point.y);
      return {
        slug,
        ffmpeg: { r: bytes[0], g: bytes[1], b: bytes[2] },
        gpu: { r: got.r, g: got.g, b: got.b },
      };
    });
    writeJson(path.join(artifactDir, "ffmpeg-parity.json"), readings);

    const apart = readings.filter(
      (r) =>
        Math.abs(r.gpu.r - r.ffmpeg.r) > GPU_TOLERANCE ||
        Math.abs(r.gpu.g - r.ffmpeg.g) > GPU_TOLERANCE ||
        Math.abs(r.gpu.b - r.ffmpeg.b) > GPU_TOLERANCE,
    );
    expect(
      apart.map(
        (r) =>
          `${r.slug}: ffmpeg ${JSON.stringify(r.ffmpeg)} gpu ${JSON.stringify(r.gpu)}`,
      ),
    ).toEqual([]);

    // And ffmpeg genuinely produced different colours per LUT, so the
    // agreement above is not six copies of one value matching six others.
    expect(
      new Set(readings.map((r) => `${r.ffmpeg.r},${r.ffmpeg.g},${r.ffmpeg.b}`)).size,
    ).toBeGreaterThanOrEqual(5);
  });

  // ------------------------------------------------------- the delivered file

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

  await test.step("every patch carries the colour the recipe predicts", async () => {
    const frameIndex = Math.floor(fps * 1.5);
    const decoded = await decodeFrames(destination, [frameIndex], WIDTH, HEIGHT);
    expect(decoded.frames).toHaveLength(1);

    const frame: FrameBuffer = {
      data: decoded.frames[0],
      width: WIDTH,
      height: HEIGHT,
    };
    writePng(path.join(artifactDir, "decoded.png"), frame);

    const readings = CASES.map((slug, i) => {
      const point = probePoint(i);
      const got = pixel(frame, point.x, point.y);
      const want = expected(slug);
      return {
        slug,
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
    writeJson(path.join(artifactDir, "readings.json"), readings);

    const wrong = readings.filter(
      (r) =>
        r.delta.r > CHANNEL_TOLERANCE ||
        r.delta.g > CHANNEL_TOLERANCE ||
        r.delta.b > CHANNEL_TOLERANCE,
    );
    expect(
      wrong.map(
        (r) =>
          `${r.slug}: want ${JSON.stringify(r.want)} got ${JSON.stringify(r.got)}`,
      ),
    ).toEqual([]);

    // The anti-tautology guard. A build in which every LUT was silently
    // ignored would still pass every assertion above whenever the formulae
    // happened to sit inside the tolerance of the ungraded colour — six patches
    // of one colour would satisfy the lot.
    const distinct = new Set(
      readings.map((r) => `${r.got.r >> 3},${r.got.g >> 3},${r.got.b >> 3}`),
    );
    expect(distinct.size).toBeGreaterThanOrEqual(4);
  });
});

test("an adjustment layer grades what is beneath it and nothing above", async ({
  session,
  profile,
  artifactDir,
}) => {
  test.setTimeout(10 * 60_000);

  const { page } = session;
  const projectDir = path.join(artifactDir, "project-layer");
  fs.mkdirSync(projectDir, { recursive: true });

  await setProjectFolder(session, projectDir);
  await setResolution(page, WIDTH, HEIGHT);
  await setDuration(page, DURATION_SEC);
  await setBackgroundColor(page, "#000000");
  await setFps(page, profile.fps);

  // Two patches side by side, and an adjustment layer that will sit above one
  // track and below the other — which is the whole mechanism: what a layer
  // grades is decided by *track order*, not by anything on the layer.
  const lower = await addShape(session, {
    fillColor: hex(SOURCE),
    x: 0,
    y: PATCH_Y,
    width: PATCH_W,
    height: PATCH_H,
  });

  const upperTrack = await agent<any>(session, "add_track", { kind: "video" });
  const upperTrackId =
    upperTrack?.tracks?.added?.[0] ?? upperTrack?.trackId ?? upperTrack?.id;
  expect(upperTrackId, "add_track did not report a new track").toBeTruthy();

  const upper = await addShape(session, {
    fillColor: hex(SOURCE),
    x: PATCH_W,
    y: PATCH_Y,
    width: PATCH_W,
    height: PATCH_H,
  });
  await agent(session, "move_clips", {
    elementIds: [upper],
    trackId: upperTrackId,
    startMs: 0,
  });

  // A LUT preset behind an `add_effect` — the same registry, no new tool.
  await agent(session, "add_effect", {
    presetId: lutId("mono-neutral"),
    startMs: 0,
    durationMs: DURATION_SEC * 1000,
  });
  // The layer lands on its own row at the front, so it currently grades both.
  // Moving the upper clip's track ahead of it takes that clip back out.
  await agent(session, "move_track", { trackId: upperTrackId, toIndex: 0 });

  await primeAssets(page);
  await page.evaluate(async () => {
    const cartcut = (globalThis as any).CARTCUT;
    await cartcut.preloadLutsForDocument(
      cartcut.useTimelineStore.getState().timeline,
    );
  });

  const [{ frame }] = await renderReferenceFrames(page, [1000], "export");
  writePng(path.join(artifactDir, "adjustment-layer.png"), frame);

  const belowPoint = probePoint(0);
  const abovePoint = probePoint(1);
  const below = pixel(frame, belowPoint.x, belowPoint.y);
  const above = pixel(frame, abovePoint.x, abovePoint.y);

  const grey = expected("mono-neutral");
  expect(Math.abs(below.r - grey.r)).toBeLessThanOrEqual(2);
  expect(Math.abs(below.g - grey.g)).toBeLessThanOrEqual(2);
  expect(Math.abs(below.b - grey.b)).toBeLessThanOrEqual(2);

  // Above the layer, untouched — which is what makes track order the control.
  expect(Math.abs(above.r - SOURCE.r)).toBeLessThanOrEqual(2);
  expect(Math.abs(above.b - SOURCE.b)).toBeLessThanOrEqual(2);
  expect(Math.abs(above.r - above.b)).toBeGreaterThan(20);
});

test("a LUT the user installed is scanned, validated and graded", async ({
  session,
  profile,
  artifactDir,
}) => {
  test.setTimeout(5 * 60_000);

  const { page } = session;
  const projectDir = path.join(artifactDir, "project-import");
  fs.mkdirSync(projectDir, { recursive: true });

  await setProjectFolder(session, projectDir);
  await setResolution(page, WIDTH, HEIGHT);
  await setDuration(page, DURATION_SEC);
  await setBackgroundColor(page, "#000000");
  await setFps(page, profile.fps);

  // Written straight into the folder `installLut` copies into, so what is
  // exercised from here on is the real scanner, the real validator, the real
  // registry and the real renderer. The dialog and the copy are main-process
  // work with a suite of their own; this is the half that has to be proved
  // against a running app.
  const dir = path.join(session.userDataDir, "presets", "lut-e2e-swap");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "lut.cube"), swapCube(), "utf8");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    `${JSON.stringify(
      {
        schema: 1,
        id: "com.user.lut.e2e-swap",
        kind: "lut",
        name: "E2E Swap",
        category: "utility",
        author: "Imported",
        version: "1.0.0",
        render: { type: "lut", source: "lut.cube" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await page.evaluate(async () => {
    await (globalThis as any).CARTCUT.loadPresets();
  });

  await test.step("it joins the registry as a user preset", async () => {
    const row = await page.evaluate(() =>
      (globalThis as any).CARTCUT.presetsOfKind("lut")
        .filter((p: any) => p.id === "com.user.lut.e2e-swap")
        .map((p: any) => ({ id: p.id, name: p.name, origin: p.origin }))[0],
    );
    expect(row, "the imported LUT is missing from the registry").toBeTruthy();
    expect(row.origin).toBe("user");
    expect(row.name).toBe("E2E Swap");
  });

  const id = await addShape(session, {
    fillColor: hex(SOURCE),
    x: 0,
    y: PATCH_Y,
    width: PATCH_W,
    height: PATCH_H,
  });
  await agent(session, "set_lut", {
    elementIds: [id],
    presetId: "com.user.lut.e2e-swap",
  });

  await primeAssets(page);
  await page.evaluate(async () => {
    const cartcut = (globalThis as any).CARTCUT;
    await cartcut.preloadLutsForDocument(
      cartcut.useTimelineStore.getState().timeline,
    );
  });

  const [{ frame }] = await renderReferenceFrames(page, [1000], "export");
  writePng(path.join(artifactDir, "imported.png"), frame);

  const point = probePoint(0);
  const got = pixel(frame, point.x, point.y);
  // Red and blue swapped. A pass-through would leave the patch as it was, and
  // a table read in the wrong order would land somewhere else entirely — which
  // is why the fixture is a swap rather than, say, a brightness change.
  expect(Math.abs(got.r - SOURCE.b)).toBeLessThanOrEqual(2);
  expect(Math.abs(got.g - SOURCE.g)).toBeLessThanOrEqual(2);
  expect(Math.abs(got.b - SOURCE.r)).toBeLessThanOrEqual(2);
});

test("intensity scales the grade between ungraded and full", async ({
  session,
  profile,
  artifactDir,
}) => {
  test.setTimeout(5 * 60_000);

  const { page } = session;
  const projectDir = path.join(artifactDir, "project-intensity");
  fs.mkdirSync(projectDir, { recursive: true });

  await setProjectFolder(session, projectDir);
  await setResolution(page, WIDTH, HEIGHT);
  await setDuration(page, DURATION_SEC);
  await setBackgroundColor(page, "#000000");
  await setFps(page, profile.fps);

  const levels = [0, 50, 100];
  const ids: string[] = [];
  for (const [i, intensity] of levels.entries()) {
    const id = await addShape(session, {
      fillColor: hex(SOURCE),
      x: i * PATCH_W,
      y: PATCH_Y,
      width: PATCH_W,
      height: PATCH_H,
    });
    await agent(session, "set_lut", {
      elementIds: [id],
      presetId: lutId("mono-neutral"),
      intensity,
    });
    ids.push(id);
  }

  await primeAssets(page);
  await page.evaluate(async () => {
    const cartcut = (globalThis as any).CARTCUT;
    await cartcut.preloadLutsForDocument(
      cartcut.useTimelineStore.getState().timeline,
    );
  });

  const [{ frame }] = await renderReferenceFrames(page, [1000], "export");
  writePng(path.join(artifactDir, "intensity.png"), frame);

  for (const [i, intensity] of levels.entries()) {
    const point = probePoint(i);
    const got = pixel(frame, point.x, point.y);
    const want = expected("mono-neutral", SOURCE, intensity / 100);
    expect(
      Math.abs(got.r - want.r),
      `intensity ${intensity}: want ${JSON.stringify(want)} got ${got.r},${got.g},${got.b}`,
    ).toBeLessThanOrEqual(2);
    expect(Math.abs(got.b - want.b)).toBeLessThanOrEqual(2);
  }

  // Zero is a stored A/B, not a clear: the LUT must still be on the clip.
  const detail = await agent<any>(session, "get_clip", { elementId: ids[0] });
  expect((detail?.clip ?? detail).lut).toBe(lutId("mono-neutral"));
});
