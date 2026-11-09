// Scores a preset gallery capture against a reference engine and draws a grid:
// one row per preset, one column per engine.
//
//   node tests/spikes/snapshot/grid.mjs --dir=<shots> --ref=chrome157 \
//        --engines=webkit,firefox,chromium --times=1500,4500,... --names=a,b,... --out=grid.png
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit == null ? null : hit.slice(name.length + 3);
};
const DIR = arg("dir");
const REF = arg("ref");
const ENGINES = arg("engines").split(",");
const TIMES = arg("times").split(",");
const NAMES = arg("names").split(",");
const OUT = arg("out");
const PREFIX = arg("prefix") ?? "preset-gallery";

const cell = { w: 320, h: 180 };
const columns = [REF, ...ENGINES];
const sheet = createCanvas(140 + cell.w * columns.length, 20 + cell.h * TIMES.length);
const ctx = sheet.getContext("2d");
ctx.fillStyle = "#000";
ctx.fillRect(0, 0, sheet.width, sheet.height);
ctx.fillStyle = "#fff";
ctx.font = "13px sans-serif";
columns.forEach((engine, c) => ctx.fillText(engine, 140 + c * cell.w + 4, 14));

const read = async (file) => {
  const img = await loadImage(fs.readFileSync(file));
  const c = createCanvas(img.width, img.height);
  c.getContext("2d").drawImage(img, 0, 0);
  return { img, data: c.getContext("2d").getImageData(0, 0, img.width, img.height).data };
};

const table = [];
for (let r = 0; r < TIMES.length; r += 1) {
  const name = NAMES[r];
  ctx.fillStyle = "#fff";
  ctx.fillText(name, 4, 20 + r * cell.h + cell.h / 2);
  const ref = await read(path.join(DIR, `${PREFIX}-${REF}-${TIMES[r]}.png`));
  const row = { name };
  for (let c = 0; c < columns.length; c += 1) {
    const file = path.join(DIR, `${PREFIX}-${columns[c]}-${TIMES[r]}.png`);
    if (!fs.existsSync(file)) {
      row[columns[c]] = "missing";
      continue;
    }
    const shot = await read(file);
    ctx.drawImage(shot.img, 140 + c * cell.w, 20 + r * cell.h, cell.w, cell.h);
    if (c === 0) continue;
    let sum = 0;
    let far = 0;
    const n = Math.min(shot.data.length, ref.data.length);
    for (let i = 0; i < n; i += 4) {
      const d = Math.max(
        Math.abs(shot.data[i] - ref.data[i]),
        Math.abs(shot.data[i + 1] - ref.data[i + 1]),
        Math.abs(shot.data[i + 2] - ref.data[i + 2]),
      );
      sum += d;
      if (d > 48) far += 1;
    }
    const pixels = n / 4;
    row[columns[c]] = `${(sum / pixels).toFixed(2)} / ${((100 * far) / pixels).toFixed(2)}%`;
  }
  table.push(row);
}
fs.writeFileSync(OUT, sheet.toBuffer("image/png"));
console.log("mean max-channel difference / share of pixels off by more than 48");
for (const row of table) {
  console.log(row.name.padEnd(18), ENGINES.map((e) => `${e}: ${row[e]}`.padEnd(30)).join(""));
}
