// Build examples/templates/feynman from the author's project.
//
//   npx jiti examples/templates-source/feynman/build.ts <Sample/v5/Untitled.ngt>
//
// The edit, the titles and the effects are the project's own. Every clip and
// photo becomes a slot holding a stand-in, and the music is left out: the
// footage and the track are not ours to publish. A stand-in is the shot's
// light and dark averaged down to a 4x3 grid and blown up into a soft field,
// so a slot still reads as a bright or a dark shot and nothing of the picture
// survives.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assetRefsOf, ffmpeg, fsPathOf, inlineInstalledPreset, oflNotice, probe, readProject,
  rehashProgram, repoRoot, withFontDefaults, withoutElements, writeTemplate, type Elements,
} from "../from-project";

const source = process.argv[2];
if (!source || !existsSync(source)) {
  console.error("usage: npx jiti examples/templates-source/feynman/build.ts <project.ngt>");
  process.exit(1);
}

const SLUG = "feynman";
const NAME = "Feynman";
const site = `/examples/templates/${SLUG}`;
const outDir = path.join(repoRoot, "examples/templates", SLUG);
const FPS = 60;

/** What the template's slot list calls each shot, by its file name. */
const LABELS: Record<string, string> = {
  s01_sq: "Opening portrait",
  p_sq_1960: "Intro photo 1",
  p_sq_1963: "Intro photo 2",
  p_sq_bongos: "Intro photo 3",
  p_sq_1988: "Intro photo 4 and end card",
  s02_full: "Name title",
  s03_phys: "Physicist",
  s04_teach: "Teacher",
  s05_drum: "Drummer",
  p_full_opp: "Safecracker",
  s07_story: "Storyteller",
  p_card_badge: "Manhattan Project portrait",
  p_full_1959: "Nobel Prize photo",
  s10a: "Great Explainer 1",
  s10b: "Great Explainer 2",
  s10c: "Great Explainer 3",
  s10d: "Great Explainer 4",
  s13_oringA: "Challenger 1",
  s14_oringB: "Challenger 2",
  s15_oringC: "Challenger 3",
  m1: "Pleasure montage 1",
  m2: "Pleasure montage 2",
  m3: "Pleasure montage 3",
  m4: "Pleasure montage 4",
  m5: "Pleasure montage 5",
  m6: "Pleasure montage 6",
  m7: "Pleasure montage 7",
  m8: "Pleasure montage 8",
  p_full_1939: "Year 1939",
  p_full_badge: "Year 1943",
  p_full_1959t: "Year 1959",
  p_full_1974: "Year 1974",
};

const FONT_COPYRIGHTS: Record<string, string> = {
  PlayfairDisplay: 'Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display".',
  InstrumentSerif: "Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif)",
};

const stem = (file: string) => path.basename(file).replace(/\.[^.]+$/, "");
const work = mkdtempSync(path.join(tmpdir(), "cartcut-feynman-"));

/** A soft field in the shot's own tones, at its size; video drifts sideways. */
function standIn(from: string, to: string, kind: "video" | "image"): void {
  const src = probe(from);
  const w = src.width, h = src.height;
  const grid = w === h ? "3:3" : "4:3";
  const tiny = path.join(work, `${stem(from)}-tiny.png`);
  const still = path.join(work, `${stem(from)}-still.png`);
  // A seek on a still drops its only frame, so only a video is seeked.
  const seek = kind === "video" ? ["-ss", (src.durationMs / 2000).toFixed(3)] : [];
  ffmpeg([...seek, "-i", from, "-frames:v", "1", "-update", "1", "-vf", `scale=${grid}:flags=area`, tiny]);
  // Drawn 8% wide so the video can drift across the spare without an edge.
  const W = kind === "video" ? Math.ceil((w * 1.08) / 2) * 2 : w;
  ffmpeg(["-i", tiny, "-frames:v", "1", "-update", "1", "-vf", `scale=${W}:${h}:flags=bicubic,gblur=sigma=${Math.round(h / 7)}`, still]);
  if (kind === "image") {
    ffmpeg(["-i", still, "-frames:v", "1", "-update", "1", "-q:v", "3", to]);
    return;
  }
  const frames = Math.round((src.durationMs * FPS) / 1000);
  const seconds = (frames / FPS).toFixed(6);
  ffmpeg([
    "-loop", "1", "-framerate", String(FPS), "-i", still,
    "-frames:v", String(frames),
    "-vf", `crop=${w}:${h}:x='(iw-ow)*t/${seconds}':y=0,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "30", "-g", String(FPS),
    "-movflags", "+faststart", "-an", to,
  ]);
}

const project = withoutElements(await readProject(source), (el) => el.filetype === "audio");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, "media"), { recursive: true });
mkdirSync(path.join(outDir, "fonts"), { recursive: true });

const effectDirs = new Map<string, string>();
const effectsRoot = path.join(repoRoot, "assets/presets/effects");
for (const dir of readdirSync(effectsRoot)) {
  const manifest = path.join(effectsRoot, dir, "manifest.json");
  if (existsSync(manifest)) effectDirs.set(JSON.parse(readFileSync(manifest, "utf8")).id, path.join(effectsRoot, dir));
}

const made = new Map<string, string>(); // source file -> site path
const fonts = new Set<string>();
const elements: Elements = {};
for (const [id, original] of Object.entries(project.elements)) {
  let el: any = original;

  if (el.filetype === "effect" && typeof el.presetId === "string" && !el.presetId.startsWith("inline.")) {
    const dir = effectDirs.get(el.presetId);
    if (dir == null) throw new Error(`no installed preset ${el.presetId}`);
    el = inlineInstalledPreset(el, dir);
  }

  for (const ref of assetRefsOf(el)) {
    const from = fsPathOf(ref.value);
    if (/\.(ttf|otf|woff2?)$/i.test(from)) {
      const file = path.basename(from);
      if (!fonts.has(file)) copyFileSync(from, path.join(outDir, "fonts", file));
      fonts.add(file);
      el = ref.set(el, `${site}/fonts/${file}`);
      continue;
    }
    let target = made.get(from);
    if (target == null) {
      const kind = el.filetype === "image" ? "image" : "video";
      const file = `${stem(from)}.${kind === "image" ? "jpg" : "mp4"}`;
      standIn(from, path.join(outDir, "media", file), kind);
      target = `${site}/media/${file}`;
      made.set(from, target);
    }
    el = ref.set(el, target);
    if (el.filetype === "video" || el.filetype === "image") {
      const label = LABELS[stem(from)];
      if (label == null) throw new Error(`no slot label for ${from}`);
      el = { ...el, replaceable: { slotId: stem(from), label } };
    }
    if (el.filetype === "video") {
      const p = probe(path.join(outDir, "media", path.basename(target)));
      if (p.durationMs + 1 < el.trim.endTime) throw new Error(`${target} is shorter than its trim`);
      el = { ...el, sourceDuration: p.durationMs, origin: { width: p.width, height: p.height }, isExistAudio: false };
    }
  }
  elements[id] = el;
}

// Defaults after every element, so a default naming a face some other clip
// uses still finds it shipped.
for (const [id, el] of Object.entries(elements)) {
  if (el.program == null) continue;
  const fixed = withFontDefaults(el, (from) => (fonts.has(path.basename(from)) ? `${site}/fonts/${path.basename(from)}` : null));
  elements[id] = rehashProgram(fixed);
}

const families = new Set([...fonts].map((f) => f.replace(/-.*$/, "")));
writeFileSync(path.join(outDir, "fonts", "OFL.txt"), oflNotice([...families].sort().map((f) => FONT_COPYRIGHTS[f])));

const counts = await writeTemplate({ outDir, site, name: NAME, project: { ...project, elements } });
rmSync(work, { recursive: true, force: true });
console.log(`${SLUG}: ${counts.elements} elements on ${counts.tracks} tracks, ${made.size} stand-ins, fonts ${[...fonts].join(", ")}`);
