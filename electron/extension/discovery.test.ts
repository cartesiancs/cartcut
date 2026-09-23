import path from "path";
import { describe, expect, it } from "vitest";

import { scanExtensionRoots, type FsPorts } from "./discovery";

const ROOT = path.resolve("/ext");

function manifest(publisher: string, name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    publisher,
    name,
    version: "1.0.0",
    main: "main.js",
    engines: { cartcut: "^1" },
    cartcut: { activationEvents: ["onStartup"] },
    ...extra,
  });
}

function fakeFs(tree: Record<string, string>): FsPorts & { reads: string[] } {
  const dirs = new Set<string>();
  for (const file of Object.keys(tree)) {
    let dir = path.dirname(file);
    while (dir !== path.dirname(dir)) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  const reads: string[] = [];
  return {
    reads,
    async readdir(dir) {
      const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
      const names = new Set<string>();
      for (const entry of [...Object.keys(tree), ...dirs]) {
        if (entry.startsWith(prefix)) {
          names.add(entry.slice(prefix.length).split(path.sep)[0]);
        }
      }
      if (names.size === 0 && !dirs.has(dir)) {
        throw new Error("ENOENT " + dir);
      }
      return [...names];
    },
    async readFile(file) {
      reads.push(file);
      const value = tree[file];
      if (value == null) {
        throw new Error("ENOENT " + file);
      }
      return value;
    },
    async isDirectory(target) {
      return dirs.has(target);
    },
  };
}

describe("scanExtensionRoots", () => {
  it("reads only package.json", async () => {
    const fs = fakeFs({
      [path.join(ROOT, "acme.hello", "package.json")]: manifest("acme", "hello"),
      [path.join(ROOT, "acme.hello", "main.js")]: "module.exports = {}",
    });
    await scanExtensionRoots(ROOT, [], fs);
    expect(fs.reads).toEqual([path.join(ROOT, "acme.hello", "package.json")]);
  });

  it("answers an empty list for a root that does not exist yet", async () => {
    // It does not exist until the first install, and an error here would log
    // on every launch of a fresh profile.
    const found = await scanExtensionRoots(ROOT, [], fakeFs({}));
    expect(found).toEqual([]);
  });

  it("skips dotfolders and the archive leftovers", async () => {
    const fs = fakeFs({
      [path.join(ROOT, ".part-acme.hello", "package.json")]: manifest("acme", "hello"),
      [path.join(ROOT, "__MACOSX", "package.json")]: "{}",
      [path.join(ROOT, "acme.real", "package.json")]: manifest("acme", "real"),
    });
    const found = await scanExtensionRoots(ROOT, [], fs);
    expect(found.map((entry) => entry.id)).toEqual(["acme.real"]);
  });

  it("reports a broken manifest without losing the others", async () => {
    const fs = fakeFs({
      [path.join(ROOT, "acme.broken", "package.json")]: "{ not json",
      [path.join(ROOT, "acme.fine", "package.json")]: manifest("acme", "fine"),
    });
    const found = await scanExtensionRoots(ROOT, [], fs);
    const broken = found.find((entry) => entry.id === "acme.broken");
    const fine = found.find((entry) => entry.id === "acme.fine");
    expect(broken?.manifest).toBeNull();
    expect(broken?.errors.length).toBeGreaterThan(0);
    expect(fine?.manifest?.id).toBe("acme.fine");
  });

  it("refuses an installed folder whose name does not match its manifest", async () => {
    const fs = fakeFs({
      [path.join(ROOT, "someone.else", "package.json")]: manifest("acme", "hello"),
    });
    const found = await scanExtensionRoots(ROOT, [], fs);
    expect(found[0].manifest).toBeNull();
    expect(found[0].errors.join()).toContain("does not match");
  });

  it("lets an unpacked folder be named anything", async () => {
    // A developer's checkout is called whatever their repository is called.
    const dir = path.resolve("/work/my-extension");
    const fs = fakeFs({ [path.join(dir, "package.json")]: manifest("acme", "hello") });
    const found = await scanExtensionRoots(ROOT, [dir], fs);
    expect(found[0]).toMatchObject({ id: "acme.hello", origin: "unpacked" });
  });

  it("lets the unpacked copy win, and says so about the one it shadowed", async () => {
    const dir = path.resolve("/work/hello");
    const fs = fakeFs({
      [path.join(ROOT, "acme.hello", "package.json")]: manifest("acme", "hello"),
      [path.join(dir, "package.json")]: manifest("acme", "hello"),
    });
    const found = await scanExtensionRoots(ROOT, [dir], fs);
    const live = found.find((entry) => entry.manifest != null);
    expect(live?.origin).toBe("unpacked");
    expect(found.some((entry) => entry.errors.join().includes("shadowed"))).toBe(true);
  });

  it("reports an unpacked path that has been deleted", async () => {
    const found = await scanExtensionRoots(ROOT, [path.resolve("/gone")], fakeFs({}));
    expect(found[0].errors.join()).toContain("gone");
  });
});
