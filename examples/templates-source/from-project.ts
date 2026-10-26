// Turns a CartCut project into an example template folder: the shared half of
// every `build.ts` here that starts from a `.ngt` rather than from a spec.
//
// The folder is laid out as an extracted `.cttpl` (`templateLink.ts`): the
// document at `template.ngt`, its files beside it, and every path in it a site
// path under `/examples/templates/<slug>/`, recorded relative in
// `assetPaths.json` by the same `serializeAssetPaths` a project save uses.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { normalizeDocument, schemaVersionFor, type TimelineTrack } from "../../apps/app/src/features/timeline/tracks";
import { assetFieldsOf, graphicAssetRefsOf, serializeAssetPaths, withGraphicAssetRef } from "../../apps/app/src/features/project/assetsFile";
import { coerceInlineProgram, hashProgram, inlinePresetId } from "../../apps/app/src/features/fx/inlineProgram";
import { spanEnd } from "../../apps/app/src/features/timeline/geometry";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const binDir = path.join(repoRoot, "bin", `${process.platform}-${process.arch}`);
export const ffmpegBin = path.join(binDir, "ffmpeg");
export const ffprobeBin = path.join(binDir, "ffprobe");

export type Elements = Record<string, any>;

export type SourceProject = {
  elements: Elements;
  tracks: TimelineTrack[];
  renderOptions: Record<string, any>;
};

export async function readProject(ngtPath: string): Promise<SourceProject> {
  const zip = await JSZip.loadAsync(readFileSync(ngtPath));
  const json = async (name: string) => {
    const file = zip.file(name);
    return file == null ? null : JSON.parse(await file.async("string"));
  };
  return {
    elements: (await json("timeline.json")) ?? {},
    tracks: (await json("tracks.json")) ?? [],
    renderOptions: (await json("renderOptions.json")) ?? {},
  };
}

/** A `localpath` or font path as a filesystem path: a `file://` URL loses its scheme. */
export function fsPathOf(value: string): string {
  return value.startsWith("file://") ? value.slice("file://".length) : value;
}

/** Every file path an element names, with a setter that writes a new one back. */
export function assetRefsOf(element: any): { value: string; set: (el: any, next: string) => any }[] {
  const refs: { value: string; set: (el: any, next: string) => any }[] = [];
  for (const field of assetFieldsOf(element)) {
    const value = element[field];
    if (typeof value === "string" && value !== "" && !/^(https?|blob|data):/i.test(value)) {
      refs.push({ value, set: (el, next) => ({ ...el, [field]: next }) });
    }
  }
  for (const ref of graphicAssetRefsOf(element)) {
    refs.push({ value: ref.value, set: (el, next) => withGraphicAssetRef(el, ref.suffix, next) });
  }
  return refs;
}

/**
 * A font parameter's default inside an inline program's manifest, rewritten.
 *
 * A graphic made from a text clip keeps the author's font path as the
 * parameter's default, and neither `graphicAssetRefsOf` nor `exportPlan.ts`
 * looks there, so a template would publish a path on the author's machine and
 * a reset parameter would name a file nobody has. `resolve` answers the site
 * path of a face the folder ships, or `null` for one it does not.
 */
export function withFontDefaults(element: any, resolve: (fsPath: string) => string | null): any {
  const params = element.program?.manifest?.params;
  if (!Array.isArray(params)) return element;
  let changed = false;
  const next = params.map((param: any) => {
    if (param?.type !== "font" || typeof param.default !== "string" || !param.default.startsWith("/")) {
      return param;
    }
    changed = true;
    return { ...param, default: resolve(fsPathOf(param.default)) ?? "default" };
  });
  if (!changed) return element;
  return {
    ...element,
    program: { ...element.program, manifest: { ...element.program.manifest, params: next } },
  };
}

/**
 * Re-key an inline program after its assets moved, so the stored hash and the
 * `inline.` id name the content they sit beside. `resolvePreset` would cope
 * with a stale one; a published template should not need it to.
 */
export function rehashProgram(element: any): any {
  if (element.program == null) return element;
  const { hash: _hash, ...content } = element.program;
  const hash = hashProgram(content);
  return { ...element, presetId: inlinePresetId(hash), program: { ...element.program, hash } };
}

/**
 * An installed preset carried on the clip instead, so the template draws its
 * effects where no preset library is installed: the browser build has none,
 * and an effect naming a preset nobody has renders as a pass-through.
 */
export function inlineInstalledPreset(element: any, presetDir: string): any {
  const manifest = JSON.parse(readFileSync(path.join(presetDir, "manifest.json"), "utf8"));
  const render = manifest.render;
  if (render?.type !== "shader" || render.passes != null) {
    throw new Error(`${manifest.id}: only a single-pass shader preset can be inlined here`);
  }
  const result = coerceInlineProgram({
    kind: manifest.kind,
    name: manifest.name,
    category: manifest.category,
    render: { type: "shader", fragment: readFileSync(path.join(presetDir, render.source), "utf8") },
    params: manifest.params,
  });
  if (!result.ok) {
    throw new Error(`${manifest.id}: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return { ...element, presetId: inlinePresetId(result.program.hash), program: result.program };
}

/** Drop elements, and any track nothing is left on. */
export function withoutElements(project: SourceProject, drop: (el: any) => boolean): SourceProject {
  const elements: Elements = {};
  for (const [id, el] of Object.entries(project.elements)) {
    if (!drop(el)) elements[id] = el;
  }
  const used = new Set(Object.values(elements).map((el: any) => el.trackId));
  return { ...project, elements, tracks: project.tracks.filter((t) => used.has(t.id)) };
}

/**
 * The SIL OFL 1.1 text under the copyright lines of the faces a folder ships.
 * Taken from the notice Don't Blink already carries, below its own copyright.
 */
export function oflNotice(copyrights: string[]): string {
  const ofl = readFileSync(path.join(repoRoot, "examples/templates/dont-blink/fonts/OFL.txt"), "utf8");
  const body = ofl.slice(ofl.indexOf("This Font Software is licensed"));
  return copyrights.join("\n") + "\n\n" + body;
}

export type Probe = { width: number; height: number; durationMs: number };

export function probe(file: string): Probe {
  const out = execFileSync(ffprobeBin, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration", "-of", "json", file,
  ]).toString();
  const parsed = JSON.parse(out);
  const stream = parsed.streams?.[0] ?? {};
  return { width: stream.width, height: stream.height, durationMs: Number(parsed.format?.duration ?? 0) * 1000 };
}

export function ffmpeg(args: string[]): void {
  execFileSync(ffmpegBin, ["-v", "error", "-y", ...args], { stdio: "inherit" });
}

/**
 * Write `template.ngt` and `template.json`.
 *
 * `renderOptions` is rebuilt from four keys rather than copied: the author's
 * own carries `videoDestination`, a path on their machine.
 */
export async function writeTemplate(args: {
  outDir: string;
  site: string;
  name: string;
  project: SourceProject;
}): Promise<{ elements: number; tracks: number }> {
  const { outDir, site, name, project } = args;
  const tracks = project.tracks.map((t, index) => ({ ...t, index }));
  const doc = normalizeDocument({ schemaVersion: 2, tracks, elements: project.elements } as any);

  let end = 0;
  for (const el of Object.values(doc.elements)) {
    end = Math.max(end, spanEnd(el as any));
  }
  const source = project.renderOptions;
  const renderOptions = {
    previewSize: { w: source.previewSize?.w ?? 1920, h: source.previewSize?.h ?? 1080 },
    fps: source.fps ?? 30,
    videoDuration: Math.ceil(end / 1000),
    backgroundColor: source.backgroundColor ?? "#000000",
  };

  const ngtPath = `${site}/template.ngt`;
  const zip = new JSZip();
  // A fixed date, so a rebuild with nothing changed is byte-identical.
  const date = new Date("2026-01-01T00:00:00Z");
  const put = (file: string, value: unknown) => zip.file(file, JSON.stringify(value), { date });
  const schemaVersion = schemaVersionFor(doc.elements);
  put("project.json", { schemaVersion });
  put("timeline.json", doc.elements);
  put("tracks.json", doc.tracks);
  put("renderOptions.json", renderOptions);
  put("assetPaths.json", serializeAssetPaths(doc.elements as any, ngtPath));

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "template.ngt"),
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } }),
  );
  writeFileSync(
    path.join(outDir, "template.json"),
    // `schema` is what the cloud server lists, so the app can hide a template
    // its build cannot open; the server refuses a folder without it.
    JSON.stringify(
      { name, author: "CartCut examples", thumbnail: "thumbnail.jpg", schema: schemaVersion },
      null,
      2,
    ) + "\n",
  );
  return { elements: Object.keys(doc.elements).length, tracks: doc.tracks.length };
}
