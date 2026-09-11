import { describe, expect, it } from "vitest";

import { BoundedCache } from "./boundedCache";

describe("BoundedCache", () => {
  it("refuses a capacity that is not a positive integer", () => {
    expect(() => new BoundedCache(0)).toThrow();
    expect(() => new BoundedCache(-1)).toThrow();
    expect(() => new BoundedCache(1.5)).toThrow();
  });

  it("keeps at most `capacity` entries, evicting the oldest", () => {
    const evicted: string[] = [];
    const cache = new BoundedCache<string, number>(2, (key) => evicted.push(key));
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size).toBe(2);
    expect(cache.has("a")).toBe(false);
    expect(evicted).toEqual(["a"]);
  });

  it("counts a read as a use, so a hot entry survives", () => {
    const cache = new BoundedCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it("answers undefined for a miss without disturbing the order", () => {
    const cache = new BoundedCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("zzz")).toBeUndefined();
    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
  });

  it("stores a null value and tells it apart from a miss", () => {
    const cache = new BoundedCache<string, number | null>(2);
    cache.set("failed", null);
    expect(cache.has("failed")).toBe(true);
    expect(cache.get("failed")).toBeNull();
  });

  it("evicts the replaced value when a key is overwritten with a different one", () => {
    const evicted: Array<[string, number]> = [];
    const cache = new BoundedCache<string, number>(4, (k, v) => evicted.push([k, v]));
    cache.set("a", 1);
    cache.set("a", 1);
    expect(evicted).toEqual([]);
    cache.set("a", 2);
    expect(evicted).toEqual([["a", 1]]);
    expect(cache.get("a")).toBe(2);
  });

  it("clear tells onEvict about everything", () => {
    const evicted: string[] = [];
    const cache = new BoundedCache<string, number>(4, (key) => evicted.push(key));
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(evicted.sort()).toEqual(["a", "b"]);
  });
});
