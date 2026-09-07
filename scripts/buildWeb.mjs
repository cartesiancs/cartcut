// Stages the renderer as a plain static site for Cloudflare Pages.
//
// The Electron app loads apps/app/index.html straight off disk, next to the
// webpack output in apps/app/dist and beside 482 TypeScript sources it never
// serves. A host needs one directory holding only what a browser asks for, so
// this copies those pieces into dist-web/ and publishes that instead.
//
// Run after `webpack --mode=production`; see the "build:web" script.

import { cp, mkdir, rm, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist-web");

// Both spellings of "assets" land in one tree: index.html's siblings resolve
// `./assets/images/...` against apps/app, while the renderer asks for
// `/assets/presets/...` from the repo root. On disk those are two folders; over
// HTTP there is one origin, so the root tree goes down first and the app's own
// images are laid over it.
const copies = [
  ["assets", "assets"],
  ["apps/app/assets", "assets"],
  ["apps/app/dist", "dist"],
  // Bootstrap, as a file rather than a CDN URL. index.html asks for
  // `vendor/…` and the pages for `../vendor/…`; both resolve once it sits
  // beside `dist/` and `page/`.
  ["apps/app/vendor", "vendor"],
  ["apps/app/page", "page"],
  ["apps/app/sample", "sample"],
  ["apps/app/index.html", "index.html"],
];

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const [from, to] of copies) {
  const src = path.join(root, from);
  if (!(await exists(src))) throw new Error(`missing build input: ${from}`);
  await cp(src, path.join(out, to), { recursive: true });
}

const bundle = path.join(out, "dist", "index.js");
if (!(await exists(bundle))) {
  throw new Error("dist/index.js missing — run `webpack --mode=production` first");
}

const count = async (dir) => {
  let n = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? await count(path.join(dir, entry.name)) : 1;
  }
  return n;
};

console.log(`dist-web: ${await count(out)} files`);
