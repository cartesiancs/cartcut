import * as fsp from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readTemplateDir,
  scanTemplateRoot,
  TEMPLATE_DOCUMENT,
  TEMPLATE_MANIFEST,
} from "./templateScan";

/**
 * The scanner's whole rule: **a folder is a template if it holds a
 * `template.ngt`.** Everything else about it is optional, and one bad folder
 * must never take the library down with it.
 */

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "cartcut-tpl-"));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

async function makeTemplate(
  name: string,
  extras: Record<string, string> = {},
): Promise<string> {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, TEMPLATE_DOCUMENT), "zip-bytes");
  for (const [file, content] of Object.entries(extras)) {
    const target = path.join(dir, file);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
  return dir;
}

describe("readTemplateDir", () => {
  it("reads a folder holding a template.ngt", async () => {
    const dir = await makeTemplate("neon");
    const payload = await readTemplateDir(dir, "user");
    expect(payload?.id).toBe("neon");
    expect(payload?.origin).toBe("user");
    expect(payload?.ngtPath.endsWith("/neon/template.ngt")).toBe(true);
  });

  it("answers null for a folder with no template.ngt", async () => {
    const dir = path.join(root, "not-a-template");
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, "readme.txt"), "hello");
    expect(await readTemplateDir(dir, "user")).toBeNull();
  });

  it("answers null for a folder that does not exist", async () => {
    expect(await readTemplateDir(path.join(root, "ghost"), "user")).toBeNull();
  });

  it("passes the manifest along without parsing it", async () => {
    // Incurious by design: the renderer owns the schema, so this side has
    // nothing to keep in sync — the rule `presetScan.ts` states.
    const dir = await makeTemplate("neon", {
      [TEMPLATE_MANIFEST]: "{ not even json",
    });
    const payload = await readTemplateDir(dir, "user");
    expect(payload?.manifestJson).toBe("{ not even json");
  });

  it("answers null manifest when there is none", async () => {
    const payload = await readTemplateDir(await makeTemplate("neon"), "user");
    expect(payload?.manifestJson).toBeNull();
  });

  it("finds a png thumbnail, and a jpg", async () => {
    const png = await readTemplateDir(
      await makeTemplate("a", { "thumbnail.png": "x" }),
      "user",
    );
    expect(png?.thumbnailPath?.endsWith("thumbnail.png")).toBe(true);

    const jpg = await readTemplateDir(
      await makeTemplate("b", { "thumbnail.jpg": "x" }),
      "user",
    );
    expect(jpg?.thumbnailPath?.endsWith("thumbnail.jpg")).toBe(true);
  });

  it("answers null thumbnail when there is none", async () => {
    const payload = await readTemplateDir(await makeTemplate("neon"), "user");
    expect(payload?.thumbnailPath).toBeNull();
  });

  it("reports paths POSIX-separated, so the renderer sees one spelling", async () => {
    const payload = await readTemplateDir(await makeTemplate("neon"), "user");
    expect(payload?.dir.includes("\\")).toBe(false);
    expect(payload?.ngtPath.includes("\\")).toBe(false);
  });

  it("refuses a hidden folder and the macOS resource fork", async () => {
    expect(await readTemplateDir(await makeTemplate(".hidden"), "user")).toBeNull();
    expect(await readTemplateDir(await makeTemplate("__MACOSX"), "user")).toBeNull();
  });

  it("ignores an absurdly large manifest rather than reading it", async () => {
    const dir = await makeTemplate("neon", {
      [TEMPLATE_MANIFEST]: "x".repeat(70 * 1024),
    });
    expect((await readTemplateDir(dir, "user"))?.manifestJson).toBeNull();
  });

  it("does not mistake a directory named template.ngt for the document", async () => {
    const dir = path.join(root, "odd");
    await fsp.mkdir(path.join(dir, TEMPLATE_DOCUMENT), { recursive: true });
    expect(await readTemplateDir(dir, "user")).toBeNull();
  });
});

describe("scanTemplateRoot", () => {
  it("answers an empty list for a directory that does not exist", async () => {
    // Normal for `userData/templates` until someone installs something.
    expect(await scanTemplateRoot(path.join(root, "nope"), "user")).toEqual([]);
  });

  it("finds every template and sorts them by id", async () => {
    await makeTemplate("zebra");
    await makeTemplate("apple");
    const found = await scanTemplateRoot(root, "builtin");
    expect(found.map((entry) => entry.id)).toEqual(["apple", "zebra"]);
    expect(found.every((entry) => entry.origin === "builtin")).toBe(true);
  });

  it("skips folders that are not templates without failing the scan", async () => {
    // One bad folder must not take the library down.
    await makeTemplate("good");
    await fsp.mkdir(path.join(root, "junk"));
    await fsp.writeFile(path.join(root, "loose.txt"), "x");
    expect((await scanTemplateRoot(root, "user")).map((e) => e.id)).toEqual([
      "good",
    ]);
  });

  it("does not descend into a template's own media folders", async () => {
    // A template's assets live in subdirectories of its folder. Descending
    // would find the same template again through whatever nesting the author
    // chose — the one place this differs from `scanPresetRoot`.
    await makeTemplate("neon", {
      "assets/clips/inner/template.ngt": "not a template",
    });
    expect((await scanTemplateRoot(root, "user")).map((e) => e.id)).toEqual([
      "neon",
    ]);
  });
});

describe("the boundary constants", () => {
  it("name the same files the renderer's archive reader does", async () => {
    // `electron/` cannot import `apps/app/src`, so these are hand-copied and
    // this is the guard — the arrangement `presetScan.test.ts` already uses for
    // its extension lists.
    const archive = await import("../../apps/app/src/features/template/archive");
    const layout = archive.readArchiveLayout([
      TEMPLATE_DOCUMENT,
      TEMPLATE_MANIFEST,
    ]);
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.ngt).toBe(TEMPLATE_DOCUMENT);
    expect(layout.manifest).toBe(TEMPLATE_MANIFEST);
  });
});
