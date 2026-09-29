import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ASSET_SORT_KEYS,
  AssetSort,
  DEFAULT_ASSET_SORT,
  NATURAL_DIRECTION,
  SORT_KEY_LABEL,
  coerceAssetSort,
  directionRows,
  extensionOf,
  sortAssetEntries,
  withSortDirection,
  withSortKey,
} from "./assetSort";
import type { AssetEntry } from "./directoryEntries";

const names = (entries: AssetEntry[]) => entries.map((e) => e.name);

const file = (name: string, extra: Partial<AssetEntry> = {}): AssetEntry => ({
  name,
  isDirectory: false,
  ...extra,
});
const folder = (name: string, extra: Partial<AssetEntry> = {}): AssetEntry => ({
  name,
  isDirectory: true,
  ...extra,
});

/** A folder the way a real listing arrives: mixed, with dates and sizes. */
const FIXTURE: AssetEntry[] = [
  file("b-roll.mov", { size: 900, modifiedMs: 3000, createdMs: 1000 }),
  folder("renders", { modifiedMs: 5000, createdMs: 500 }),
  file("Intro.mp4", { size: 5000, modifiedMs: 1000, createdMs: 3000 }),
  file("music.mp3", { size: 300, modifiedMs: 4000, createdMs: 2000 }),
  folder("Archive", { modifiedMs: 2000, createdMs: 4000 }),
  file("logo.png", { size: 50, modifiedMs: 2000 }),
];

describe("sortAssetEntries", () => {
  it("defaults to folders first, then names A to Z", () => {
    expect(names(sortAssetEntries(FIXTURE, DEFAULT_ASSET_SORT))).toEqual([
      "Archive",
      "renders",
      "b-roll.mov",
      "Intro.mp4",
      "logo.png",
      "music.mp3",
    ]);
  });

  it("keeps folders on top for every key in both directions", () => {
    for (const key of ASSET_SORT_KEYS) {
      for (const direction of ["asc", "desc"] as const) {
        const sorted = sortAssetEntries(FIXTURE, { key, direction });
        expect(sorted.slice(0, 2).every((e) => e.isDirectory)).toBe(true);
        expect(sorted.slice(2).every((e) => !e.isDirectory)).toBe(true);
      }
    }
  });

  it("reverses names, folders included, for Z to A", () => {
    expect(
      names(sortAssetEntries(FIXTURE, { key: "name", direction: "desc" })),
    ).toEqual([
      "renders",
      "Archive",
      "music.mp3",
      "logo.png",
      "Intro.mp4",
      "b-roll.mov",
    ]);
  });

  it("puts the largest first, and folders by name since they have no size", () => {
    expect(
      names(sortAssetEntries(FIXTURE, { key: "size", direction: "desc" })),
    ).toEqual([
      "Archive",
      "renders",
      "Intro.mp4",
      "b-roll.mov",
      "music.mp3",
      "logo.png",
    ]);
  });

  it("proves the harness sees a difference: size order is not name order", () => {
    const bySize = names(
      sortAssetEntries(FIXTURE, { key: "size", direction: "desc" }),
    );
    const byName = names(sortAssetEntries(FIXTURE, DEFAULT_ASSET_SORT));
    expect(bySize).not.toEqual(byName);
  });

  it("sends a missing size last in both directions", () => {
    const entries = [
      file("unknown.mp4"),
      file("big.mp4", { size: 100 }),
      file("small.mp4", { size: 1 }),
    ];
    expect(
      names(sortAssetEntries(entries, { key: "size", direction: "desc" })),
    ).toEqual(["big.mp4", "small.mp4", "unknown.mp4"]);
    expect(
      names(sortAssetEntries(entries, { key: "size", direction: "asc" })),
    ).toEqual(["small.mp4", "big.mp4", "unknown.mp4"]);
  });

  it("puts the newest first, folders among themselves by date", () => {
    expect(
      names(sortAssetEntries(FIXTURE, { key: "modified", direction: "desc" })),
    ).toEqual([
      "renders",
      "Archive",
      "music.mp3",
      "b-roll.mov",
      "logo.png",
      "Intro.mp4",
    ]);
  });

  it("breaks a date tie by name A to Z in both directions", () => {
    const entries = [
      file("c.mp4", { modifiedMs: 10 }),
      file("a.mp4", { modifiedMs: 10 }),
      file("b.mp4", { modifiedMs: 20 }),
    ];
    expect(
      names(sortAssetEntries(entries, { key: "modified", direction: "desc" })),
    ).toEqual(["b.mp4", "a.mp4", "c.mp4"]);
    expect(
      names(sortAssetEntries(entries, { key: "modified", direction: "asc" })),
    ).toEqual(["a.mp4", "c.mp4", "b.mp4"]);
  });

  it("sends a missing creation date last", () => {
    expect(
      names(sortAssetEntries(FIXTURE, { key: "created", direction: "asc" })),
    ).toEqual([
      "renders",
      "Archive",
      "b-roll.mov",
      "music.mp3",
      "Intro.mp4",
      "logo.png",
    ]);
  });

  it("orders kinds video, image, audio, other, then by extension", () => {
    const entries = [
      file("notes.txt"),
      file("song.mp3"),
      file("still.png"),
      file("loop.gif"),
      file("clip.mp4"),
      file("take.mov"),
      folder("sub"),
    ];
    expect(
      names(sortAssetEntries(entries, { key: "kind", direction: "asc" })),
    ).toEqual([
      "sub",
      "take.mov",
      "clip.mp4",
      "loop.gif",
      "still.png",
      "song.mp3",
      "notes.txt",
    ]);
  });

  it("reverses kinds but not the name tie-break", () => {
    const entries = [
      file("b.mp4"),
      file("a.mp4"),
      file("z.png"),
    ];
    expect(
      names(sortAssetEntries(entries, { key: "kind", direction: "desc" })),
    ).toEqual(["z.png", "a.mp4", "b.mp4"]);
  });

  it("sorts numerically so clip2 precedes clip10", () => {
    const entries = [file("clip10.mp4"), file("clip2.mp4"), file("clip1.mp4")];
    expect(names(sortAssetEntries(entries, DEFAULT_ASSET_SORT))).toEqual([
      "clip1.mp4",
      "clip2.mp4",
      "clip10.mp4",
    ]);
  });

  it("gives names that differ only by case one order whatever readdir answered", () => {
    const one = [file("a.mp4"), file("A.mp4"), file("b.mp4")];
    const other = [file("b.mp4"), file("A.mp4"), file("a.mp4")];
    expect(names(sortAssetEntries(one, DEFAULT_ASSET_SORT))).toEqual(
      names(sortAssetEntries(other, DEFAULT_ASSET_SORT)),
    );
  });

  it("never mutates its input", () => {
    const frozen = Object.freeze([...FIXTURE]);
    expect(() =>
      sortAssetEntries(frozen, { key: "size", direction: "desc" }),
    ).not.toThrow();
    expect(frozen.map((e) => e.name)).toEqual(FIXTURE.map((e) => e.name));
  });
});

describe("choosing", () => {
  it("starts a new key in its natural direction", () => {
    expect(withSortKey(DEFAULT_ASSET_SORT, "size")).toEqual({
      key: "size",
      direction: "desc",
    });
    expect(
      withSortKey({ key: "size", direction: "asc" }, "modified"),
    ).toEqual({ key: "modified", direction: "desc" });
    expect(withSortKey({ key: "size", direction: "desc" }, "name")).toEqual({
      key: "name",
      direction: "asc",
    });
  });

  it("returns its input by identity when the key is already chosen", () => {
    const current: AssetSort = { key: "size", direction: "asc" };
    expect(withSortKey(current, "size")).toBe(current);
  });

  it("changes the direction and keeps the key", () => {
    const current: AssetSort = { key: "modified", direction: "desc" };
    expect(withSortDirection(current, "asc")).toEqual({
      key: "modified",
      direction: "asc",
    });
    expect(withSortDirection(current, "desc")).toBe(current);
  });

  it("lists the natural direction first", () => {
    for (const key of ASSET_SORT_KEYS) {
      const [first, second] = directionRows(key);
      expect(first.direction).toBe(NATURAL_DIRECTION[key]);
      expect(second.direction).not.toBe(first.direction);
    }
    expect(directionRows("size").map((r) => r.labelKey)).toEqual([
      "setting.sort_largest_first",
      "setting.sort_smallest_first",
    ]);
  });
});

describe("coerceAssetSort", () => {
  it("accepts a valid sort", () => {
    expect(coerceAssetSort({ key: "created", direction: "asc" })).toEqual({
      key: "created",
      direction: "asc",
    });
  });

  it("falls back to the default for junk", () => {
    for (const junk of [null, undefined, 42, "size", [], {}, { key: "tags" }]) {
      expect(coerceAssetSort(junk)).toEqual(DEFAULT_ASSET_SORT);
    }
  });

  it("keeps a known key and takes its natural direction for a bad one", () => {
    expect(coerceAssetSort({ key: "size", direction: "up" })).toEqual({
      key: "size",
      direction: "desc",
    });
  });
});

describe("extensionOf", () => {
  it("reads the last extension, lowercased", () => {
    expect(extensionOf("Clip.Final.MP4")).toBe("mp4");
  });

  it("treats a leading dot as part of a hidden file's name", () => {
    expect(extensionOf(".env")).toBe("");
    expect(extensionOf("README")).toBe("");
  });
});

describe("locale", () => {
  function locale(name: string): Record<string, unknown> {
    const path = fileURLToPath(
      new URL(`../../locale/${name}.json`, import.meta.url),
    );
    return JSON.parse(readFileSync(path, "utf8"));
  }

  function lookup(dict: Record<string, unknown>, dotted: string): unknown {
    return dotted
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        dict,
      );
  }

  const used = [
    "setting.sort_by",
    ...Object.values(SORT_KEY_LABEL),
    ...ASSET_SORT_KEYS.flatMap((key) => directionRows(key).map((r) => r.labelKey)),
    "setting.kind_folder",
    "setting.kind_video",
    "setting.kind_image",
    "setting.kind_audio",
    "setting.kind_file",
    "setting.date_today",
    "setting.date_yesterday",
  ];

  for (const name of ["en", "ko"]) {
    it(`${name}.json has every string the sort menu and the list column use`, () => {
      const dict = locale(name);
      for (const key of used) {
        expect(typeof lookup(dict, key), key).toBe("string");
        expect((lookup(dict, key) as string).length, key).toBeGreaterThan(0);
      }
    });
  }
});
