/**
 * Check the cloud catalogue in `server/content/` without launching anything.
 *
 *     npx jiti scripts/cloud/checkContent.ts [--strict] [--only <sel>,...]
 *                                            [--plan] [--require-thumbnails] [--json]
 *     npx jiti scripts/cloud/checkContent.ts --print-preamble effect|transition|graphic
 *     npx jiti scripts/cloud/checkContent.ts --print-fonts
 *
 * `server/content/` is gitignored and has no suite of its own, and the server
 * lists any folder whose manifest parses: a preset with the wrong category, a
 * GLSL 3 builtin or a name a built-in already has is served, downloaded and
 * then hidden, refused or drawn as a pass-through, with nobody told. This runs
 * the real scanner, the real validator and the real catalog parser over every
 * item, then the rules in `contentRules.ts`, then the catalogue-wide rules
 * that only make sense across items: one id, one name and one pipeline each,
 * against each other and against everything in `assets/presets`.
 *
 * `--only` takes `kind`, `kind/category` or `kind/slug`. It filters what is
 * reported, never what is compared, so one batch cannot pass while it clashes
 * with another.
 *
 * Exit status: 0 clean, 1 errors (or warnings under `--strict`), 2 a usage or
 * IO failure.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { loadImage, createCanvas } from "@napi-rs/canvas";
import { readPresetDir, scanPresetRoot, type RawPresetPayload } from "../../electron/lib/presetScan";
import { parseCatalog } from "../../electron/lib/cloud/cloudCatalog";
import { validatePreset } from "../../apps/app/src/features/fx/presetValidate";
import {
  categoriesFor,
  type FxHtmlRender,
  type FxPreset,
} from "../../apps/app/src/features/fx/presetTypes";
import { wrapFragmentShader } from "../../apps/app/src/features/fx/glslWrap";
import { mountSpecOf } from "../../apps/app/src/features/graphic/mountSpec";
import {
  htmlSourcesOf,
  literalFreePipelineOf,
  pipelineOf,
} from "../../apps/app/src/features/fx/pipelineKey";
import {
  CLOUD_KINDS,
  KIND_DIRS,
  SLUG_PATTERN,
  THUMBNAIL_NAMES,
  cloudIdOf,
  displayTextProblems,
  glslProblems,
  kindApiProblems,
  sourcesDigest,
  type CloudPresetKind,
} from "./contentRules";

// ------------------------------------------------------------------ setup

const cwd = process.cwd();
if (!fs.existsSync(path.join(cwd, "assets", "presets"))) {
  console.error("run this from the repository root: no assets/presets under " + cwd);
  process.exit(2);
}
const BUILTIN_ROOT = path.join(cwd, "assets", "presets");
const CONTENT_ROOT = path.join(cwd, "server", "content");
const FONT_ROOT = path.join(cwd, "assets", "fonts", "google");
const THUMBNAIL_LEDGER = path.join(CONTENT_ROOT, ".thumbnails.json");
const PLAN_FILE = path.join(CONTENT_ROOT, ".plan.json");

/** `server/src/catalog.rs`: what the server indexes, and how much of it. */
const SERVER_EXTENSIONS = [
  ".frag", ".vert", ".glsl", ".html", ".css", ".svg",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov",
  ".cube", ".3dl", ".woff2", ".woff", ".ttf", ".otf",
];
const TEXT_EXTENSIONS = [".frag", ".vert", ".glsl", ".html", ".css", ".svg"];
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_FILES = 256;
/** Past this a name wraps under its tile in the 192px grid. */
const LONG_NAME = 24;
/** The tile's size, and the same at twice the density. */
const THUMBNAIL_SIZES = [
  [192, 108],
  [384, 216],
];

type Args = {
  strict: boolean;
  json: boolean;
  plan: boolean;
  thumbnails: boolean;
  only: string[] | null;
  printPreamble: string | null;
  printFonts: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    strict: false,
    json: false,
    plan: false,
    thumbnails: false,
    only: null,
    printPreamble: null,
    printFonts: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--strict") args.strict = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--plan") args.plan = true;
    else if (arg === "--require-thumbnails") args.thumbnails = true;
    else if (arg === "--print-fonts") args.printFonts = true;
    else if (arg === "--only") args.only = (argv[++index] ?? "").split(",").filter((s) => s !== "");
    else if (arg === "--print-preamble") args.printPreamble = argv[++index] ?? "";
    else {
      console.error("unknown argument " + arg);
      process.exit(2);
    }
  }
  return args;
}

// --------------------------------------------------------------- findings

type Level = "error" | "warn";
type Finding = { level: Level; rule: string; item: string; file?: string; line?: number; message: string };

const findings: Finding[] = [];

function report(level: Level, rule: string, item: string, message: string, file?: string, line?: number) {
  findings.push({ level, rule, item, message, ...(file == null ? {} : { file }), ...(line == null ? {} : { line }) });
}

// ------------------------------------------------------------------ items

type CloudEntry = {
  kind: CloudPresetKind;
  slug: string;
  /** `kind/slug`, how findings and `--only` name an item. */
  key: string;
  dir: string;
  payload: RawPresetPayload | null;
  preset: FxPreset | null;
};

type FileRecord = { relative: string; bytes: number; sha256: string };

/**
 * The files the server would index for one folder, judged by the server's own
 * rules (`catalog.rs#read_preset`): anything it would skip is an error here,
 * because a skipped file is a missing file on the user's disk.
 */
function serverFilesOf(entry: CloudEntry): FileRecord[] {
  const files: FileRecord[] = [];
  const walk = (base: string, prefix: string, depth: number) => {
    for (const dirent of fs.readdirSync(base, { withFileTypes: true })) {
      const relative = prefix === "" ? dirent.name : prefix + "/" + dirent.name;
      const full = path.join(base, dirent.name);
      if (dirent.name === ".DS_Store") continue;
      if (dirent.name.startsWith(".")) {
        report("error", "server", entry.key, "dotfiles are not served", relative);
        continue;
      }
      if (dirent.isSymbolicLink()) {
        report("error", "server", entry.key, "symlinks are not served", relative);
        continue;
      }
      if (dirent.isDirectory()) {
        if (depth === 0) report("error", "server", entry.key, "folders nest one level at most", relative);
        else walk(full, relative, depth - 1);
        continue;
      }
      const extension = path.extname(dirent.name).toLowerCase();
      const bytes = fs.statSync(full).size;
      if (relative === "manifest.json") {
        if (bytes > MAX_MANIFEST_BYTES) report("error", "server", entry.key, "manifest over 256 KB", relative);
      } else if (!SERVER_EXTENSIONS.includes(extension)) {
        report("error", "server", entry.key, "the server skips `" + extension + "` files", relative);
        continue;
      } else if (TEXT_EXTENSIONS.includes(extension) && bytes > MAX_TEXT_BYTES) {
        report("error", "server", entry.key, "text over 512 KB is skipped", relative);
        continue;
      }
      const sha256 = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      files.push({ relative, bytes, sha256 });
    }
  };
  walk(entry.dir, "", 1);
  if (files.length > MAX_FILES) report("error", "server", entry.key, files.length + " files, the app takes 256");
  return files;
}

/** Run the app's own catalog parser over the item the server would list. */
function checkCatalogEntry(entry: CloudEntry, manifest: Record<string, unknown>, files: FileRecord[]) {
  const thumbnail = THUMBNAIL_NAMES.find((name) => files.some((file) => file.relative === name)) ?? null;
  const item = {
    id: manifest.id,
    kind: entry.kind,
    name: manifest.name,
    category: manifest.category,
    author: manifest.author ?? null,
    version: manifest.version ?? null,
    schema: manifest.schema,
    thumbnail,
    files: files.map((file) => ({ path: file.relative, bytes: file.bytes, sha256: file.sha256 })),
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
  const parsed = parseCatalog(entry.kind, { kind: entry.kind, items: [item] });
  for (const reason of parsed.rejected) {
    report("error", "server", entry.key, "the app drops it from the catalog: " + reason);
  }
}

function checkShape(entry: CloudEntry, manifest: Record<string, unknown>) {
  if (!SLUG_PATTERN.test(entry.slug)) {
    report("error", "id", entry.key, "folder `" + entry.slug + "` is not a kebab-case slug");
  }
  const expected = cloudIdOf(entry.kind, entry.slug);
  if (manifest.id !== expected) {
    report("error", "id", entry.key, "id is `" + String(manifest.id) + "`, expected `" + expected + "`");
  }
  if (manifest.kind !== entry.kind) {
    report("error", "kind", entry.key, "manifest kind `" + String(manifest.kind) + "` under " + KIND_DIRS[entry.kind] + "/");
  }
  const categories = categoriesFor(entry.kind) as readonly string[];
  if (typeof manifest.category !== "string" || !categories.includes(manifest.category)) {
    report(
      "error",
      "category",
      entry.key,
      "category `" + String(manifest.category) + "` is not one of " + categories.join(", ") + " (the panel hides it)",
    );
  }
  if (manifest.author !== "Cartcut") report("warn", "manifest", entry.key, "author is not `Cartcut`");
  if (typeof manifest.version !== "string") report("warn", "manifest", entry.key, "no `version`");
  if ("thumbnail" in manifest) {
    report("warn", "manifest", entry.key, "`thumbnail` in the manifest is unused; the server picks thumbnail.* by name");
  }
  if (typeof manifest.name === "string") {
    for (const problem of displayTextProblems(manifest.name)) {
      report("error", "name", entry.key, "name " + problem);
    }
    if (manifest.name.length > LONG_NAME) {
      report("warn", "name", entry.key, "name is " + manifest.name.length + " characters and wraps under the tile");
    }
  }
}

function checkShader(entry: CloudEntry, preset: FxPreset) {
  const render = preset.render;
  if (render.type !== "shader") return;
  if (render.textures != null && render.textures.length > 0) {
    report("error", "policy", entry.key, "`textures`: cloud presets are procedural");
  }
  if (render.precompute != null) {
    report("error", "policy", entry.key, "`precompute` is not implemented at runtime");
  }
  if ((render.vertex != null || render.mesh != null) && !(entry.kind === "transition" && preset.category === "3d")) {
    report("warn", "policy", entry.key, "a custom vertex shader or mesh outside a 3d transition");
  }
  const stages = [...(render.passes ?? []).map((pass) => pass.source), render.source];
  for (const file of new Set(stages)) {
    const source = preset.sources[file] ?? "";
    for (const problem of glslProblems(source, entry.kind, "fragment")) {
      report("error", "glsl", entry.key, problem.message, file, problem.line);
    }
    for (const problem of kindApiProblems(source, entry.kind)) {
      report("error", "kind-api", entry.key, problem.message, file, problem.line);
    }
  }
  if (render.vertex != null) {
    for (const problem of glslProblems(preset.sources[render.vertex] ?? "", entry.kind, "vertex")) {
      report("error", "glsl", entry.key, problem.message, render.vertex, problem.line);
    }
  }
  if (entry.kind === "effect" && !/\bintensity\b/.test(preset.sources[render.source] ?? "")) {
    // The host does not fade an effect; every built-in mixes by `intensity`
    // in its final stage, and one that does not ignores the slider.
    report("error", "intensity", entry.key, "the final stage never reads `intensity`", render.source);
  }
  if (entry.kind === "graphic" && preset.category !== "background") {
    report("error", "category", entry.key, "a shader graphic belongs in `background`");
  }
}

function checkHtml(entry: CloudEntry, preset: FxPreset) {
  if (preset.render.type !== "html") return;
  const render = preset.render as FxHtmlRender;
  if (preset.category === "background") {
    report("error", "category", entry.key, "`background` is for shader graphics; an HTML graphic carries text");
  }
  const textKey = render.bindings?.text;
  const textParam = preset.params.find((param) => param.key === textKey);
  if (textParam?.type !== "text") {
    report("error", "html", entry.key, "`render.bindings.text` must name a text parameter");
  }
  const sources = htmlSourcesOf(preset);
  if (!/word-break:\s*keep-all/.test(sources)) {
    report("error", "html", entry.key, "no `word-break: keep-all` (Korean would break between syllables)");
  }
  const fonts = preset.params.filter((param) => param.type === "font");
  if (fonts.length === 0) report("error", "html", entry.key, "no font parameter");
  for (const font of fonts) {
    const value = String(font.default);
    if (!value.startsWith("bundled:") || !fs.existsSync(path.join(FONT_ROOT, value.slice("bundled:".length)))) {
      report("error", "html", entry.key, "font default `" + value + "` is not a bundled face");
    }
  }
  for (const param of preset.params) {
    if (param.type === "text") {
      for (const problem of displayTextProblems(String(param.default))) {
        report("error", "html", entry.key, "default text of `" + param.key + "` " + problem);
      }
    }
  }
  const lost = mountSpecOf(preset)?.removed ?? [];
  for (const diagnostic of lost) {
    report("error", "html", entry.key, "lost to the sanitiser: " + diagnostic.message, diagnostic.file, diagnostic.line);
  }
  const bare = sources.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
  if (/@font-face|@import/.test(bare)) report("error", "html", entry.key, "`@font-face`/`@import` are removed");
  if (/url\(\s*(?!["']?#)/.test(bare)) report("error", "html", entry.key, "a `url(` that is not `url(#...)`");
  if (render.layout !== "scale" || render.designSize == null) {
    report("warn", "html", entry.key, "no `layout: scale` with a `designSize`; the tile fits it unpredictably");
  }
}

async function checkThumbnail(entry: CloudEntry, ledger: Record<string, string>) {
  const present = THUMBNAIL_NAMES.filter((name) => fs.existsSync(path.join(entry.dir, name)));
  if (present.length === 0) {
    report("error", "thumbnail", entry.key, "no thumbnail; the cloud tile is blank until downloaded");
    return;
  }
  if (present.length > 1) {
    report("error", "thumbnail", entry.key, "more than one thumbnail: " + present.join(", "));
  }
  const file = path.join(entry.dir, present[0]);
  let image;
  try {
    image = await loadImage(fs.readFileSync(file));
  } catch (error) {
    report("error", "thumbnail", entry.key, "does not decode: " + String(error), present[0]);
    return;
  }
  if (!THUMBNAIL_SIZES.some(([w, h]) => image.width === w && image.height === h)) {
    report("error", "thumbnail", entry.key, image.width + "x" + image.height + ", expected 192x108", present[0]);
  }
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;
  let minAlpha = 255;
  let maxAlpha = 0;
  for (let index = 3; index < data.length; index += 4) {
    minAlpha = Math.min(minAlpha, data[index]);
    maxAlpha = Math.max(maxAlpha, data[index]);
  }
  if (maxAlpha === 0) report("error", "thumbnail", entry.key, "fully transparent", present[0]);
  if (entry.kind !== "graphic" && minAlpha < 250) {
    report("error", "thumbnail", entry.key, "an effect or transition tile should be opaque", present[0]);
  }
  const id = cloudIdOf(entry.kind, entry.slug);
  if (ledger[id] !== sourcesDigest(entry.dir)) {
    report("error", "thumbnail", entry.key, "stale: the sources changed since it was rendered", present[0]);
  }
}

// --------------------------------------------------------------- run

type PlanRow = { kind: CloudPresetKind; slug: string; name: string; category: string };

/**
 * Whether `--only` names this item. A category falls back to the plan's when
 * the manifest did not load, so a preset that fails validation is still
 * reported to the batch that owns it rather than filtered out of its view.
 */
function selected(entry: CloudEntry, only: string[] | null, plannedCategory: Map<string, string>): boolean {
  if (only == null) return true;
  const category = entry.preset?.category ?? plannedCategory.get(entry.key);
  return only.some((selector) => {
    const [kind, rest] = selector.split("/");
    if (kind !== entry.kind) return false;
    if (rest == null || rest === "") return true;
    return rest === entry.slug || rest === category;
  });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.printPreamble != null) {
    if (!(CLOUD_KINDS as readonly string[]).includes(args.printPreamble)) {
      console.error("--print-preamble takes effect, transition or graphic");
      process.exit(2);
    }
    process.stdout.write(
      wrapFragmentShader({ kind: args.printPreamble as CloudPresetKind, source: "/* your source */" }),
    );
    return;
  }
  if (args.printFonts) {
    for (const name of fs.readdirSync(FONT_ROOT).filter((n) => /\.(ttf|otf|woff2?)$/.test(n)).sort()) {
      console.log("bundled:" + name);
    }
    return;
  }

  // Built-ins, every kind, LUTs included: the names and pipelines to stay clear of.
  const builtins: FxPreset[] = [];
  for (const payload of await scanPresetRoot(BUILTIN_ROOT, "builtin")) {
    const result = validatePreset(payload);
    if (result.ok) builtins.push(result.preset);
  }

  const entries: CloudEntry[] = [];
  for (const kind of CLOUD_KINDS) {
    const root = path.join(CONTENT_ROOT, KIND_DIRS[kind]);
    if (!fs.existsSync(root)) continue;
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
      entries.push({
        kind,
        slug: dirent.name,
        key: kind + "/" + dirent.name,
        dir: path.join(root, dirent.name),
        payload: null,
        preset: null,
      });
    }
  }

  for (const entry of entries) {
    const payload = await readPresetDir(entry.dir, "cloud");
    if (payload == null) {
      report("error", "server", entry.key, "no manifest.json");
      continue;
    }
    entry.payload = payload;
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(payload.manifestJson);
    } catch (error) {
      report("error", "manifest", entry.key, "manifest.json does not parse: " + String(error));
      continue;
    }
    const files = serverFilesOf(entry);
    checkCatalogEntry(entry, manifest, files);
    checkShape(entry, manifest);
    const result = validatePreset(payload);
    if (!result.ok) {
      for (const error of result.errors) report("error", "validate", entry.key, error);
      continue;
    }
    entry.preset = result.preset;
    for (const warning of result.warnings ?? []) report("warn", "validate", entry.key, warning);
    checkShader(entry, result.preset);
    checkHtml(entry, result.preset);
  }

  // Catalogue-wide: one id, one name, one pipeline, against everything.
  const loaded = entries.filter((entry) => entry.preset != null) as (CloudEntry & { preset: FxPreset })[];
  const takenIds = new Map(builtins.map((preset) => [preset.id.toLowerCase(), "built-in " + preset.id]));
  const takenNames = new Map(builtins.map((preset) => [preset.name.toLowerCase(), "built-in " + preset.kind + " " + preset.id]));
  const takenPipelines = new Map<string, string>();
  const takenShapes = new Map<string, string>();
  for (const preset of builtins) {
    takenPipelines.set(preset.kind + "|" + pipelineOf(preset), "built-in " + preset.id);
    takenShapes.set(preset.kind + "|" + literalFreePipelineOf(preset), "built-in " + preset.id);
  }
  for (const entry of loaded) {
    const { preset } = entry;
    const id = preset.id.toLowerCase();
    if (takenIds.has(id)) report("error", "id", entry.key, "id already used by " + takenIds.get(id));
    takenIds.set(id, entry.key);

    const name = preset.name.toLowerCase();
    if (takenNames.has(name)) report("error", "name", entry.key, "name `" + preset.name + "` is taken by " + takenNames.get(name));
    takenNames.set(name, entry.key);

    const pipeline = preset.kind + "|" + pipelineOf(preset);
    const shape = preset.kind + "|" + literalFreePipelineOf(preset);
    if (takenPipelines.has(pipeline)) {
      report("error", "pipeline", entry.key, "runs the same pipeline as " + takenPipelines.get(pipeline));
    } else if (takenShapes.has(shape)) {
      report("error", "pipeline", entry.key, "differs only in constants from " + takenShapes.get(shape) + " (that is a parameter)");
    }
    takenPipelines.set(pipeline, entry.key);
    takenShapes.set(shape, entry.key);
  }

  if (args.thumbnails) {
    const ledger = readJson<Record<string, string>>(THUMBNAIL_LEDGER, {});
    for (const entry of loaded) await checkThumbnail(entry, ledger);
  }

  if (args.plan) {
    const plan = readJson<PlanRow[] | null>(PLAN_FILE, null);
    if (plan == null) {
      report("error", "plan", "server/content", "no readable .plan.json");
    } else {
      const byKey = new Map(entries.map((entry) => [entry.key, entry]));
      for (const row of plan) {
        const entry = byKey.get(row.kind + "/" + row.slug);
        if (entry == null) {
          report("error", "plan", row.kind + "/" + row.slug, "planned but not written");
          continue;
        }
        if (entry.preset != null && entry.preset.name !== row.name) {
          report("error", "plan", entry.key, "named `" + entry.preset.name + "`, planned `" + row.name + "`");
        }
        if (entry.preset != null && entry.preset.category !== row.category) {
          report("error", "plan", entry.key, "in `" + entry.preset.category + "`, planned `" + row.category + "`");
        }
      }
      const planned = new Set(plan.map((row) => row.kind + "/" + row.slug));
      for (const entry of entries) {
        if (!planned.has(entry.key)) report("error", "plan", entry.key, "not in .plan.json");
      }
    }
  }

  // ------------------------------------------------------------- output

  const plannedCategory = new Map(
    readJson<PlanRow[]>(PLAN_FILE, []).map((row) => [row.kind + "/" + row.slug, row.category]),
  );
  const shownKeys = new Set(
    entries.filter((entry) => selected(entry, args.only, plannedCategory)).map((entry) => entry.key),
  );
  const shown = findings.filter((finding) => args.only == null || shownKeys.has(finding.item));
  const errors = shown.filter((finding) => finding.level === "error").length;
  const warnings = shown.length - errors;
  const failed = errors > 0 || (args.strict && warnings > 0);

  if (args.json) {
    console.log(JSON.stringify({ checked: shownKeys.size, errors, warnings, findings: shown }, null, 2));
  } else {
    const byItem = new Map<string, Finding[]>();
    for (const finding of shown) byItem.set(finding.item, [...(byItem.get(finding.item) ?? []), finding]);
    for (const [item, list] of [...byItem.entries()].sort()) {
      console.log(item);
      for (const finding of list) {
        const where = finding.file == null ? "" : " " + finding.file + (finding.line == null ? "" : ":" + finding.line);
        console.log("  " + (finding.level === "error" ? "ERROR" : "WARN ") + " " + finding.rule + where + "  " + finding.message);
      }
    }
    const counts = CLOUD_KINDS.map(
      (kind) => kind + " " + entries.filter((entry) => entry.kind === kind && shownKeys.has(entry.key)).length,
    ).join(", ");
    console.log(
      (failed ? "FAIL" : "ok") + ": " + shownKeys.size + " checked (" + counts + "), " + errors + " errors, " + warnings + " warnings",
    );
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
