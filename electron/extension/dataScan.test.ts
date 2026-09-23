import path from "path";
import { describe, expect, it } from "vitest";

import {
  MAX_DATA_BYTES,
  MAX_DATA_FILES,
  scanDataFolder,
  type DataFsPorts,
} from "./dataScan";

const DIR = path.resolve("/ext/acme.hello/animationPresets");

function fakeFs(files: Record<string, string>, sizes: Record<string, number> = {}): DataFsPorts {
  return {
    async readdir(dir) {
      if (dir !== DIR) {
        throw new Error("ENOENT " + dir);
      }
      return Object.keys(files);
    },
    async readFile(file) {
      const name = path.basename(file);
      if (!(name in files)) {
        throw new Error("ENOENT " + file);
      }
      return files[name];
    },
    async sizeOf(file) {
      const name = path.basename(file);
      return sizes[name] ?? files[name]?.length ?? 0;
    },
  };
}

describe("scanDataFolder", () => {
  it("reads the json and leaves it unparsed", () => {
    // Main stays incurious: what an animation preset means lives in the
    // renderer, which is the only place that has the schema.
    return scanDataFolder(DIR, fakeFs({ "a.json": '{"not":"validated here"}' })).then((scan) => {
      expect(scan.files).toEqual([{ fileName: "a.json", text: '{"not":"validated here"}' }]);
    });
  });

  it("answers nothing for a folder the extension did not ship", async () => {
    // A manifest can declare a folder that is not there. That is not an error:
    // the extension simply contributes nothing of this kind.
    const scan = await scanDataFolder(path.resolve("/nowhere"), fakeFs({}));
    expect(scan).toEqual({ files: [], skipped: [] });
  });

  it("ignores anything that is not json", async () => {
    const scan = await scanDataFolder(
      DIR,
      fakeFs({ "a.json": "{}", "notes.txt": "hi", "clip.mp4": "binary", "b.JSON": "{}" }),
    );
    expect(scan.files.map((file) => file.fileName).sort()).toEqual(["a.json", "b.JSON"]);
  });

  it("reads in a stable order", async () => {
    // A folder's read order is the filesystem's business. Two launches that
    // listed presets differently would shuffle a panel for no reason.
    const scan = await scanDataFolder(DIR, fakeFs({ "c.json": "{}", "a.json": "{}", "b.json": "{}" }));
    expect(scan.files.map((file) => file.fileName)).toEqual(["a.json", "b.json", "c.json"]);
  });

  it("skips a file over the cap and says why", async () => {
    // Not a limit a real preset meets. It stops a 500MB file named `.json`
    // being pulled into main's memory at startup.
    const scan = await scanDataFolder(
      DIR,
      fakeFs({ "huge.json": "{}", "fine.json": "{}" }, { "huge.json": MAX_DATA_BYTES + 1 }),
    );
    expect(scan.files.map((file) => file.fileName)).toEqual(["fine.json"]);
    expect(scan.skipped[0]).toMatchObject({ fileName: "huge.json" });
  });

  it("reports an unreadable file rather than losing the folder", async () => {
    const scan = await scanDataFolder(DIR, {
      readdir: async () => ["gone.json", "here.json"],
      readFile: async (file) => {
        if (path.basename(file) === "gone.json") {
          throw new Error("EACCES");
        }
        return "{}";
      },
      sizeOf: async () => 2,
    });
    expect(scan.files.map((file) => file.fileName)).toEqual(["here.json"]);
    expect(scan.skipped[0].reason).toContain("EACCES");
  });

  it("stops at the file cap and says it did", async () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < MAX_DATA_FILES + 5; index += 1) {
      many[String(index).padStart(4, "0") + ".json"] = "{}";
    }
    const scan = await scanDataFolder(DIR, fakeFs(many));
    expect(scan.files).toHaveLength(MAX_DATA_FILES);
    expect(scan.skipped.some((entry) => entry.reason.includes("only the first"))).toBe(true);
  });
});
