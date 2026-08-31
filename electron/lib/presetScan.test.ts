/**
 * The two halves of the preset pipeline, checked against each other.
 *
 * The main process scans folders and the renderer validates what it finds, and
 * the build forbids either from importing the other — so the extension lists
 * exist twice and could drift silently. A test may import across the boundary
 * (it is excluded from the `electron/` tsc pass), which is how
 * `ffmpegArgs.test.ts` keeps its copy of `isAudible` honest, and it is what
 * this file does for the scanner.
 *
 * It also runs the presets that actually ship through the real scanner and the
 * real validator, end to end. That is the only test that proves the format
 * works for anyone but us: built-ins take no privileged path, so a third-party
 * folder of the same shape loads the same way.
 */

import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import * as fsp from "fs/promises";
import os from "os";
import {
  ASSET_EXTENSIONS,
  MAX_SHADER_BYTES,
  SHADER_EXTENSIONS,
  readPresetDir,
  scanPresetRoot,
} from "./presetScan";
import {
  ASSET_EXTENSIONS as RENDERER_ASSET_EXTENSIONS,
  SHADER_EXTENSIONS as RENDERER_SHADER_EXTENSIONS,
  validatePreset,
} from "../../apps/app/src/features/fx/presetValidate";

const REPO_ROOT = path.resolve(__dirname, "../..");
const BUILTIN_ROOT = path.join(REPO_ROOT, "assets", "presets");

describe("the hand-copied extension lists", () => {
  it("agree with the renderer's", () => {
    // If these drift, a manifest can reference a file the scanner never read —
    // reported as "not present" with the file sitting right there.
    expect([...SHADER_EXTENSIONS].sort()).toEqual(
      [...RENDERER_SHADER_EXTENSIONS].sort(),
    );
    expect([...ASSET_EXTENSIONS].sort()).toEqual(
      [...RENDERER_ASSET_EXTENSIONS].sort(),
    );
  });
});

describe("scanPresetRoot", () => {
  it("finds presets nested under a grouping directory", async () => {
    const found = await scanPresetRoot(BUILTIN_ROOT, "builtin");
    const ids = found.map((preset) => preset.id).sort();
    expect(ids).toContain("cross-dissolve");
    expect(ids).toContain("vignette");
  });

  it("tags where they came from", async () => {
    const found = await scanPresetRoot(BUILTIN_ROOT, "builtin");
    expect(found.every((preset) => preset.origin === "builtin")).toBe(true);
  });

  it("returns nothing for a directory that does not exist", async () => {
    // Normal for `userData/presets` until the user installs something.
    const missing = path.join(os.tmpdir(), "cartcut-no-such-preset-dir");
    await expect(scanPresetRoot(missing, "user")).resolves.toEqual([]);
  });

  it("hands the manifest over unparsed", async () => {
    const found = await scanPresetRoot(BUILTIN_ROOT, "builtin");
    const preset = found.find((entry) => entry.id === "cross-dissolve");
    expect(typeof preset?.manifestJson).toBe("string");
    expect(preset?.manifestJson).toContain("cross-dissolve");
  });
});

describe("what the scanner refuses to read", () => {
  async function withTempPreset(
    files: Record<string, string>,
    run: (dir: string) => Promise<void>,
  ) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cartcut-preset-"));
    try {
      for (const [name, content] of Object.entries(files)) {
        const full = path.join(dir, name);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, content, "utf8");
      }
      await run(dir);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  it("never reads a .js file, whatever it is called", async () => {
    await withTempPreset(
      {
        "manifest.json": "{}",
        "shader.frag": "vec4 transition(vec2 uv) { return vec4(0.0); }",
        "evil.js": "require('child_process').execSync('echo pwned')",
        "also.mjs": "export default 1;",
      },
      async (dir) => {
        const payload = await readPresetDir(dir, "user");
        expect(Object.keys(payload!.sources)).toEqual(["shader.frag"]);
        expect(payload!.assets).toEqual({});
        // Not read, and not even listed — so a manifest cannot reference it.
        expect(JSON.stringify(payload)).not.toContain("evil.js");
        expect(JSON.stringify(payload)).not.toContain("pwned");
      },
    );
  });

  // The whole reason `.cube` is an *asset* extension and not a shader one: a
  // shader is read into the payload as a string, and doing that to a LUT would
  // pull all eighty built-in tables — around 11 MB of text — into memory at
  // startup, for a project that may grade nothing at all.
  it("reports a .cube as a path and never reads its bytes", async () => {
    const body = `LUT_3D_SIZE 2\n${"0.5 0.5 0.5\n".repeat(8)}`;
    await withTempPreset(
      {
        "manifest.json": "{}",
        "lut.cube": body,
        "other.3dl": "0 1023\n0 0 0\n",
      },
      async (dir) => {
        const payload = await readPresetDir(dir, "user");
        expect(Object.keys(payload!.sources)).toEqual([]);
        expect(Object.keys(payload!.assets).sort()).toEqual([
          "lut.cube",
          "other.3dl",
        ]);
        // Absolute paths, not contents. A payload carrying the table would be
        // the startup cost this arrangement exists to avoid.
        expect(payload!.assets["lut.cube"]).toContain("lut.cube");
        expect(JSON.stringify(payload)).not.toContain("LUT_3D_SIZE");
      },
    );
  });

  it("skips a shader too large to be one", async () => {
    await withTempPreset(
      {
        "manifest.json": "{}",
        "huge.frag": "x".repeat(MAX_SHADER_BYTES + 1),
        "fine.frag": "ok",
      },
      async (dir) => {
        const payload = await readPresetDir(dir, "user");
        expect(Object.keys(payload!.sources)).toEqual(["fine.frag"]);
      },
    );
  });

  it("skips a folder with no manifest rather than failing", async () => {
    await withTempPreset({ "shader.frag": "x" }, async (dir) => {
      expect(await readPresetDir(dir, "user")).toBeNull();
    });
  });

  it("reads one level of subdirectory, keeping the relative path", async () => {
    await withTempPreset(
      {
        "manifest.json": "{}",
        "shaders/wipe.frag": "vec4 transition(vec2 uv) { return vec4(0.0); }",
      },
      async (dir) => {
        const payload = await readPresetDir(dir, "user");
        expect(Object.keys(payload!.sources)).toEqual(["shaders/wipe.frag"]);
      },
    );
  });
});

/**
 * Every shipped preset, scanned by the real scanner and checked by the real
 * validator — no mirror of either.
 */
describe("the presets that ship with the app", () => {
  it("exist", () => {
    expect(fs.existsSync(BUILTIN_ROOT)).toBe(true);
  });

  it("all validate", async () => {
    const found = await scanPresetRoot(BUILTIN_ROOT, "builtin");
    expect(found.length).toBeGreaterThan(0);

    const broken: string[] = [];
    for (const payload of found) {
      const result = validatePreset(payload);
      if (!result.ok) {
        broken.push(payload.id + ":\n    " + result.errors.join("\n    "));
      }
    }
    if (broken.length > 0) {
      throw new Error("presets failed to validate:\n  " + broken.join("\n  "));
    }
  });

  it("ship both kinds", async () => {
    const found = await scanPresetRoot(BUILTIN_ROOT, "builtin");
    const kinds = new Set(
      found
        .map((payload) => validatePreset(payload))
        .filter((result) => result.ok)
        .map((result) => (result as { ok: true; preset: { kind: string } }).preset.kind),
    );
    expect(kinds).toContain("transition");
    expect(kinds).toContain("effect");
  });

  it("have unique ids", async () => {
    const found = await scanPresetRoot(BUILTIN_ROOT, "builtin");
    const ids = found
      .map((payload) => validatePreset(payload))
      .filter((result) => result.ok)
      .map(
        (result) =>
          (result as { ok: true; preset: { id: string } }).preset.id,
      );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("are packaged by electron-builder", () => {
    // `assets/` is an `extraResources` entry with a `**/*` filter, and
    // `preset.ts` resolves `<resources>/assets/presets`. If someone narrows
    // that filter, the presets vanish from a packaged build only — which is
    // exactly the kind of break nobody notices until release.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    );
    const resources = pkg.build?.extraResources ?? [];
    const assets = resources.find(
      (entry: { from?: string }) =>
        entry.from === "./assets" || entry.from === "assets",
    );
    expect(assets).toBeDefined();
    expect(assets.to).toBe("assets");
    expect(assets.filter).toContain("**/*");
  });
});
