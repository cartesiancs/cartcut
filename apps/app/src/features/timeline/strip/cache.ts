/**
 * A bounded LRU for decoded tiles.
 *
 * An `ImageBitmap` holds GPU-backed memory that garbage collection will not
 * reclaim promptly, so the cache has to both bound its size and `close()` what
 * it drops. A long project scrolled end to end would otherwise accumulate
 * thousands of bitmaps.
 *
 * Pure and DOM-free: the values are opaque, so this is testable with plain
 * fakes.
 */

export interface Disposable {
  close?(): void;
}

export type TileCache<T extends Disposable> = {
  get(key: string): T | null;
  has(key: string): boolean;
  set(key: string, value: T): void;
  /** Drop every tile decoded from one source file. */
  invalidatePath(localpath: string): void;
  clear(): void;
  readonly size: number;
};

export function createTileCache<T extends Disposable>(opts: {
  maxTiles: number;
  /**
   * What one value costs, for `maxWeight`. The filmstrip weighs a tile by its
   * area: a row can be five times the default height, so a count alone would
   * let the same 400 tiles hold twenty-five times the memory.
   */
  weigh?: (value: T) => number;
  /**
   * Evict, oldest first, until the values weigh no more than this. The newest
   * value is always kept, so a single heavy one still displays.
   */
  maxWeight?: number;
}): TileCache<T> {
  // A Map iterates in insertion order, so re-inserting on read is enough to
  // maintain LRU order without a second structure.
  const entries = new Map<string, T>();
  const weights = new Map<string, number>();
  const max = Math.max(0, opts.maxTiles);
  const maxWeight = opts.maxWeight ?? Infinity;
  let total = 0;

  function weightOf(value: T): number {
    const w = opts.weigh?.(value) ?? 0;
    return Number.isFinite(w) && w > 0 ? w : 0;
  }

  function drop(key: string) {
    const value = entries.get(key);
    if (value !== undefined) {
      entries.delete(key);
      total -= weights.get(key) ?? 0;
      weights.delete(key);
      value.close?.();
    }
  }

  return {
    get(key) {
      const value = entries.get(key);
      if (value === undefined) {
        return null;
      }
      // Promote: delete then re-insert moves it to the newest position.
      entries.delete(key);
      entries.set(key, value);
      return value;
    },

    has(key) {
      return entries.has(key);
    },

    set(key, value) {
      if (entries.has(key)) {
        drop(key);
      }
      if (max === 0) {
        value.close?.();
        return;
      }

      entries.set(key, value);
      const weight = weightOf(value);
      weights.set(key, weight);
      total += weight;

      while (entries.size > max || (total > maxWeight && entries.size > 1)) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) {
          break;
        }
        drop(oldest);
      }
    },

    invalidatePath(localpath) {
      const prefix = `${localpath}|`;
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) {
          drop(key);
        }
      }
    },

    clear() {
      for (const key of [...entries.keys()]) {
        drop(key);
      }
    },

    get size() {
      return entries.size;
    },
  };
}
