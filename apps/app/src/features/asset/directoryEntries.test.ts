import { describe, it, expect } from "vitest";
import {
  normalizeDirectoryEntries,
  parentDirectory,
  joinPath,
  readDirectory,
} from "./directoryEntries";

const names = (entries: { name: string }[]) => entries.map((e) => e.name);

describe("normalizeDirectoryEntries", () => {
  it("turns the filename-keyed object into an array", () => {
    const result = normalizeDirectoryEntries({
      "clip.mp4": { isDirectory: false, title: "clip.mp4" },
      "b-roll": { isDirectory: true, title: "b-roll" },
    });

    expect(result).toEqual([
      { name: "b-roll", isDirectory: true },
      { name: "clip.mp4", isDirectory: false },
    ]);
  });

  it("puts folders before files", () => {
    const result = normalizeDirectoryEntries({
      "a.mp4": { isDirectory: false, title: "a.mp4" },
      zebra: { isDirectory: true, title: "zebra" },
      "b.mp4": { isDirectory: false, title: "b.mp4" },
      alpha: { isDirectory: true, title: "alpha" },
    });

    expect(names(result)).toEqual(["alpha", "zebra", "a.mp4", "b.mp4"]);
  });

  it("sorts numerically so clip2 precedes clip10", () => {
    const result = normalizeDirectoryEntries({
      "clip10.mp4": { isDirectory: false, title: "clip10.mp4" },
      "clip2.mp4": { isDirectory: false, title: "clip2.mp4" },
      "clip1.mp4": { isDirectory: false, title: "clip1.mp4" },
    });

    expect(names(result)).toEqual(["clip1.mp4", "clip2.mp4", "clip10.mp4"]);
  });

  it("does not let integer-like keys jump the queue", () => {
    // Object key order would list 1/2 first regardless of insertion order.
    const result = normalizeDirectoryEntries({
      "apple.mp4": { isDirectory: false, title: "apple.mp4" },
      "2": { isDirectory: false, title: "2" },
      "1": { isDirectory: false, title: "1" },
      zebra: { isDirectory: true, title: "zebra" },
    });

    expect(names(result)).toEqual(["zebra", "1", "2", "apple.mp4"]);
  });

  it("ignores case when ordering", () => {
    const result = normalizeDirectoryEntries({
      "Beta.mp4": { isDirectory: false, title: "Beta.mp4" },
      "alpha.mp4": { isDirectory: false, title: "alpha.mp4" },
      "Gamma.mp4": { isDirectory: false, title: "Gamma.mp4" },
    });

    expect(names(result)).toEqual(["alpha.mp4", "Beta.mp4", "Gamma.mp4"]);
  });

  it("keeps hidden files", () => {
    const result = normalizeDirectoryEntries({
      ".env": { isDirectory: false, title: ".env" },
      "a.mp4": { isDirectory: false, title: "a.mp4" },
    });

    expect(names(result)).toContain(".env");
  });

  it("falls back to the key when title is missing", () => {
    const result = normalizeDirectoryEntries({
      "clip.mp4": { isDirectory: false },
    });

    expect(result).toEqual([{ name: "clip.mp4", isDirectory: false }]);
  });

  it("coerces a missing isDirectory to false", () => {
    const result = normalizeDirectoryEntries({ "clip.mp4": {} });
    expect(result[0].isDirectory).toBe(false);
  });

  it("tolerates junk instead of throwing", () => {
    expect(normalizeDirectoryEntries(null)).toEqual([]);
    expect(normalizeDirectoryEntries(undefined)).toEqual([]);
    expect(normalizeDirectoryEntries({})).toEqual([]);
    expect(normalizeDirectoryEntries("nope")).toEqual([]);
    expect(normalizeDirectoryEntries(42)).toEqual([]);
    expect(normalizeDirectoryEntries({ a: null, b: "str" })).toEqual([]);
  });
});

describe("parentDirectory", () => {
  it("walks up one level", () => {
    expect(parentDirectory("/a/b/c")).toBe("/a/b");
    expect(parentDirectory("/a/b")).toBe("/a");
  });

  it("stops at the root instead of producing an empty path", () => {
    // "" used to reach fs.readdir(""), which fails silently.
    expect(parentDirectory("/a")).toBe("/");
    expect(parentDirectory("/")).toBeNull();
    expect(parentDirectory("")).toBeNull();
  });

  it("ignores a trailing slash", () => {
    expect(parentDirectory("/a/b/")).toBe("/a");
  });

  it("returns null when there is no separator at all", () => {
    expect(parentDirectory("relative")).toBeNull();
  });
});

describe("joinPath", () => {
  it("joins a normal directory and name", () => {
    expect(joinPath("/a/b", "clip.mp4")).toBe("/a/b/clip.mp4");
  });

  it("does not double the separator at the root", () => {
    expect(joinPath("/", "clip.mp4")).toBe("/clip.mp4");
  });

  it("does not double the separator on a trailing slash", () => {
    expect(joinPath("/a/b/", "clip.mp4")).toBe("/a/b/clip.mp4");
  });

  it("returns the bare name when there is no directory", () => {
    expect(joinPath("", "clip.mp4")).toBe("clip.mp4");
  });
});

describe("readDirectory", () => {
  it("normalizes what the injected reader returns", async () => {
    const result = await readDirectory("/media", async (dir) => {
      expect(dir).toBe("/media");
      return {
        "clip.mp4": { isDirectory: false, title: "clip.mp4" },
        raw: { isDirectory: true, title: "raw" },
      };
    });

    expect(names(result)).toEqual(["raw", "clip.mp4"]);
  });

  it("propagates a rejection so the caller can show an error", async () => {
    await expect(
      readDirectory("/nope", async () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toThrow("ENOENT");
  });
});
