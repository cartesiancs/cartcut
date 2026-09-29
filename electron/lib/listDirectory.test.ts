import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDirectory } from "./listDirectory";

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cartcut-list-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listDirectory", () => {
  it("reports a file's size, times and title", async () => {
    writeFileSync(path.join(root, "clip.mp4"), Buffer.alloc(1234));

    const list = await listDirectory(root);

    expect(list["clip.mp4"]).toMatchObject({
      isDirectory: false,
      title: "clip.mp4",
      size: 1234,
    });
    expect(list["clip.mp4"].mtimeMs).toBeGreaterThan(0);
    expect(typeof list["clip.mp4"].birthtimeMs).toBe("number");
  });

  it("gives a folder no size", async () => {
    mkdirSync(path.join(root, "renders"));

    const list = await listDirectory(root);

    expect(list.renders.isDirectory).toBe(true);
    expect("size" in list.renders).toBe(false);
    expect(list.renders.mtimeMs).toBeGreaterThan(0);
  });

  it("keeps a file called __proto__ as an ordinary key", async () => {
    writeFileSync(path.join(root, "__proto__"), "x");

    const list = await listDirectory(root);

    expect(Object.keys(list)).toEqual(["__proto__"]);
    expect(list["__proto__"].size).toBe(1);
  });

  it.skipIf(process.platform === "win32")(
    "follows a link to a file and reports the target's size",
    async () => {
      writeFileSync(path.join(root, "target.mp4"), Buffer.alloc(5000));
      symlinkSync(path.join(root, "target.mp4"), path.join(root, "link.mp4"));

      const list = await listDirectory(root);

      expect(list["link.mp4"]).toMatchObject({ isDirectory: false, size: 5000 });
    },
  );

  it.skipIf(process.platform === "win32")(
    "follows a link to a folder so it can be opened",
    async () => {
      mkdirSync(path.join(root, "real"));
      symlinkSync(path.join(root, "real"), path.join(root, "alias"));

      const list = await listDirectory(root);

      expect(list.alias.isDirectory).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "lists a dangling link without failing the folder",
    async () => {
      writeFileSync(path.join(root, "ok.mp4"), "x");
      symlinkSync(path.join(root, "gone.mp4"), path.join(root, "dangling.mp4"));

      const list = await listDirectory(root);

      expect(Object.keys(list).sort()).toEqual(["dangling.mp4", "ok.mp4"]);
      expect(list["dangling.mp4"].isDirectory).toBe(false);
      expect("size" in list["dangling.mp4"]).toBe(false);
    },
  );

  it("rejects for a folder that does not exist", async () => {
    await expect(listDirectory(path.join(root, "nope"))).rejects.toThrow();
  });
});
