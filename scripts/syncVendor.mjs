// Rebuilds apps/app/vendor/ from node_modules.
//
// The app must run with the machine offline, so Bootstrap and Noto Sans KR are
// files on disk rather than jsDelivr and Google Fonts <link>s. Those copies can
// drift from the installed packages — `npm update` moves node_modules and
// nothing moves the copies — so `apps/app/src/vendorSync.test.ts` pins them,
// and this script is how you satisfy it after a version bump.
//
//   npm run vendor:sync
//
// It does not touch the frozen DeVent files: they have no npm package behind
// them, only a recorded hash. See apps/app/vendor/manifest.mjs.

import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FONT_SOURCE, VENDORED_FILES } from "../apps/app/vendor/manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const abs = (p) => path.join(root, p);

for (const { source, vendored } of VENDORED_FILES) {
  await copyFile(abs(source), abs(vendored));
  console.log(`${source} -> ${vendored}`);
}

// The font stylesheet is rewritten rather than copied — the family name and the
// path to the woff2 files both change. Both rewrites are explained in the
// manifest; neither is cosmetic.
const css = await readFile(abs(FONT_SOURCE.packageCss), "utf8");
const rewritten = css
  .replaceAll(`'${FONT_SOURCE.from}'`, `'${FONT_SOURCE.to}'`)
  .replaceAll("./files/", `./${path.basename(FONT_SOURCE.filesDir)}/`);

if (rewritten.includes(FONT_SOURCE.from)) {
  throw new Error(`family rename missed an occurrence of "${FONT_SOURCE.from}"`);
}
if (rewritten.includes("./files/")) {
  throw new Error("file path rewrite missed an occurrence of ./files/");
}
await writeFile(abs(FONT_SOURCE.css), rewritten);
console.log(`${FONT_SOURCE.packageCss} -> ${FONT_SOURCE.css} (rewritten)`);

// Only the woff2 the stylesheet actually names. The package also ships faces
// for subsets and formats this build never asks for.
const wanted = new Set([...rewritten.matchAll(/url\(\.\/[^/]+\/([^)]+)\)/g)].map((m) => m[1]));
await rm(abs(FONT_SOURCE.filesDir), { recursive: true, force: true });
await mkdir(abs(FONT_SOURCE.filesDir), { recursive: true });

const available = new Set(await readdir(abs(FONT_SOURCE.packageFiles)));
for (const name of wanted) {
  if (!available.has(name)) throw new Error(`stylesheet names a missing file: ${name}`);
  await copyFile(path.join(abs(FONT_SOURCE.packageFiles), name), path.join(abs(FONT_SOURCE.filesDir), name));
}
console.log(`${FONT_SOURCE.packageFiles} -> ${FONT_SOURCE.filesDir} (${wanted.size} files)`);
