/**
 * Compile, judge and thumbnail every cloud preset in the real app.
 *
 *     npx jiti tests/e2e/cloud/renderThumbnails.ts [--only <sel>,...] [--tag <name>]
 *                                                  [--no-write] [--keep] [--calibrate]
 *
 * `scripts/cloud/checkContent.ts` reads the catalogue as text. What it cannot
 * know is whether a shader compiles on a real WebGL1 context, whether an
 * effect does anything at all, whether a transition starts on its outgoing
 * clip and ends on its incoming one, and whether a graphic shows anything at
 * the moment its tile rests on. A preset that fails any of those still
 * validates, downloads and installs; it just draws a pass-through, or nothing.
 *
 * So this launches a hidden, muted instance whose userData holds the selected
 * items exactly where a download puts them (`cloud/presets/<id>/`), and:
 *
 *   1. compiles every stage, wrapped as the compositor wraps it, and maps any
 *      error back to the author's own line;
 *   2. lets each panel paint its tiles, then writes the tile the user will see
 *      as `thumbnail.webp`, 192x108, so it looks the same before and after the
 *      download, and records the sources' digest in `.thumbnails.json`;
 *   3. pulls chosen steps of every preview and judges them against reference
 *      frames drawn by the same path (an identity effect, and Cross Dissolve's
 *      two ends for the transitions' A and B);
 *   4. writes one contact sheet per (kind, category) to `tests/e2e/.out/cloud/`,
 *      for the review no metric replaces: whether two presets look alike.
 *
 * Probe presets prove the judging measures something. A shader that does not
 * compile, a transition that never moves and a graphic that draws black on
 * black must each fail; if one passes, the run says so and exits 3.
 *
 * `--tag` prefixes the contact sheets' names, so two runs over halves of one
 * category do not overwrite each other's sheet.
 *
 * `--calibrate` judges the built-ins instead and writes nothing. A built-in
 * failing here means a threshold is wrong, not the built-in.
 *
 * Exit status: 0 pass, 1 item failures, 2 setup failure, 3 a probe misjudged.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { AppSession } from "../harness/launch";
import { OUT_DIR, REPO_ROOT } from "../harness/paths";
import { readPresetDir, scanPresetRoot, type RawPresetPayload } from "../../../electron/lib/presetScan";
import {
  authorLineOf,
  vertexShaderFor,
  wrapFragmentShader,
  type WrapInput,
} from "../../../apps/app/src/features/fx/glslWrap";
import {
  CLOUD_KINDS,
  KIND_DIRS,
  THUMBNAIL_NAMES,
  sourcesDigest,
  type CloudPresetKind,
} from "../../../scripts/cloud/contentRules";
import { launchQuiet, openPanel, waitForTiles } from "./panel";

/** `fxPreviewProvider.ts`: 24 steps, resting on step 8. Asserted against the live tile below. */
const STEPS = 24;
const RESTING = 8;
const TILE_W = 192;
const TILE_H = 108;
const CONTENT_ROOT = path.join(REPO_ROOT, "server", "content");
const LEDGER = path.join(CONTENT_ROOT, ".thumbnails.json");
const SHEET_DIR = path.join(OUT_DIR, "cloud");
const CROSS_DISSOLVE = "com.cartcut.cross-dissolve";

/** The steps each kind is judged and shown at. */
const STEPS_OF: Record<CloudPresetKind, number[]> = {
  effect: [0, 3, 5, RESTING, 11, 17, 22],
  transition: [0, 4, RESTING, 12, 16, 19, 23],
  graphic: [2, 5, RESTING, 14, 20, 23],
};

// ----------------------------------------------------------------- probes

type Probe = { id: string; kind: CloudPresetKind; category: string; source: string };

const PROBE = {
  identity: {
    id: "com.cartcut.probe.effect-identity",
    kind: "effect",
    category: "color",
    source: "vec4 effect(vec2 uv) { vec4 c = getSourceColor(uv); return mix(c, c, intensity); }",
  },
  broken: {
    id: "com.cartcut.probe.effect-broken",
    kind: "effect",
    category: "color",
    // `texture()` is GLSL 3: validates, never compiles under WebGL1.
    source: "vec4 effect(vec2 uv) { return mix(texture(source, uv), vec4(1.0), intensity); }",
  },
  still: {
    id: "com.cartcut.probe.transition-still",
    kind: "transition",
    category: "dissolve",
    source: "vec4 transition(vec2 uv) { return getFromColor(uv); }",
  },
  black: {
    id: "com.cartcut.probe.graphic-black",
    kind: "graphic",
    category: "background",
    source: "vec4 graphic(vec2 uv) { return vec4(0.0, 0.0, 0.0, 1.0); }",
  },
  white: {
    id: "com.cartcut.probe.graphic-white",
    kind: "graphic",
    category: "background",
    source: "vec4 graphic(vec2 uv) { return vec4(1.0); }",
  },
} satisfies Record<string, Probe>;

async function writeProbes(userDataDir: string) {
  for (const probe of Object.values(PROBE) as Probe[]) {
    const dir = path.join(userDataDir, "presets", "cartcut-probes", probe.id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        schema: 1,
        id: probe.id,
        kind: probe.kind,
        name: "Probe " + probe.id.split(".").pop(),
        category: probe.category,
        render: { type: "shader", source: "main.frag" },
        params: [],
      }),
    );
    await fsp.writeFile(path.join(dir, "main.frag"), probe.source + "\n");
  }
}

// ------------------------------------------------------------------- args

type Args = { only: string[] | null; tag: string; write: boolean; keep: boolean; calibrate: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { only: null, tag: "", write: true, keep: false, calibrate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--only") args.only = (argv[++index] ?? "").split(",").filter((s) => s !== "");
    else if (arg === "--tag") args.tag = (argv[++index] ?? "").replace(/[^A-Za-z0-9_-]/g, "") + "-";
    else if (arg === "--no-write") args.write = false;
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--calibrate") {
      args.calibrate = true;
      args.write = false;
    } else {
      console.error("unknown argument " + arg);
      process.exit(2);
    }
  }
  return args;
}

// ------------------------------------------------------------------ items

/**
 * The parts of a manifest this harness reads. Not `validatePreset`: the
 * checker runs that first, and its module does not typecheck under this
 * suite's non-strict program.
 */
type Preset = {
  id: string;
  kind: string;
  name: string;
  category: string;
  render: { type: string; source: string; passes?: { source: string }[]; vertex?: string };
  sources: Record<string, string>;
};

function presetOf(payload: RawPresetPayload): Preset | null {
  try {
    const manifest = JSON.parse(payload.manifestJson);
    if (typeof manifest.id !== "string" || manifest.render == null) return null;
    return { ...manifest, sources: payload.sources };
  } catch {
    return null;
  }
}

type Item = {
  kind: CloudPresetKind;
  slug: string;
  key: string;
  /** The folder in `server/content`, or null for a built-in under `--calibrate`. */
  dir: string | null;
  preset: Preset;
};

function selected(item: Item, only: string[] | null): boolean {
  if (only == null) return true;
  return only.some((selector) => {
    const [kind, rest] = selector.split("/");
    if (kind !== item.kind) return false;
    return rest == null || rest === "" || rest === item.slug || rest === item.preset.category;
  });
}

async function cloudItems(only: string[] | null): Promise<Item[]> {
  const items: Item[] = [];
  for (const kind of CLOUD_KINDS) {
    const root = path.join(CONTENT_ROOT, KIND_DIRS[kind]);
    if (!fs.existsSync(root)) continue;
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
      const dir = path.join(root, dirent.name);
      const payload = await readPresetDir(dir, "cloud");
      const preset = payload == null ? null : presetOf(payload);
      if (preset == null) {
        // Somebody else's folder half written is not this run's problem; one
        // this run was asked for by name is.
        if (only == null || only.includes(kind + "/" + dirent.name)) {
          console.error(kind + "/" + dirent.name + ": no usable manifest; run checkContent first");
          process.exit(2);
        }
        continue;
      }
      const item = { kind, slug: dirent.name, key: kind + "/" + dirent.name, dir, preset };
      if (selected(item, only)) items.push(item);
    }
  }
  return items;
}

async function builtinItems(only: string[] | null): Promise<Item[]> {
  const items: Item[] = [];
  for (const payload of await scanPresetRoot(path.join(REPO_ROOT, "assets", "presets"), "builtin")) {
    const preset = presetOf(payload);
    if (preset == null || !(CLOUD_KINDS as readonly string[]).includes(preset.kind)) continue;
    const kind = preset.kind as CloudPresetKind;
    const slug = path.basename(payload.dir);
    const item = { kind, slug, key: kind + "/" + slug, dir: null, preset };
    if (selected(item, only)) items.push(item);
  }
  return items;
}

/** Copy an item where `cloudDownload.ts` would install it, minus the thumbnail it is about to get. */
async function install(item: Item, userDataDir: string) {
  if (item.dir == null) return;
  const target = path.join(userDataDir, "cloud", "presets", item.preset.id);
  await fsp.cp(item.dir, target, {
    recursive: true,
    filter: (source) => !THUMBNAIL_NAMES.includes(path.basename(source)) && !path.basename(source).startsWith("."),
  });
}

// --------------------------------------------------------------- findings

type Finding = { level: "error" | "warn"; item: string; message: string };
const findings: Finding[] = [];
const fail = (item: string, message: string) => findings.push({ level: "error", item, message });
const warn = (item: string, message: string) => findings.push({ level: "warn", item, message });

// ------------------------------------------------------------ in the page

/** Every stage of every shader preset, compiled and linked in a fresh WebGL1 context. */
async function compileAll(session: AppSession, items: Item[]) {
  type Stage = { item: string; file: string; input: WrapInput; fragment: string; vertex: string };
  const stages: Stage[] = [];
  for (const item of items) {
    const render = item.preset.render;
    if (render.type !== "shader") continue;
    const vertex = vertexShaderFor(item.kind, render.vertex != null ? item.preset.sources[render.vertex] : undefined);
    const files = [...(render.passes ?? []).map((pass) => pass.source), render.source];
    for (const file of new Set(files)) {
      const input: WrapInput = { kind: item.kind, source: item.preset.sources[file] ?? "" };
      stages.push({ item: item.key, file, input, fragment: wrapFragmentShader(input), vertex });
    }
  }
  const results = await session.page.evaluate(
    (list: { fragment: string; vertex: string }[]) => {
      const gl = document.createElement("canvas").getContext("webgl");
      if (gl == null) return null;
      return list.map(({ fragment, vertex }) => {
        const compile = (type: number, source: string) => {
          const shader = gl.createShader(type)!;
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          return { shader, ok: !!gl.getShaderParameter(shader, gl.COMPILE_STATUS), log: gl.getShaderInfoLog(shader) ?? "" };
        };
        const v = compile(gl.VERTEX_SHADER, vertex);
        const f = compile(gl.FRAGMENT_SHADER, fragment);
        let link = "";
        if (v.ok && f.ok) {
          const program = gl.createProgram()!;
          gl.attachShader(program, v.shader);
          gl.attachShader(program, f.shader);
          gl.bindAttribLocation(program, 0, "_p");
          gl.linkProgram(program);
          if (!gl.getProgramParameter(program, gl.LINK_STATUS)) link = gl.getProgramInfoLog(program) ?? "link failed";
          gl.deleteProgram(program);
        }
        gl.deleteShader(v.shader);
        gl.deleteShader(f.shader);
        return { vertexOk: v.ok, vertexLog: v.log, fragmentOk: f.ok, fragmentLog: f.log, link };
      });
    },
    stages.map(({ fragment, vertex }) => ({ fragment, vertex })),
  );
  if (results == null) throw new Error("no WebGL context in the editor page");
  const failedItems = new Set<string>();
  results.forEach((result, index) => {
    const stage = stages[index];
    if (!result.fragmentOk) {
      failedItems.add(stage.item);
      const lines = result.fragmentLog
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          const match = line.match(/^ERROR:\s*\d+:(\d+):\s*(.*)$/);
          if (match == null) return line;
          const own = authorLineOf(stage.input, Number(match[1]));
          return (own == null ? "(host line " + match[1] + ")" : stage.file + ":" + own) + " " + match[2];
        });
      fail(stage.item, "does not compile:\n      " + lines.join("\n      "));
    }
    if (!result.vertexOk) {
      failedItems.add(stage.item);
      fail(stage.item, "vertex shader does not compile: " + result.vertexLog.trim());
    }
    if (result.link !== "") {
      failedItems.add(stage.item);
      fail(stage.item, "does not link: " + result.link.trim());
    }
  });
  return failedItems;
}

/** The tile canvases as the panel shows them, as data URLs: WebP to ship, PNG to compare. */
async function tileImages(session: AppSession, kind: CloudPresetKind, ids: string[], type: "image/webp" | "image/png") {
  return session.page.evaluate(
    ({ k, wanted, mime }) => {
      const browser = document.querySelector(`fx-preset-browser[kind="${k}"]`)!;
      const out: Record<string, string> = {};
      for (const id of wanted) {
        const canvas = browser.querySelector(`canvas[data-preset="${CSS.escape(id)}"]`) as HTMLCanvasElement | null;
        if (canvas != null) out[id] = canvas.toDataURL(mime, 0.92);
      }
      return out;
    },
    { k: kind, wanted: ids, mime: type },
  );
}

/**
 * Chosen steps of each preview, straight from the panel's provider, as PNG
 * data URLs. Requested a few at a time and re-requested every round, because
 * the provider keeps a short queue and drops the oldest request.
 */
async function previewFrames(
  session: AppSession,
  kind: CloudPresetKind,
  wants: { id: string; step: number }[],
  timeoutMs: number,
) {
  return session.page.evaluate(
    async ({ k, list, ms, w, h }) => {
      const browser = document.querySelector(`fx-preset-browser[kind="${k}"]`) as any;
      const previews = browser.previews;
      const scratch = document.createElement("canvas");
      scratch.width = w;
      scratch.height = h;
      const context = scratch.getContext("2d")!;
      const frames: Record<string, string> = {};
      let queue = list.slice();
      const deadline = performance.now() + ms;
      while (queue.length > 0 && performance.now() < deadline) {
        for (const want of queue.slice(0, 6)) {
          const key = want.id + "|" + want.step;
          const frame = previews.get(key);
          if (frame != null) {
            context.clearRect(0, 0, w, h);
            context.drawImage(frame, 0, 0, w, h);
            frames[key] = scratch.toDataURL("image/png");
          } else {
            previews.request({ key, presetId: want.id, step: want.step });
          }
        }
        queue = queue.filter((want) => frames[want.id + "|" + want.step] == null);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return { frames, missing: queue.map((want) => want.id + "|" + want.step) };
    },
    { k: kind, list: wants, ms: timeoutMs, w: TILE_W, h: TILE_H },
  );
}

// ---------------------------------------------------------------- metrics

type Pixels = Uint8ClampedArray;

async function pixelsOf(dataUrl: string): Promise<Pixels> {
  const image = await loadImage(Buffer.from(dataUrl.split(",")[1], "base64"));
  const canvas = createCanvas(TILE_W, TILE_H);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, TILE_W, TILE_H);
  return context.getImageData(0, 0, TILE_W, TILE_H).data as unknown as Pixels;
}

/** Mean absolute RGB difference, 0 to 255. */
function meanDiff(a: Pixels, b: Pixels): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 4) {
    sum += Math.abs(a[index] - b[index]) + Math.abs(a[index + 1] - b[index + 1]) + Math.abs(a[index + 2] - b[index + 2]);
  }
  return sum / ((a.length / 4) * 3);
}

/** The share of pixels whose largest channel difference is over 12. */
function changedShare(a: Pixels, b: Pixels): number {
  let changed = 0;
  for (let index = 0; index < a.length; index += 4) {
    const d = Math.max(
      Math.abs(a[index] - b[index]),
      Math.abs(a[index + 1] - b[index + 1]),
      Math.abs(a[index + 2] - b[index + 2]),
    );
    if (d > 12) changed += 1;
  }
  return changed / (a.length / 4);
}

function minAlpha(a: Pixels): number {
  let min = 255;
  for (let index = 3; index < a.length; index += 4) min = Math.min(min, a[index]);
  return min;
}

/** The share of pixels with any channel brighter than 48: what shows on black. */
function ink(a: Pixels): number {
  let lit = 0;
  for (let index = 0; index < a.length; index += 4) {
    if (Math.max(a[index], a[index + 1], a[index + 2]) > 48) lit += 1;
  }
  return lit / (a.length / 4);
}

type Frames = Map<string, Pixels>;

function frameOf(frames: Frames, id: string, step: number): Pixels | null {
  return frames.get(id + "|" + step) ?? null;
}

type References = { a: Pixels; b: Pixels; effectA: Pixels };

/** Judge one preset; returns whether it passed. */
function judge(item: Item, frames: Frames, refs: References): boolean {
  const before = findings.filter((f) => f.level === "error" && f.item === item.key).length;
  const id = item.preset.id;
  const at = (step: number) => frameOf(frames, id, step);
  const missing = STEPS_OF[item.kind].filter((step) => at(step) == null);
  if (missing.length > 0) {
    fail(item.key, "no preview at step " + missing.join(", ") + " (the renderer refused it)");
    return false;
  }
  if (item.kind === "effect") {
    // Failing needs every step to look untouched: Strobe, Digital Glitch and
    // VHS are all near-identity at some moments by design. A weak resting
    // frame is only a warning, but it is the thumbnail, so it gets fixed.
    const steps = STEPS_OF.effect.map((step) => at(step)!);
    const most = Math.max(...steps.map((frame) => meanDiff(frame, refs.effectA)));
    const widest = Math.max(...steps.map((frame) => changedShare(frame, refs.effectA)));
    if (most < 0.5 && widest < 0.01) {
      fail(item.key, `looks like the untouched frame at every step (mean ${most.toFixed(2)}, ${(widest * 100).toFixed(1)}% changed)`);
    }
    const rest = at(RESTING)!;
    const diff = meanDiff(rest, refs.effectA);
    const share = changedShare(rest, refs.effectA);
    if (diff < 2 && share < 0.03) {
      warn(item.key, `the resting tile barely shows it (mean ${diff.toFixed(2)}, ${(share * 100).toFixed(1)}% changed)`);
    }
    if (minAlpha(rest) < 250) fail(item.key, "punches holes in the frame (alpha " + minAlpha(rest) + ")");
  } else if (item.kind === "transition") {
    const start = meanDiff(at(0)!, refs.a);
    const end = meanDiff(at(23)!, refs.b);
    if (start > 6) fail(item.key, `does not start on the outgoing clip (mean ${start.toFixed(1)} from A)`);
    else if (start > 2) warn(item.key, `starts near, not on, the outgoing clip (mean ${start.toFixed(1)})`);
    if (end > 6) fail(item.key, `does not end on the incoming clip (mean ${end.toFixed(1)} from B)`);
    else if (end > 2) warn(item.key, `ends near, not on, the incoming clip (mean ${end.toFixed(1)})`);
    const motion = meanDiff(at(4)!, at(19)!);
    if (motion < 4) fail(item.key, `does not move between steps 4 and 19 (mean ${motion.toFixed(1)})`);
    const rest = at(RESTING)!;
    if (meanDiff(rest, refs.a) < 3 || meanDiff(rest, refs.b) < 3) {
      warn(item.key, "the resting tile is indistinguishable from one of the clips");
    }
  } else {
    const rest = ink(at(RESTING)!);
    if (rest < 0.004) fail(item.key, `nothing visible at rest (${(rest * 100).toFixed(2)}% lit)`);
    if (item.preset.render.type === "html") {
      const end = ink(at(23)!);
      if (rest > 0 && end > rest * 0.35) warn(item.key, "still on screen at the last frame: no exit?");
    }
  }
  return findings.filter((f) => f.level === "error" && f.item === item.key).length === before;
}

// ------------------------------------------------------------ contact sheet

async function writeSheet(name: string, kind: CloudPresetKind, items: Item[], frames: Frames, refs: References) {
  const scale = 0.75;
  const w = Math.round(TILE_W * scale);
  const h = Math.round(TILE_H * scale);
  const label = 190;
  const steps = STEPS_OF[kind];
  const rowH = h + 8;
  const canvas = createCanvas(label + (steps.length + (kind === "effect" ? 1 : 0)) * (w + 4) + 8, 28 + items.length * rowH);
  const context = canvas.getContext("2d");
  context.fillStyle = "#1b1c1e";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#9aa0a6";
  context.font = "12px sans-serif";
  const header = kind === "effect" ? ["A", ...steps.map(String)] : steps.map(String);
  header.forEach((text, index) => context.fillText("step " + text, label + index * (w + 4) + 4, 18));
  const toImage = async (pixels: Pixels) => {
    const tile = createCanvas(TILE_W, TILE_H);
    const tileContext = tile.getContext("2d");
    const data = tileContext.createImageData(TILE_W, TILE_H);
    data.data.set(pixels);
    tileContext.putImageData(data, 0, 0);
    return tile;
  };
  for (const [row, item] of items.entries()) {
    const y = 28 + row * rowH;
    const failed = findings.some((f) => f.level === "error" && f.item === item.key);
    context.fillStyle = failed ? "#ff6b6b" : "#e8eaed";
    context.font = "bold 13px sans-serif";
    context.fillText(item.preset.name, 8, y + 18);
    context.fillStyle = "#9aa0a6";
    context.font = "11px sans-serif";
    context.fillText(item.slug, 8, y + 34);
    const strip = kind === "effect" ? [refs.effectA, ...steps.map((s) => frameOf(frames, item.preset.id, s))] : steps.map((s) => frameOf(frames, item.preset.id, s));
    for (const [index, pixels] of strip.entries()) {
      if (pixels == null) continue;
      context.drawImage(await toImage(pixels), label + index * (w + 4), y, w, h);
    }
  }
  await fsp.mkdir(SHEET_DIR, { recursive: true });
  const file = path.join(SHEET_DIR, name + ".png");
  await fsp.writeFile(file, canvas.toBuffer("image/png"));
  return file;
}

// -------------------------------------------------------------------- run

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const items = args.calibrate ? await builtinItems(args.only) : await cloudItems(args.only);
  if (items.length === 0) {
    console.error("nothing selected");
    process.exit(2);
  }

  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cartcut-cloud-"));
  for (const item of items) await install(item, userDataDir);
  await writeProbes(userDataDir);

  let session: AppSession | null = null;
  const shutdown = async (code: number) => {
    if (session != null) await session.close().catch(() => {});
    if (!args.keep) await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown(130));
  process.on("SIGTERM", () => void shutdown(143));

  try {
    session = await launchQuiet({ userDataDir });
  } catch (error) {
    console.error("launch failed: " + String(error));
    return shutdown(2);
  }
  const consoleLines: string[] = [];
  session.page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") consoleLines.push(message.text());
  });

  const { page } = session;
  const probeIds = (Object.values(PROBE) as Probe[]).map((probe) => probe.id);
  const allIds = [...items.map((item) => item.preset.id), ...probeIds, CROSS_DISSOLVE];
  try {
    await page.waitForFunction(
      (ids) => {
        const cartcut = (globalThis as any).CARTCUT;
        const known = new Set(
          ["effect", "transition", "graphic"].flatMap((k) => cartcut.presetsOfKind(k).map((p: any) => p.id)),
        );
        return ids.every((id: string) => known.has(id));
      },
      allIds,
      { timeout: 30_000 },
    );
  } catch {
    const known: string[] = await page.evaluate(() =>
      ["effect", "transition", "graphic"].flatMap((k) => (globalThis as any).CARTCUT.presetsOfKind(k).map((p: any) => p.id)),
    );
    for (const id of allIds.filter((id) => !known.includes(id))) {
      fail(id, "not in the registry after launch: " + consoleLines.filter((l) => l.includes("preset: skipped")).join(" | "));
    }
  }

  // 1. Compile, items and probes together.
  const probeItems: Item[] = (Object.values(PROBE) as Probe[]).map((probe) => ({
    kind: probe.kind,
    slug: probe.id.split(".").pop()!,
    key: "probe/" + probe.id.split(".").pop(),
    dir: null,
    preset: {
      id: probe.id,
      kind: probe.kind,
      category: probe.category,
      render: { type: "shader", source: "main.frag" },
      name: probe.id,
      sources: { "main.frag": probe.source },
    },
  }));
  const uncompiled = await compileAll(session, [...items, ...probeItems]);
  const probeFailures: string[] = [];
  if (!uncompiled.has("probe/effect-broken")) probeFailures.push("the broken shader compiled");
  for (const key of [...uncompiled].filter((k) => k.startsWith("probe/") && k !== "probe/effect-broken")) {
    probeFailures.push(key + " did not compile");
  }
  findings.splice(
    0,
    findings.length,
    ...findings.filter((f) => !f.item.startsWith("probe/")),
  );

  // 2 and 3, one panel at a time.
  const ledger: Record<string, string> = args.write && fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : {};
  const sheets: string[] = [];
  for (const kind of CLOUD_KINDS) {
    const ofKind = items.filter((item) => item.kind === kind);
    if (ofKind.length === 0) continue;
    await openPanel(session, kind);
    const ids = ofKind.map((item) => item.preset.id);
    const unpainted = await waitForTiles(session, kind, ids, 120_000);
    for (const id of unpainted) fail(ofKind.find((item) => item.preset.id === id)!.key, "its tile never painted");

    // The probes and references this kind is judged against.
    const extra: { id: string; step: number }[] =
      kind === "effect"
        ? [
            { id: PROBE.identity.id, step: RESTING },
            ...STEPS_OF.effect.map((step) => ({ id: PROBE.broken.id, step })),
          ]
        : kind === "transition"
          ? [
              { id: CROSS_DISSOLVE, step: 0 },
              { id: CROSS_DISSOLVE, step: 23 },
              ...STEPS_OF.transition.map((step) => ({ id: PROBE.still.id, step })),
            ]
          : [
              ...STEPS_OF.graphic.map((step) => ({ id: PROBE.black.id, step })),
              ...STEPS_OF.graphic.map((step) => ({ id: PROBE.white.id, step })),
            ];
    const wants = [...ofKind.flatMap((item) => STEPS_OF[kind].map((step) => ({ id: item.preset.id, step }))), ...extra];
    const { frames: raw, missing } = await previewFrames(session, kind, wants, 60_000 + wants.length * 400);
    const frames: Frames = new Map();
    for (const [key, url] of Object.entries(raw)) frames.set(key, await pixelsOf(url));

    // The constants above against the live tile: if the resting step moved,
    // every thumbnail would show a different moment from the one judged.
    const tiles = await tileImages(session, kind, ids, "image/webp");
    const exact = await tileImages(session, kind, ids.slice(0, 3), "image/png");
    for (const item of ofKind.slice(0, 3)) {
      const tile = exact[item.preset.id];
      const rest = frameOf(frames, item.preset.id, RESTING);
      if (tile != null && rest != null && meanDiff(await pixelsOf(tile), rest) > 3) {
        console.error("the panel's resting tile is not step " + RESTING + "; fxPreviewProvider.ts changed");
        return shutdown(2);
      }
    }

    const references: References = {
      effectA: frameOf(frames, PROBE.identity.id, RESTING) ?? new Uint8ClampedArray(TILE_W * TILE_H * 4),
      a: frameOf(frames, CROSS_DISSOLVE, 0) ?? new Uint8ClampedArray(TILE_W * TILE_H * 4),
      b: frameOf(frames, CROSS_DISSOLVE, 23) ?? new Uint8ClampedArray(TILE_W * TILE_H * 4),
    };
    if (missing.some((key) => key.startsWith(PROBE.identity.id) || key.startsWith(CROSS_DISSOLVE))) {
      console.error("a reference frame never rendered: " + missing.join(", "));
      return shutdown(2);
    }

    // The probes have to be judged the way they were built to be.
    const probeJudged = (probe: Probe) => {
      const key = "probe/" + probe.id.split(".").pop();
      const item = probeItems.find((p) => p.key === key)!;
      const passed = judge(item, frames, references);
      findings.splice(0, findings.length, ...findings.filter((f) => f.item !== key));
      return passed;
    };
    if (kind === "effect" && probeJudged(PROBE.broken)) probeFailures.push("the broken effect was judged to work");
    if (kind === "transition" && probeJudged(PROBE.still)) probeFailures.push("the still transition was judged to move");
    if (kind === "graphic") {
      if (probeJudged(PROBE.black)) probeFailures.push("black on black was judged visible");
      if (!probeJudged(PROBE.white)) probeFailures.push("the white graphic was judged invisible");
    }

    for (const item of ofKind) {
      const compiled = !uncompiled.has(item.key);
      const passed = judge(item, frames, references) && compiled && !unpainted.includes(item.preset.id);
      const named = consoleLines.filter((line) => line.includes(item.preset.id));
      for (const line of named) fail(item.key, "console: " + line.split("\n")[0]);
      if (args.write && passed && named.length === 0 && item.dir != null && tiles[item.preset.id] != null) {
        for (const name of THUMBNAIL_NAMES) await fsp.rm(path.join(item.dir, name), { force: true });
        await fsp.writeFile(path.join(item.dir, "thumbnail.webp"), Buffer.from(tiles[item.preset.id].split(",")[1], "base64"));
        ledger[item.preset.id] = sourcesDigest(item.dir);
      }
    }

    const categories = [...new Set(ofKind.map((item) => item.preset.category))].sort();
    for (const category of categories) {
      const rows = ofKind.filter((item) => item.preset.category === category);
      const prefix = (args.calibrate ? "builtin-" : "") + args.tag;
      sheets.push(await writeSheet(prefix + kind + "-" + category, kind, rows, frames, references));
    }
  }

  if (args.write) {
    const part = LEDGER + ".part";
    await fsp.writeFile(part, JSON.stringify(ledger, Object.keys(ledger).sort(), 2) + "\n");
    await fsp.rename(part, LEDGER);
  }

  const general = consoleLines.filter((line) => /render failed|could not rasterise/.test(line));
  for (const line of general) warn("run", "console: " + line.split("\n")[0]);

  const byItem = new Map<string, Finding[]>();
  for (const finding of findings) byItem.set(finding.item, [...(byItem.get(finding.item) ?? []), finding]);
  for (const [item, list] of [...byItem.entries()].sort()) {
    console.log(item);
    for (const finding of list) console.log("  " + (finding.level === "error" ? "ERROR" : "WARN ") + " " + finding.message);
  }
  for (const sheet of sheets) console.log("sheet " + path.relative(REPO_ROOT, sheet));
  for (const problem of probeFailures) console.log("PROBE " + problem);
  const errors = findings.filter((f) => f.level === "error").length;
  const failedItems = new Set(findings.filter((f) => f.level === "error").map((f) => f.item)).size;
  console.log(
    (probeFailures.length > 0 ? "PROBES MISJUDGED" : errors > 0 ? "FAIL" : "ok") +
      ": " + items.length + " judged, " + failedItems + " failed, " +
      findings.filter((f) => f.level === "warn").length + " warnings",
  );
  return shutdown(probeFailures.length > 0 ? 3 : errors > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
