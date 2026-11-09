// Pixel difference between preview captures, and a side-by-side sheet.
//
//   node tests/spikes/snapshot/compare.mjs --ref=a.png --out=sheet.png b.png c.png ...
//
// For each candidate: the mean absolute difference per channel (0 to 255),
// and the share of pixels differing by more than 48 on any channel.
import fs from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit == null ? null : hit.slice(name.length + 3);
};
const REF = arg("ref");
const OUT = arg("out");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const ref = await loadImage(fs.readFileSync(REF));
const w = ref.width;
const h = ref.height;
const pixels = async (file) => {
  const img = await loadImage(fs.readFileSync(file));
  const c = createCanvas(w, h);
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return { img, data: c.getContext("2d").getImageData(0, 0, w, h).data };
};
const base = (await pixels(REF)).data;
const rows = [];
const images = [ref];
for (const file of files) {
  const { img, data } = await pixels(file);
  images.push(img);
  let sum = 0;
  let far = 0;
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.max(Math.abs(data[i] - base[i]), Math.abs(data[i + 1] - base[i + 1]), Math.abs(data[i + 2] - base[i + 2]));
    sum += Math.abs(data[i] - base[i]) + Math.abs(data[i + 1] - base[i + 1]) + Math.abs(data[i + 2] - base[i + 2]);
    if (d > 48) far += 1;
  }
  rows.push({ file: file.split("/").pop(), mean: +(sum / (w * h * 3)).toFixed(2), farPct: +((100 * far) / (w * h)).toFixed(2) });
}
console.log(JSON.stringify(rows, null, 1));
if (OUT != null) {
  const scale = 0.5;
  const sheet = createCanvas(Math.round(w * scale) * images.length, Math.round(h * scale) + 20);
  const ctx = sheet.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.fillStyle = "#fff";
  ctx.font = "14px sans-serif";
  images.forEach((img, i) => {
    ctx.drawImage(img, i * Math.round(w * scale), 20, Math.round(w * scale), Math.round(h * scale));
    ctx.fillText(i === 0 ? REF.split("/").pop() : files[i - 1].split("/").pop(), i * Math.round(w * scale) + 4, 14);
  });
  fs.writeFileSync(OUT, sheet.toBuffer("image/png"));
}
