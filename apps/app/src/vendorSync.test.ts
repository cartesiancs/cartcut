/**
 * `apps/app/vendor/` is what the editor loads instead of a CDN, and this pins it.
 *
 * The app has to run with the machine offline, so Bootstrap, Noto Sans KR and
 * the DeVent design system are files on disk that `index.html` and the
 * Setting/Credit pages load with plain `<link>`/`<script>` tags. Nothing in the
 * build regenerates them — they are committed, deliberately, because
 * `electron-builder` packages whatever is on disk and the E2E suite launches
 * the repo with no build step in front of it.
 *
 * Which leaves two failure modes, and this file covers both:
 *
 *  - For the copies taken from npm, `npm install` moves `node_modules` and the
 *    copy stays behind, so the app ships a version nobody chose while
 *    `package.json` names a version nobody runs. It would not throw. Hence a
 *    hash. Fix with `npm run vendor:sync`, then read the diff — a major bump is
 *    a real upgrade and wants looking at, not a rubber stamp.
 *  - For the DeVent files there is no upstream to sync from any more, so the
 *    hash is only there to catch an accidental edit.
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs, shared with scripts/syncVendor.mjs, no types.
import { FONT_SOURCE, FROZEN_FILES, VENDORED_FILES } from "../vendor/manifest.mjs";

type Copied = { source: string; vendored: string };
type Frozen = { vendored: string; sha256: string };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative: string) => readFile(path.join(root, relative));
const sha256 = async (relative: string) =>
  createHash("sha256").update(await read(relative)).digest("hex");

describe("apps/app/vendor", () => {
  it("lists files", () => {
    // Manifests that silently emptied would make every case below vacuous.
    expect(VENDORED_FILES.length).toBeGreaterThan(0);
    expect(FROZEN_FILES.length).toBeGreaterThan(0);
  });

  it.each(VENDORED_FILES as Copied[])(
    "$vendored matches $source",
    async ({ source, vendored }) => {
      expect(await sha256(vendored)).toBe(await sha256(source));
    },
  );

  it.each(FROZEN_FILES as Frozen[])("$vendored is unmodified", async ({ vendored, sha256: want }) => {
    expect(await sha256(vendored)).toBe(want);
  });

  it("vendors the Popper-inclusive Bootstrap build", async () => {
    // `bootstrap.min.js` and `bootstrap.bundle.min.js` differ only in whether
    // Popper is inside, and swapping one for the other breaks nothing until
    // someone opens a dropdown. Three of those ship in the editor.
    const bundle = await read("apps/app/vendor/bootstrap.bundle.min.js");
    expect(bundle.toString("utf8")).toContain("popper");
  });

  describe("noto-sans-kr.css", () => {
    it("declares the family the stylesheets actually ask for", async () => {
      // fontsource names the variable cut "<family> Variable"; every rule in
      // the app's SCSS and in the frozen DeVent stylesheet says "Noto Sans KR".
      // Left unrewritten, nothing matches and the UI silently falls back to the
      // system sans-serif.
      const css = (await read(FONT_SOURCE.css)).toString("utf8");
      expect(css).toContain(`font-family: '${FONT_SOURCE.to}'`);
      expect(css).not.toContain(FONT_SOURCE.from);
    });

    it("stays a variable face spanning the weights the UI uses", async () => {
      // 400 on `b`/`.btn`, 500 on `.font-weight-md`, 700 on `.font-weight-lg`
      // and `.text-title`. A single static face standing in for all three
      // renders 400 heavier and wider, which resizes every button.
      const css = (await read(FONT_SOURCE.css)).toString("utf8");
      expect(css).toContain("font-weight: 100 900");
    });

    it("names only files that are present, and no strays", async () => {
      const css = (await read(FONT_SOURCE.css)).toString("utf8");
      const named = new Set(
        [...css.matchAll(/url\(\.\/[^/]+\/([^)]+)\)/g)].map((m) => m[1]),
      );
      const onDisk = new Set(await readdir(path.join(root, FONT_SOURCE.filesDir)));
      expect(named.size).toBeGreaterThan(0);
      expect([...named].filter((f) => !onDisk.has(f))).toEqual([]);
      expect([...onDisk].filter((f) => !named.has(f))).toEqual([]);
    });
  });
});
