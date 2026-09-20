/**
 * The thumbnail cache's bound, and what it does with what it drops.
 *
 * A blob URL is a reference the garbage collector will not reclaim, so an
 * eviction that forgets to revoke is a leak that looks exactly like a working
 * cache. That is the whole subject here.
 */

import { describe, it, expect } from "vitest";
import { createThumbnailCache, type Thumbnail } from "./thumbnailCache";

function thumb(n: number): Thumbnail {
  return { url: `blob:${n}`, w: 3600, h: 2338 };
}

function cacheOf(capacity: number) {
  const revoked: string[] = [];
  const cache = createThumbnailCache({
    capacity: capacity,
    revoke: (url) => revoked.push(url),
  });
  return { cache: cache, revoked: revoked };
}

describe("createThumbnailCache", () => {
  it("round-trips an entry", () => {
    const { cache } = cacheOf(4);
    cache.set("a", thumb(1));

    expect(cache.get("a")).toEqual({ url: "blob:1", w: 3600, h: 2338 });
    expect(cache.has("a")).toBe(true);
  });

  it("answers undefined for a miss, not null", () => {
    // `assetList.render` and `hoverPreviewOverlay.open` both test
    // `!= undefined`. Loose equality happens to treat `null` correctly today,
    // so a `null` here would be a trap for whoever tightens one of them.
    const { cache } = cacheOf(4);

    expect(cache.get("nothing")).toBeUndefined();
    expect(cache.has("nothing")).toBe(false);
  });

  it("keeps the source's own dimensions, not the thumbnail's", () => {
    // The hover preview opens at this aspect before its own `loadedmetadata`,
    // so storing the downscaled box here is a visible jump when the real
    // numbers arrive.
    const { cache } = cacheOf(4);
    cache.set("a", { url: "blob:1", w: 3600, h: 2338 });

    expect(cache.get("a")?.w).toBe(3600);
    expect(cache.get("a")?.h).toBe(2338);
  });

  it("evicts down to capacity", () => {
    const { cache } = cacheOf(3);
    for (let n = 0; n < 5; n += 1) {
      cache.set(`k${n}`, thumb(n));
    }

    expect(cache.size).toBe(3);
  });

  it("revokes exactly what it evicted", () => {
    const { cache, revoked } = cacheOf(2);
    cache.set("a", thumb(1));
    cache.set("b", thumb(2));
    cache.set("c", thumb(3));

    expect(revoked).toEqual(["blob:1"]);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  it("revokes the url it displaces when a key is set again", () => {
    const { cache, revoked } = cacheOf(4);
    cache.set("a", thumb(1));
    cache.set("a", thumb(2));

    expect(revoked).toEqual(["blob:1"]);
    expect(cache.get("a")?.url).toBe("blob:2");
  });

  it("counts a read as a use, so a tile on screen is not evicted", () => {
    const { cache, revoked } = cacheOf(2);
    cache.set("a", thumb(1));
    cache.set("b", thumb(2));

    // "a" is the oldest by insertion, and reading it makes it the newest.
    cache.get("a");
    cache.set("c", thumb(3));

    expect(revoked).toEqual(["blob:2"]);
    expect(cache.has("a")).toBe(true);
  });

  it("proves the promotion above is what decided it", () => {
    // Same table with the read removed. If the harness were measuring nothing,
    // this would evict "b" as well.
    const { cache, revoked } = cacheOf(2);
    cache.set("a", thumb(1));
    cache.set("b", thumb(2));
    cache.set("c", thumb(3));

    expect(revoked).toEqual(["blob:1"]);
    expect(cache.has("a")).toBe(false);
  });

  it("revokes everything it is holding when cleared", () => {
    const { cache, revoked } = cacheOf(4);
    cache.set("a", thumb(1));
    cache.set("b", thumb(2));

    cache.clear();

    expect(revoked.sort()).toEqual(["blob:1", "blob:2"]);
    expect(cache.size).toBe(0);
  });
});
