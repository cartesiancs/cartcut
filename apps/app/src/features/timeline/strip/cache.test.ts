import { describe, it, expect, vi } from "vitest";
import { createTileCache } from "./cache";

/** A stand-in for an ImageBitmap: all the cache cares about is `close`. */
function tile(name = "t") {
  return { name, close: vi.fn() };
}

describe("createTileCache", () => {
  it("returns what it was given", () => {
    const cache = createTileCache<ReturnType<typeof tile>>({ maxTiles: 4 });
    const a = tile("a");
    cache.set("k", a);
    expect(cache.get("k")).toBe(a);
    expect(cache.has("k")).toBe(true);
  });

  it("reports a miss as null", () => {
    const cache = createTileCache({ maxTiles: 4 });
    expect(cache.get("nope")).toBeNull();
    expect(cache.has("nope")).toBe(false);
  });

  it("evicts the least recently used first", () => {
    const cache = createTileCache<ReturnType<typeof tile>>({ maxTiles: 2 });
    const a = tile("a");
    cache.set("a", a);
    cache.set("b", tile("b"));
    cache.set("c", tile("c"));

    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("closes what it evicts, since bitmaps are not collected promptly", () => {
    const cache = createTileCache<ReturnType<typeof tile>>({ maxTiles: 1 });
    const a = tile("a");
    cache.set("a", a);
    cache.set("b", tile("b"));
    expect(a.close).toHaveBeenCalledTimes(1);
  });

  it("promotes on read, so a tile still on screen survives", () => {
    const cache = createTileCache<ReturnType<typeof tile>>({ maxTiles: 2 });
    cache.set("a", tile("a"));
    cache.set("b", tile("b"));
    cache.get("a"); // "a" is now the newest
    cache.set("c", tile("c"));

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it("replaces an existing key and closes the value it displaced", () => {
    const cache = createTileCache<ReturnType<typeof tile>>({ maxTiles: 4 });
    const first = tile("first");
    const second = tile("second");
    cache.set("k", first);
    cache.set("k", second);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(cache.get("k")).toBe(second);
    expect(cache.size).toBe(1);
  });

  it("drops exactly the tiles from one source file", () => {
    const cache = createTileCache<ReturnType<typeof tile>>({ maxTiles: 10 });
    const mine = tile("mine");
    const other = tile("other");
    cache.set("/a.mp4|0|40", mine);
    cache.set("/b.mp4|0|40", other);

    cache.invalidatePath("/a.mp4");

    expect(cache.has("/a.mp4|0|40")).toBe(false);
    expect(cache.has("/b.mp4|0|40")).toBe(true);
    expect(mine.close).toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
  });

  it("does not treat one path as a prefix of a longer one", () => {
    // "/a.mp4" must not take "/a.mp4.backup" with it.
    const cache = createTileCache<ReturnType<typeof tile>>({ maxTiles: 10 });
    cache.set("/a.mp4|0|40", tile());
    cache.set("/a.mp4.backup|0|40", tile());

    cache.invalidatePath("/a.mp4");

    expect(cache.has("/a.mp4.backup|0|40")).toBe(true);
  });

  it("closes everything on clear", () => {
    const cache = createTileCache<ReturnType<typeof tile>>({ maxTiles: 10 });
    const a = tile("a");
    const b = tile("b");
    cache.set("a", a);
    cache.set("b", b);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(a.close).toHaveBeenCalled();
    expect(b.close).toHaveBeenCalled();
  });

  it("degenerates safely at zero capacity", () => {
    const cache = createTileCache<ReturnType<typeof tile>>({ maxTiles: 0 });
    const a = tile("a");
    cache.set("a", a);

    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeNull();
    // Nothing is retained, so the tile must be released rather than leaked.
    expect(a.close).toHaveBeenCalled();
  });

  it("tolerates values with no close method", () => {
    const cache = createTileCache<{ close?: () => void }>({ maxTiles: 1 });
    cache.set("a", {});
    expect(() => cache.set("b", {})).not.toThrow();
  });
});
