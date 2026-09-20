/**
 * Video thumbnails, keyed by the encoded file URL.
 *
 * These are blob URLs — not serializable, so they do not belong in a store.
 * They used to live on the `<asset-list>` DOM element as a plain object that
 * child elements wrote into directly, which is why every `asset-file` had to
 * reach back out through `document.querySelector`.
 *
 * The source's pixel dimensions ride along with the URL because
 * `captureThumbnail` already has them — it reads `videoWidth`/`videoHeight` to
 * size its canvas — and throwing them away costs the hover preview a visible
 * reflow: it must open the instant the dwell completes, which is before
 * `loadedmetadata`, so without a known aspect it opens as a 16:9 guess and
 * jumps when the real numbers arrive.
 *
 * **Bounded, and it revokes what it drops.** A blob URL is a reference the
 * garbage collector will not reclaim on its own, so an unbounded map of them is
 * a leak that grows with every folder anybody browses. The bound is
 * `createTileCache`, the filmstrip's LRU, rather than a second implementation:
 * it already promotes on read and disposes on eviction, and it has its own
 * suite.
 */

import { createTileCache } from "../timeline/strip/cache";

export type Thumbnail = {
  /** A blob URL for a single decoded frame. */
  url: string;
  /** The source's own pixel dimensions, not the thumbnail's. */
  w: number;
  h: number;
};

/**
 * How many thumbnails to keep.
 *
 * An entry is a downscaled JPEG of a few kilobytes since `THUMBNAIL_MAX_PX`
 * came in, so this is a couple of megabytes and covers a large folder end to
 * end, which is what makes scrolling back up free. The same order as the
 * filmstrip's own `MAX_TILES`.
 */
export const MAX_THUMBNAILS = 512;

export type ThumbnailCache = {
  get(url: string): Thumbnail | undefined;
  set(url: string, thumbnail: Thumbnail): void;
  has(url: string): boolean;
  clear(): void;
  readonly size: number;
};

/**
 * `revoke` is a parameter so the eviction rule is node-testable.
 *
 * There is no DOM test environment here, and `URL.revokeObjectURL` is the one
 * thing in this module that cannot run under `environment: "node"`. Injecting
 * it is the narrowest form of the port rule the rest of the codebase follows.
 */
export function createThumbnailCache(opts: {
  capacity: number;
  revoke: (url: string) => void;
}): ThumbnailCache {
  /**
   * The thumbnail beside its disposal, rather than a `Thumbnail` that also has
   * a `close`.
   *
   * `close` is what `createTileCache` calls on eviction and on a replaced key,
   * and revoking there is the entire reason this cache is bounded rather than
   * a plain Map. Keeping it in a wrapper means `get` hands back the stored
   * object itself: callers see a clean `Thumbnail` with no disposal hanging
   * off it, and a read on every tile's every render allocates nothing.
   */
  type Entry = { thumbnail: Thumbnail; close(): void };

  const cache = createTileCache<Entry>({ maxTiles: opts.capacity });

  return {
    get(url) {
      // `createTileCache` answers `null` for a miss and both callers test
      // `!= undefined`. Loose equality happens to treat `null` correctly, but
      // mapping here keeps the declared type honest rather than leaving a trap
      // for whoever tightens one of those comparisons.
      return cache.get(url)?.thumbnail ?? undefined;
    },

    set(url, thumbnail) {
      cache.set(url, {
        thumbnail: thumbnail,
        close: () => opts.revoke(thumbnail.url),
      });
    },

    has(url) {
      return cache.has(url);
    },

    clear() {
      cache.clear();
    },

    get size() {
      return cache.size;
    },
  };
}

export const thumbnailCache: ThumbnailCache = createThumbnailCache({
  capacity: MAX_THUMBNAILS,
  revoke: (url) => URL.revokeObjectURL(url),
});
