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

describe("createTileCache with a weight budget", () => {
  type Sized = { area: number; close: () => void };
  const sized = (area: number) => ({ area, close: vi.fn() });
  const make = (maxWeight: number, maxTiles = 100) =>
    createTileCache<Sized>({
      maxTiles,
      weigh: (value) => value.area,
      maxWeight,
    });

  it("evicts the oldest until what is held fits the budget", () => {
    const cache = make(100);
    const a = sized(40);
    cache.set("a", a);
    cache.set("b", sized(40));
    cache.set("c", sized(40));
    expect(cache.has("a")).toBe(false);
    expect(a.close).toHaveBeenCalled();
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  it("still counts tiles, whichever limit binds first", () => {
    const cache = make(1_000_000, 2);
    cache.set("a", sized(1));
    cache.set("b", sized(1));
    cache.set("c", sized(1));
    expect(cache.size).toBe(2);
  });

  it("keeps a single value heavier than the whole budget, so it still draws", () => {
    const cache = make(10);
    cache.set("a", sized(5));
    cache.set("big", sized(500));
    expect(cache.has("a")).toBe(false);
    expect(cache.has("big")).toBe(true);
  });

  it("gives the weight back when a value leaves, however it leaves", () => {
    const cache = make(100);
    cache.set("/a.mp4|0|40", sized(60));
    cache.invalidatePath("/a.mp4");
    cache.set("x", sized(60));
    cache.set("y", sized(30));
    // 90 is under budget only if the invalidated 60 was given back.
    expect(cache.has("x")).toBe(true);
    expect(cache.has("y")).toBe(true);

    cache.set("x", sized(10)); // replaced: 60 out, 10 in
    cache.set("z", sized(60));
    expect(cache.size).toBe(3);

    cache.clear();
    cache.set("w", sized(100));
    expect(cache.has("w")).toBe(true);
    expect(cache.size).toBe(1);
  });

  it("is the count-only cache when nothing is weighed", () => {
    // The other users of `createTileCache` pass only `maxTiles`.
    const cache = createTileCache<Sized>({ maxTiles: 3, maxWeight: 1 });
    cache.set("a", sized(1000));
    cache.set("b", sized(1000));
    expect(cache.size).toBe(2);
  });
});
