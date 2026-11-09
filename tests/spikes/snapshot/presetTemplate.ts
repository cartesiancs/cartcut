// Writes an example template holding every bundled HTML graphic preset as an
// inline program, one after another on one track, 3 s each, for the snapshot
// spike to open in each browser. Run from the repository root:
//
//   npx jiti tests/spikes/snapshot/presetTemplate.ts <out-dir>
//
// The template lands at <out-dir>/templates/preset-gallery/, to be served as
// /examples/templates/preset-gallery/ (editor.mjs --examples=<out-dir>).
// Prints the clip order and the middle of each clip in ms.
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { createGraphicElement } from "../../../apps/app/src/features/element/graphicElement";
import { hashProgram } from "../../../apps/app/src/features/fx/programHash";

const REPO = path.resolve(__dirname, "../../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "tests/spikes/snapshot/.out/examples"));
// Optional: a comma list of presets, a clip length in ms and a template name.
const ONLY = (process.argv[3] ?? "").split(",").filter(Boolean);
const CLIP_MS = Number(process.argv[4] ?? 3000);
const NAME = process.argv[5] ?? "preset-gallery";
const TRACK = "spike-track-text";

const dir = path.join(REPO, "assets/presets/graphics");
const presets = fs
  .readdirSync(dir)
  .filter((name) => fs.existsSync(path.join(dir, name, "manifest.json")))
  .map((name) => ({ name, manifest: JSON.parse(fs.readFileSync(path.join(dir, name, "manifest.json"), "utf8")) }))
  .filter(({ manifest }) => manifest.render?.type === "html")
  .filter(({ name }) => ONLY.length === 0 || ONLY.includes(name));

const elements: Record<string, unknown> = {};
const order: Array<{ name: string; midMs: number }> = [];
presets.forEach(({ name, manifest }, index) => {
  const files = [manifest.render.source, ...(manifest.render.styles ?? [])];
  const sources: Record<string, string> = {};
  for (const file of files) {
    sources[file] = fs.readFileSync(path.join(dir, name, file), "utf8");
  }
  const content = { manifest, sources };
  const program = { hash: hashProgram(content), manifest, sources };
  const startMs = index * CLIP_MS;
  const element = createGraphicElement({
    program: program as never,
    name: manifest.name,
    startTime: startMs,
    duration: CLIP_MS,
    width: 1920,
    height: 1080,
  }) as unknown as Record<string, unknown>;
  element.trackId = TRACK;
  elements[`spike-${name}`] = element;
  order.push({ name, midMs: startMs + CLIP_MS / 2 });
});

const zip = new JSZip();
zip.file("project.json", JSON.stringify({ schemaVersion: 3 }));
zip.file("timeline.json", JSON.stringify(elements));
zip.file("tracks.json", JSON.stringify([{ id: TRACK, kind: "text", name: "T1", index: 0 }]));
zip.file(
  "renderOptions.json",
  JSON.stringify({ previewSize: { w: 1920, h: 1080 }, fps: 30, videoDuration: (presets.length * CLIP_MS) / 1000, backgroundColor: "#202830" }),
);
zip.file("assetPaths.json", JSON.stringify({ version: 1, entries: {} }));

const target = path.join(OUT, "templates", NAME);
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(
  path.join(target, "template.json"),
  JSON.stringify({ name: "Preset gallery", author: "snapshot spike", schema: 3 }),
);
zip.generateAsync({ type: "nodebuffer" }).then((buffer) => {
  fs.writeFileSync(path.join(target, "template.ngt"), buffer);
  console.log(JSON.stringify(order));
});
