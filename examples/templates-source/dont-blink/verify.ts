// Render the built template with CartCut's own compositor, frame by frame,
// and compare it with the original video.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import JSZip from "jszip";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import "../../../apps/app/src/features/renderer/testing";
import { renderTimelineAtTime } from "../../../apps/app/src/features/renderer/timeline";
import { renderText } from "../../../apps/app/src/features/renderer/text";
import { renderShape } from "../../../apps/app/src/features/renderer/shape";
import { frameToMs } from "../../../apps/app/src/features/timeline/frames";

const [tplDir, srcVideo, outDir, range, sheetEvery] = process.argv.slice(2);
for (const f of (await import("node:fs")).readdirSync(`${tplDir}/fonts`)) {
  if (f.endsWith(".ttf")) GlobalFonts.registerFromPath(`${tplDir}/fonts/${f}`, f.slice(0, -4));
}
const zip = await JSZip.loadAsync(readFileSync(`${tplDir}/template.ngt`));
const elements = JSON.parse(await zip.file("timeline.json")!.async("string"));
const site = "/examples/templates/" + tplDir.split("/").pop();
const images = new Map<string, any>();
for (const el of Object.values<any>(elements)) {
  if (el.filetype === "image" && !images.has(el.localpath)) {
    images.set(el.localpath, await loadImage(tplDir + el.localpath.slice(site.length)));
  }
}
const renderers: any = {
  text: renderText,
  shape: renderShape,
  image: (ctx: any, _id: string, el: any) => {
    const img = images.get(el.localpath);
    if (img) ctx.drawImage(img, 0, 0, el.width, el.height);
  },
  // footage is replaced on purpose; mark where it is
  video: (ctx: any, _id: string, el: any) => {
    ctx.fillStyle = "#3a2f6b";
    ctx.fillRect(0, 0, el.width, el.height);
  },
  gif: () => {},
};

const [lo, hi] = (range ?? "0-3560").split("-").map(Number);
const every = Number(sheetEvery ?? 0);
const PAIRS = new Set((process.env.PAIRS ?? "").split(",").filter(Boolean).map(Number));
mkdirSync(outDir, { recursive: true });

const W = 1280, H = 720;
// decoded exactly as the analysis decoded it: the stream starts a frame late,
// and the rawvideo muxer fills t=0 with the first frame, so frame n is the
// picture on screen at n/30 of the film
const ff = spawn("ffmpeg", ["-v", "error", "-i", srcVideo, "-frames:v", String(hi + 1), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
const chunks: Buffer[] = [];
let have = 0;
let n = 0;
const big = createCanvas(1920, 1080);
const bctx: any = big.getContext("2d");
const small = createCanvas(W, H);
const sctx: any = small.getContext("2d");
const results: any[] = [];

async function frame(buf: Buffer) {
  if (n < lo) { n++; return; }
  renderTimelineAtTime(bctx, elements, frameToMs(n, 30), renderers, "#000000", 1920, 1080);
  sctx.imageSmoothingEnabled = true;
  (sctx as any).imageSmoothingQuality = "high";
  sctx.drawImage(big, 0, 0, W, H);
  const r = (small as any).data();
  let sum = 0, cnt = 0, bad = 0;
  for (let y = 94; y < 626; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const g0 = (buf[i * 3] + buf[i * 3 + 1] + buf[i * 3 + 2]) / 3;
      const g1 = (r[i * 4] + r[i * 4 + 1] + r[i * 4 + 2]) / 3;
      const d = Math.abs(g0 - g1);
      sum += d; cnt++;
      if (d > 64) bad++;
    }
  }
  results.push({ n, mad: +(sum / cnt).toFixed(3), bad });
  if ((every && (n - lo) % every === 0) || PAIRS.has(n)) {
    const pair = createCanvas(W, H * 2);
    const pc: any = pair.getContext("2d");
    const img = pc.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      img.data[i * 4] = buf[i * 3]; img.data[i * 4 + 1] = buf[i * 3 + 1]; img.data[i * 4 + 2] = buf[i * 3 + 2]; img.data[i * 4 + 3] = 255;
    }
    pc.putImageData(img, 0, 0);
    pc.drawImage(small, 0, H);
    writeFileSync(`${outDir}/pair-${String(n).padStart(4, "0")}.png`, pair.toBuffer("image/png"));
  }
  n++;
}

const FRAME = W * H * 3;
let pending = Buffer.alloc(0);
for await (const chunk of ff.stdout) {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= FRAME) {
    await frame(pending.subarray(0, FRAME));
    pending = pending.subarray(FRAME);
  }
}
writeFileSync(`${outDir}/metrics.json`, JSON.stringify(results));
const mean = results.reduce((a, r) => a + r.mad, 0) / results.length;
console.log("frames", results.length, "mean abs diff", mean.toFixed(3));
