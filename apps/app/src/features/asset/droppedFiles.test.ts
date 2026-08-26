/**
 * The regression that made dropping a file do nothing.
 *
 * Electron removed `File.path` in v32 and this app runs 33, so the old
 * `files[0].path` read `undefined`, threw two frames later inside `path.encode`,
 * and was swallowed by an empty `catch`. Every `File` stand-in below is written
 * *without* a `path` property on purpose: if anything in this module ever
 * reaches for one again, these fail.
 */

import { describe, it, expect, vi } from "vitest";
import { collectDroppedPaths, type DroppedFile } from "./droppedFiles";

/**
 * What `dataTransfer.files` actually hands over on Electron 33 — a name, and
 * no path anywhere.
 */
function file(name: string): DroppedFile {
  return { name };
}

/** Stands in for `webUtils.getPathForFile`, which only the preload can call. */
function resolverFor(table: Record<string, string>) {
  return (f: DroppedFile) => table[f.name];
}

describe("collectDroppedPaths", () => {
  it("gets a path from a File that has no path property", () => {
    const dropped = file("a.mp4");
    expect("path" in dropped).toBe(false);

    const result = collectDroppedPaths(
      [dropped],
      resolverFor({ "a.mp4": "/Users/me/clips/a.mp4" }),
    );

    expect(result.paths).toEqual(["/Users/me/clips/a.mp4"]);
    expect(result.unresolved).toEqual([]);
  });

  it("hands the resolver the File itself, not a copy of its name", () => {
    // `webUtils.getPathForFile` needs the real object; passing a name would
    // give it nothing to look up.
    const dropped = file("a.mp4");
    const resolve = vi.fn(() => "/tmp/a.mp4");

    collectDroppedPaths([dropped], resolve);

    expect(resolve).toHaveBeenCalledWith(dropped);
  });

  it("takes every file in a multi-file drop", () => {
    // The old handler indexed `files[0]` and lost the rest without a word.
    const result = collectDroppedPaths(
      [file("a.mp4"), file("b.png"), file("c.wav")],
      resolverFor({
        "a.mp4": "/m/a.mp4",
        "b.png": "/m/b.png",
        "c.wav": "/m/c.wav",
      }),
    );

    expect(result.paths).toHaveLength(3);
  });

  describe("ordering", () => {
    it("sorts by filename so a multi-file drop lands predictably", () => {
      const result = collectDroppedPaths(
        [file("c.mp4"), file("a.mp4"), file("b.mp4")],
        resolverFor({ "a.mp4": "/m/a.mp4", "b.mp4": "/m/b.mp4", "c.mp4": "/m/c.mp4" }),
      );

      expect(result.paths).toEqual(["/m/a.mp4", "/m/b.mp4", "/m/c.mp4"]);
    });

    it("orders clip2 before clip10", () => {
      // Plain string ordering puts clip10 first, which is wrong for exactly the
      // case this matters in: a folder of numbered exports laid end to end.
      const names = ["clip10.mp4", "clip2.mp4", "clip1.mp4"];
      const result = collectDroppedPaths(
        names.map(file),
        resolverFor(Object.fromEntries(names.map((n) => [n, `/m/${n}`]))),
      );

      expect(result.paths).toEqual(["/m/clip1.mp4", "/m/clip2.mp4", "/m/clip10.mp4"]);
    });

    it("sorts on the filename, not the directory", () => {
      const result = collectDroppedPaths(
        [file("b.mp4"), file("a.mp4")],
        resolverFor({ "a.mp4": "/zzz/a.mp4", "b.mp4": "/aaa/b.mp4" }),
      );

      expect(result.paths).toEqual(["/zzz/a.mp4", "/aaa/b.mp4"]);
    });

    it("reads a Windows path's filename too", () => {
      const result = collectDroppedPaths(
        [file("b.mp4"), file("a.mp4")],
        resolverFor({
          "a.mp4": "C:\\Users\\me\\a.mp4",
          "b.mp4": "C:\\Users\\me\\b.mp4",
        }),
      );

      expect(result.paths).toEqual(["C:\\Users\\me\\a.mp4", "C:\\Users\\me\\b.mp4"]);
    });
  });

  describe("files the resolver cannot place", () => {
    it("reports one that comes back undefined", () => {
      const result = collectDroppedPaths([file("ghost.mp4")], () => undefined);

      expect(result.paths).toEqual([]);
      expect(result.unresolved).toEqual(["ghost.mp4"]);
    });

    it("treats an empty string as unresolved", () => {
      // What `getPathForFile` returns for a File that has no backing path at
      // all — a drag of an image out of a web page, for instance.
      const result = collectDroppedPaths([file("ghost.png")], () => "");

      expect(result.paths).toEqual([]);
      expect(result.unresolved).toEqual(["ghost.png"]);
    });

    it("keeps the good files when one cannot be resolved", () => {
      const result = collectDroppedPaths(
        [file("a.mp4"), file("ghost.mp4"), file("b.mp4")],
        resolverFor({ "a.mp4": "/m/a.mp4", "b.mp4": "/m/b.mp4" }),
      );

      expect(result.paths).toEqual(["/m/a.mp4", "/m/b.mp4"]);
      expect(result.unresolved).toEqual(["ghost.mp4"]);
    });

    it("survives a resolver that throws", () => {
      const result = collectDroppedPaths(
        [file("a.mp4"), file("boom.mp4")],
        (f) => {
          if (f.name === "boom.mp4") {
            throw new Error("not a real file");
          }
          return "/m/a.mp4";
        },
      );

      expect(result.paths).toEqual(["/m/a.mp4"]);
      expect(result.unresolved).toEqual(["boom.mp4"]);
    });
  });

  describe("nothing to do", () => {
    it("returns empty for an empty drop", () => {
      const result = collectDroppedPaths([], () => "/m/a.mp4");

      expect(result).toEqual({ paths: [], unresolved: [] });
    });

    it("does not throw when dataTransfer.files is missing", () => {
      expect(collectDroppedPaths(undefined, () => "/m/a.mp4")).toEqual({
        paths: [],
        unresolved: [],
      });
      expect(collectDroppedPaths(null, () => "/m/a.mp4")).toEqual({
        paths: [],
        unresolved: [],
      });
    });
  });

  it("does not filter by extension", () => {
    // `probeMedia` owns that decision and reports a reason with it. Deciding it
    // twice is how the two answers drift apart.
    const result = collectDroppedPaths(
      [file("notes.txt")],
      resolverFor({ "notes.txt": "/m/notes.txt" }),
    );

    expect(result.paths).toEqual(["/m/notes.txt"]);
  });
});
