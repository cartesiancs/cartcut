/**
 * Write the shipped LUT presets from their recipes.
 *
 *     npx vite-node scripts/generateLuts.ts
 *
 * Produces `assets/presets/luts/<slug>/{manifest.json,lut.cube}` for every
 * entry in `features/lut/recipes.ts`. All the interesting work is in
 * `features/lut/generate.ts`, which is pure so the catalogue test can
 * regenerate a table in memory and check it against what is checked in — this
 * file is only the filesystem around it.
 *
 * Re-run it after any change to `colorMath.ts` or `recipes.ts`; the resulting
 * diff is the review.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { generateLut } from "../apps/app/src/features/lut/generate";
import { LUT_RECIPES } from "../apps/app/src/features/lut/recipes";

/**
 * The repository root, from the working directory.
 *
 * Not `import.meta.url`, which the root tsconfig's module setting forbids, and
 * emphatically not `process.argv[1]`: under `vite-node` that is the runner in
 * `node_modules/.bin`, so resolving relative to it silently writes eighty
 * preset folders into `node_modules/assets`. The check below is what turns
 * "run from the wrong directory" into a message instead of into a mess.
 */
const cwd = process.cwd();
if (!fs.existsSync(path.join(cwd, "assets", "presets"))) {
  console.error(
    `run this from the repository root — no assets/presets under ${cwd}`,
  );
  process.exit(1);
}
const root = path.join(cwd, "assets", "presets", "luts");
fs.mkdirSync(root, { recursive: true });

const written: string[] = [];
for (const recipe of LUT_RECIPES) {
  const generated = generateLut(recipe);
  const dir = path.join(root, recipe.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), generated.manifest, "utf8");
  fs.writeFileSync(path.join(dir, "lut.cube"), generated.cube, "utf8");
  written.push(recipe.slug);
}

const known = new Set(written);
const orphans = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !known.has(entry.name))
  .map((entry) => entry.name);

console.log(`wrote ${written.length} LUT presets to ${root}`);
if (orphans.length > 0) {
  // Not deleted: a folder here may be something someone put there while
  // testing, and this script's job is to write, not to tidy.
  console.warn(
    `these folders match no recipe and were left alone: ${orphans.join(", ")}`,
  );
}
