// Build the template's document from the measured spec.
//
// spec = {
//   frames: number, fps: number,
//   white: [[from, to], ...],                       // white panel runs (inclusive)
//   media: [{ name, label, from, to, file, w, h }],  // footage slots
//   logos: [{ name, label, file, w, h, from, to, poses: [{n,x,y,s,op}] }],
//   texts: [{ text, color, F, L, W, H, poses: [{n,x,y,s,op}] }],
// }
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { createTextElement } from "../../../apps/app/src/features/element/textElement";
import { createShapeElement } from "../../../apps/app/src/features/element/shapeElement";
import { bakeTrack, emptyAnimation, bakeRateFor } from "../../../apps/app/src/features/animation/keyframes";
import { frameToMs } from "../../../apps/app/src/features/timeline/frames";
import { normalizeDocument, schemaVersionFor, type TimelineTrack } from "../../../apps/app/src/features/timeline/tracks";
import { serializeAssetPaths } from "../../../apps/app/src/features/project/assetsFile";

const here = path.dirname(fileURLToPath(import.meta.url));
const specPath = process.argv[2] ?? `${here}/spec.json`;
const outDir = process.argv[3] ?? `${here}/../../templates/dont-blink`;
const siteDir = process.argv[4] ?? "/examples/templates/dont-blink";
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const FPS = spec.fps;
const HZ = bakeRateFor(FPS);
const T = (n: number) => frameToMs(n, FPS);
const PANEL = { x: 0, y: 140, w: 1920, h: 800 };

type Pose = { n: number; x: number; y: number; s: number; op: number };

/** Douglas-Peucker over a per-frame series: the frames a linear curve must keep. */
function keepFrames(vals: number[], tol: number): boolean[] {
  const keep = vals.map(() => false);
  if (vals.length === 0) return keep;
  keep[0] = true;
  keep[vals.length - 1] = true;
  const stack: [number, number][] = [[0, vals.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const lin = vals[a] + ((vals[b] - vals[a]) * (i - a)) / (b - a);
      const d = Math.abs(vals[i] - lin);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = true; stack.push([a, at], [at, b]); }
  }
  return keep;
}

function kf(t: number, v: number) {
  return { type: "linear", p: [t, v], cs: [t, v], ce: [t, v] };
}

function lane(times: number[], vals: number[], keep: boolean[]) {
  const list = times.map((t, i) => (keep[i] ? kf(t, vals[i]) : null)).filter(Boolean) as any[];
  return { list, baked: bakeTrack(list, HZ) };
}

const same = (vals: number[], tol: number) => vals.every((v) => Math.abs(v - vals[0]) <= tol);

/**
 * A clip held from `from` to `to` (inclusive) whose box moves per frame.
 * Constant channels become static fields; the rest become linear keyframes.
 */
function animate(el: any, poses: Pose[], from: number) {
  const start = T(from);
  const times = poses.map((p) => T(p.n) - start);
  const xs = poses.map((p) => p.x), ys = poses.map((p) => p.y);
  const ss = poses.map((p) => p.s * 10), ops = poses.map((p) => p.op * 100);
  el.animation = emptyAnimation(el.filetype);
  const P = 0.05, S = 0.004, O = 0.6; // position px, scale tenths, opacity %
  if (same(xs, P) && same(ys, P)) {
    el.location = { x: xs[0], y: ys[0] };
  } else {
    const kx = keepFrames(xs, P), ky = keepFrames(ys, P);
    const keep = kx.map((k, i) => k || ky[i]);
    const lx = lane(times, xs, keep), ly = lane(times, ys, keep);
    el.location = { x: xs[0], y: ys[0] };
    el.animation.position = { isActivate: true, x: lx.list, y: ly.list, ax: lx.baked, ay: ly.baked };
  }
  if (same(ss, S)) {
    if (Math.abs(ss[0] - 10) > 1e-9) el.scale = ss[0];
  } else {
    const l = lane(times, ss, keepFrames(ss, S));
    el.animation.scale = { isActivate: true, x: l.list, ax: l.baked };
  }
  if (same(ops, O)) {
    el.opacity = Math.round(ops[0] * 100) / 100;
  } else {
    const l = lane(times, ops, keepFrames(ops, O));
    el.opacity = 100;
    el.animation.opacity = { isActivate: true, x: l.list, ax: l.baked };
  }
}

const elements: Record<string, any> = {};
type Row = { kind: "video" | "text"; clips: [number, number][]; ids: string[] };
const layers: Record<string, Row[]> = { bars: [], overlay: [], text: [], glyph: [], logo: [], shape: [], media: [], white: [], base: [] };
let nextId = 0;
const idOf = (p: string) => `${p}-${String(nextId++).padStart(4, "0")}`;

function place(layer: string, kind: "video" | "text", id: string, from: number, to: number) {
  const rows = layers[layer];
  let row = rows.find((r) => r.clips.every(([a, b]) => to < a || from > b));
  if (!row) { row = { kind, clips: [], ids: [] }; rows.push(row); }
  row.clips.push([from, to]);
  row.ids.push(id);
}

function span(el: any, from: number, to: number) {
  el.startTime = T(from);
  el.duration = T(to + 1) - T(from);
}

const total = spec.frames;
const site = siteDir; // the site path the folder is served from

// the black frame and the panel behind everything, and the letterbox bars in
// front of everything, so a title zooming past the panel is cut where the
// original cuts it
{
  // rows fill front to back, so the panel goes in before the black behind it
  const panel = createShapeElement({ kind: "rectangle", width: PANEL.w, height: PANEL.h, locationX: PANEL.x, locationY: PANEL.y, fillColor: "#111111" });
  // the film's last frame is black from edge to edge
  span(panel, 0, total - 2);
  const pid = idOf("panel"); elements[pid] = panel; place("base", "video", pid, 0, total - 2);
  const back = createShapeElement({ kind: "rectangle", width: 1920, height: 1080, fillColor: "#000000" });
  span(back, 0, total - 1);
  const id = idOf("frame"); elements[id] = back; place("base", "video", id, 0, total - 1);
  for (const [y, h] of [[0, PANEL.y], [PANEL.y + PANEL.h, 1080 - PANEL.y - PANEL.h]]) {
    const bar = createShapeElement({ kind: "rectangle", width: 1920, height: h, locationX: 0, locationY: y, fillColor: "#000000" });
    span(bar, 0, total - 1);
    const bid = idOf("bar"); elements[bid] = bar; place("bars", "video", bid, 0, total - 1);
  }
}

for (const [a, b] of spec.white) {
  const el = createShapeElement({ kind: "rectangle", width: PANEL.w, height: PANEL.h, locationX: PANEL.x, locationY: PANEL.y, fillColor: "#ffffff" });
  span(el, a, b);
  const id = idOf("white"); elements[id] = el; place("white", "video", id, a, b);
}

for (const m of spec.media) {
  const dur = T(m.to + 1) - T(m.from);
  const slack = T(1);
  const srcMs = (m.frames ?? m.to - m.from + 3) * (1000 / FPS);
  const el: any = {
    trackId: "", priority: 0, blob: "",
    startTime: T(m.from), duration: dur, opacity: 100,
    location: { x: PANEL.x, y: PANEL.y },
    trim: { startTime: slack, endTime: slack + dur },
    sourceDuration: srcMs, rotation: 0,
    width: PANEL.w, height: PANEL.h, ratio: PANEL.w / PANEL.h,
    localpath: `${site}/media/${m.file}`, isExistAudio: false, filetype: "video",
    codec: { video: "default", audio: "default" }, speed: 1,
    filter: { enable: false, list: [] }, origin: { width: m.w, height: m.h },
    animation: emptyAnimation("video"),
    timelineOptions: { color: "rgb(71, 59, 179)" },
    replaceable: { slotId: m.name, label: m.label },
  };
  const id = idOf("media"); elements[id] = el; place("media", "video", id, m.from, m.to);
}

for (const g of spec.logos ?? []) {
  const el: any = {
    trackId: "", priority: 0, blob: "", opacity: 100, rotation: 0,
    location: { x: 0, y: 0 }, width: g.w, height: g.h, ratio: g.w / g.h,
    localpath: `${site}/media/${g.file}`, filetype: "image",
    animation: emptyAnimation("image"),
    timelineOptions: { color: "rgb(134, 41, 143)" },
    replaceable: { slotId: g.name, label: g.label },
  };
  span(el, g.from, g.to);
  animate(el, g.poses, g.from);
  const id = idOf("logo"); elements[id] = el; place("logo", "video", id, g.from, g.to);
}

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (bg: string, fg: string, r: number) => {
  const a = hex(bg), b = hex(fg);
  return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * r).toString(16).padStart(2, "0")).join("");
};
/** A character's strength relative to the element's own opacity, quantised. */
// Our face lays down a few percent less ink than the original's, so a
// strength measured just under full is full.
const FULL_CHAR = 0.85, FULL_OP = 0.93;
const patternOf = (p: any) => {
  if (!p.ops || p.ops.every((o: number) => o >= FULL_CHAR)) return null;
  return p.ops.map((o: number) => (o < 0.03 ? 0 : o >= FULL_CHAR ? 64 : Math.round(o * 64)));
};
for (const t of spec.texts) {
  for (const p of t.poses) if (p.op >= FULL_OP) p.op = 1;
  // one element per stretch of frames whose characters hold the same strengths
  const segs: { pat: number[] | null; poses: any[] }[] = [];
  for (const p of t.poses) {
    const pat = t.chars ? patternOf(p) : null;
    const last = segs[segs.length - 1];
    const lastP = last?.poses[last.poses.length - 1];
    if (last && JSON.stringify(last.pat) === JSON.stringify(pat) && lastP.n === p.n - 1) last.poses.push(p);
    else segs.push({ pat, poses: [p] });
  }
  for (const seg of segs) {
    const from = seg.poses[0].n, to = seg.poses[seg.poses.length - 1].n;
    const el: any = createTextElement({
      text: t.text, textcolor: t.fg, fontsize: t.F, optionsAlign: "center",
      width: t.W, height: t.H, letterSpacing: t.L,
      fontpath: `${site}/fonts/${t.font ?? "InterDisplay-Bold"}.ttf`, fontname: t.font ?? "InterDisplay-Bold", fonttype: "ttf",
    });
    el.fontweight = "normal";
    if (seg.pat) {
      const runs: any[] = [];
      for (let i = 0; i < t.text.length; i++) {
        const c = mix(t.bg, t.fg, seg.pat[i] / 64);
        const last = runs[runs.length - 1];
        if (last && last.style.color === c) last.to = i + 1;
        else runs.push({ from: i, to: i + 1, style: { color: c } });
      }
      // a run in the element's own colour is the element's colour already
      el.runs = runs.filter((r) => r.style.color !== t.fg);
      if (el.runs.length === 0) delete el.runs;
    }
    span(el, from, to);
    animate(el, seg.poses, from);
    if (t.slot) el.replaceable = { slotId: t.slot, label: t.slotLabel ?? t.text };
    const layer = t.layer === "glyph" ? "glyph" : t.layer === "overlay" ? "overlay" : "text";
    const id = idOf("text"); elements[id] = el; place(layer, "text", id, from, to);
  }
}

for (const r of spec.rects ?? []) {
  const el = createShapeElement({
    kind: "rectangle", width: r.w, height: r.h, locationX: r.x, locationY: r.y, fillColor: r.color,
    ...(r.radius ? { geometry: { kind: "rectangle", radius: r.radius } as any } : {}),
  });
  span(el, r.from, r.to);
  if (r.poses) animate(el, r.poses, r.from);
  const id = idOf("rect"); elements[id] = el; place(r.layer ?? "shape", "video", id, r.from, r.to);
}
for (const g of spec.shapes ?? []) {
  const el = createShapeElement({ shape: g.points, width: g.w, height: g.h, locationX: g.x, locationY: g.y, oWidth: g.ow, oHeight: g.oh, fillColor: g.color });
  span(el, g.from, g.to);
  const id = idOf("shape"); elements[id] = el; place(g.layer ?? "shape", "video", id, g.from, g.to);
}

// rows, front to back
const tracks: TimelineTrack[] = [];
let index = 0;
for (const layer of ["bars", "overlay", "text", "glyph", "logo", "shape", "media", "white", "base"]) {
  for (const row of layers[layer]) {
    const tid = `track-${layer}-${index}`;
    tracks.push({ id: tid, kind: row.kind, name: "", index });
    for (const id of row.ids) elements[id].trackId = tid;
    index++;
  }
}

const doc = normalizeDocument({ schemaVersion: 2, tracks, elements } as any);
const ngtPath = `${site}/template.ngt`;
const project = { schemaVersion: schemaVersionFor(doc.elements), name: spec.name };
const renderOptions = {
  previewSize: { w: 1920, h: 1080 }, fps: FPS,
  duration: Math.ceil(T(total) / 1000), backgroundColor: "#000000",
};
const assetPaths = serializeAssetPaths(doc.elements as any, ngtPath);

mkdirSync(outDir, { recursive: true });
const zip = new JSZip();
zip.file("project.json", JSON.stringify(project));
zip.file("timeline.json", JSON.stringify(doc.elements));
zip.file("tracks.json", JSON.stringify(doc.tracks));
zip.file("renderOptions.json", JSON.stringify(renderOptions));
zip.file("assetPaths.json", JSON.stringify(assetPaths));
writeFileSync(`${outDir}/template.ngt`, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } }));
writeFileSync(`${outDir}/template.json`, JSON.stringify({ name: spec.name, author: spec.author, thumbnail: "thumbnail.jpg", schema: project.schemaVersion }, null, 2) + "\n");
console.log("elements", Object.keys(doc.elements).length, "tracks", doc.tracks.length);
