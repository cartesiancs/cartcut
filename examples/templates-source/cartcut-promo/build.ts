// Build examples/templates/cartcut-promo from the author's project.
//
//   npx jiti examples/templates-source/cartcut-promo/build.ts <Sample/v7/Untitled.ngt> <Inter ttf dir>
//
// The second argument is a folder holding Inter-Regular.ttf, Inter-SemiBold.ttf
// and Inter's LICENSE.txt, from https://github.com/rsms/inter/releases (4.1).
//
// The edit, the titles and the screen recordings are the project's own. What
// changes on the way:
//
// - The titles were set in Suisse Int'l, a commercial face that cannot be
//   published; each weight is replaced by the same weight of Inter (OFL).
// - The music is left out, and so is the sound of the one clip that had any
//   (an export of a demo edit, carrying the same track): it is not ours to
//   publish.
// - The recordings are cut to the stretch the edit shows, plus `MARGIN_MS`
//   either side, and re-encoded: 311 MB in, under 20 out. A Cloudflare Pages
//   file may not exceed 25 MiB, and two of the originals were 62 MB. A cut
//   falls on a source frame, and every clip's trim moves back by exactly the
//   cut, so each frame is drawn where it was. The two recordings the edit zooms
//   into keep every pixel; the rest are never drawn wider than 1680px and are
//   scaled to 1920 wide.
// - Every recording, and the logo, becomes a slot.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  assetRefsOf, ffmpeg, ffprobeBin, fsPathOf, probe, readProject, rehashProgram, repoRoot,
  withFontDefaults, withoutElements, writeTemplate, type Elements,
} from "../from-project";

const [source, interDir] = process.argv.slice(2);
if (!source || !existsSync(source) || !interDir || !existsSync(path.join(interDir, "Inter-SemiBold.ttf"))) {
  console.error("usage: npx jiti examples/templates-source/cartcut-promo/build.ts <project.ngt> <Inter ttf dir>");
  process.exit(1);
}

const SLUG = "cartcut-promo";
const NAME = "CartCut Promo";
const site = `/examples/templates/${SLUG}`;
const outDir = path.join(repoRoot, "examples/templates", SLUG);

/** Suisse Int'l weight to the Inter file that replaces it. */
const FONT_SWAP: Record<string, string> = {
  "SuisseIntl-Regular.ttf": "Inter-Regular.ttf",
  "SuisseIntl-SemiBold.ttf": "Inter-SemiBold.ttf",
};

type Encode = { label: string; width?: number };

/**
 * Per recording: its slot label, and the width it is scaled down to. Absent
 * keeps its size, which the two the edit zooms into need (drawn up to 4051px
 * wide).
 */
const MEDIA: Record<string, Encode> = {
  "r1_build.mp4": { label: "Agent building the edit", width: 1920 },
  "r1_timeline.mp4": { label: "Timeline close-up" },
  "r2_styles.mp4": { label: "Caption styles", width: 1920 },
  "r2_styles_preview.mp4": { label: "Styles preview" },
  "r3_play_window.mp4": { label: "Playback, full window" },
  "r3_play_preview.mp4": { label: "Playback preview" },
  "r4_undo.mp4": { label: "Undo", width: 1920 },
  "r4_undo_preview.mp4": { label: "Undo preview" },
  "r4_looks_preview.mp4": { label: "Looks preview" },
  "r5_slam.mp4": { label: "Slam, full window", width: 1920 },
  "r5_slam_preview.mp4": { label: "Slam preview" },
  "r6_export.mp4": { label: "Export" },
  "demo_export.mp4": { label: "Exported video" },
  "icon.png": { label: "Logo" },
};

const project = withoutElements(await readProject(source), (el) => el.filetype === "audio");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, "media"), { recursive: true });
mkdirSync(path.join(outDir, "fonts"), { recursive: true });

/** Source ms kept either side of what the edit shows. */
const MARGIN_MS = 250;

/**
 * Encode `from`'s frames from `cutMs` for `lengthMs`. An input seek with a
 * re-encode starts on the frame at `cutMs` and stamps it 0, so source time t
 * is t - cutMs in the output. yuvj420p in, so the range conversion is
 * explicit; a one-second GOP keeps scrubbing in the editor responsive.
 */
function encode(from: string, to: string, how: Encode, cutMs: number, lengthMs: number): void {
  const scale = how.width != null ? `scale=${how.width}:-2:flags=lanczos:out_range=tv,` : "scale=out_range=tv,";
  ffmpeg([
    // Whole microseconds, rounded down: a seek rounded up past the cut frame's
    // own stamp would drop it and shift every clip on this file by a frame.
    "-ss", `${Math.floor(cutMs * 1000)}us`, "-i", from, "-t", `${Math.ceil(lengthMs * 1000)}us`,
    "-map", "0:v:0", "-an",
    "-vf", `${scale}format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", how.width != null ? "22" : "24",
    "-g", "30", "-color_range", "tv", "-movflags", "+faststart", to,
  ]);
}

/** Frame rate of the first video stream, as a number. */
function fpsOf(file: string): number {
  const out = execFileSync(ffprobeBin, [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", file,
  ]).toString().trim();
  const [n, d] = out.split("/").map(Number);
  return n / (d || 1);
}

// Pass one: the source window every recording has to keep.
const windows = new Map<string, { start: number; end: number }>();
for (const el of Object.values(project.elements) as any[]) {
  if (el.filetype !== "video") continue;
  const from = fsPathOf(el.localpath);
  const w = windows.get(from) ?? { start: Infinity, end: -Infinity };
  windows.set(from, { start: Math.min(w.start, el.trim.startTime), end: Math.max(w.end, el.trim.endTime) });
}

/** Where each recording is cut, in source ms, once it has been encoded. */
const cuts = new Map<string, number>();

const made = new Map<string, string>(); // source file -> site path
const fonts = new Set<string>();
const elements: Elements = {};
for (const [id, original] of Object.entries(project.elements)) {
  let el: any = original;
  for (const ref of assetRefsOf(el)) {
    const from = fsPathOf(ref.value);
    const base = path.basename(from);
    const swapped = FONT_SWAP[base];
    if (swapped != null) {
      if (!fonts.has(swapped)) copyFileSync(path.join(interDir, swapped), path.join(outDir, "fonts", swapped));
      fonts.add(swapped);
      el = ref.set(el, `${site}/fonts/${swapped}`);
      continue;
    }
    const how = MEDIA[base];
    if (how == null) throw new Error(`no plan for ${from}`);
    let target = made.get(from);
    if (target == null) {
      const to = path.join(outDir, "media", base);
      if (base.endsWith(".png")) {
        copyFileSync(from, to);
      } else {
        const fps = fpsOf(from);
        const total = probe(from).durationMs;
        const want = windows.get(from)!;
        // Down to a frame start, so the first kept frame is exactly at the cut.
        const cutMs = (Math.floor(((Math.max(0, want.start - MARGIN_MS)) * fps) / 1000) * 1000) / fps;
        const endMs = Math.min(total, want.end + MARGIN_MS);
        encode(from, to, how, cutMs, endMs - cutMs);
        cuts.set(from, cutMs);
      }
      target = `${site}/media/${base}`;
      made.set(from, target);
    }
    el = ref.set(el, target);
    if (el.filetype === "video" || el.filetype === "image") {
      el = { ...el, replaceable: { slotId: base.replace(/\.[^.]+$/, ""), label: how.label } };
    }
    if (el.filetype === "video") {
      const cut = cuts.get(from) ?? 0;
      const trim = { startTime: el.trim.startTime - cut, endTime: el.trim.endTime - cut };
      const p = probe(path.join(outDir, "media", base));
      if (trim.startTime < 0 || p.durationMs + 1 < trim.endTime) throw new Error(`${base} does not cover its trim`);
      el = { ...el, trim, sourceDuration: p.durationMs, origin: { width: p.width, height: p.height }, isExistAudio: false };
    }
  }
  elements[id] = el;
}

for (const [id, el] of Object.entries(elements)) {
  if (el.program == null) continue;
  const fixed = withFontDefaults(el, (from) => {
    const swapped = FONT_SWAP[path.basename(from)];
    return swapped != null && fonts.has(swapped) ? `${site}/fonts/${swapped}` : null;
  });
  elements[id] = rehashProgram(fixed);
}

copyFileSync(path.join(interDir, "LICENSE.txt"), path.join(outDir, "fonts", "OFL.txt"));

const counts = await writeTemplate({ outDir, site, name: NAME, project: { ...project, elements } });
console.log(`${SLUG}: ${counts.elements} elements on ${counts.tracks} tracks, ${made.size} media files, fonts ${[...fonts].join(", ")}`);
