/**
 * A least-recently-used map with a fixed capacity.
 *
 * The GPU LUT applier keeps one texture per LUT key. For presets that set is
 * small and fixed, and an unbounded map was fine. Colour adjustments broke
 * that: they are baked into a LUT keyed by their settings, so one drag across
 * a slider mints a new key per step, and each one would have pinned a texture
 * in video memory for the life of the app.
 *
 * `Map` iterates in insertion order, so re-inserting on a hit is all the
 * bookkeeping an LRU needs. `onEvict` is how a texture gets deleted when its
 * entry is pushed out.
 */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(
    readonly capacity: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`BoundedCache capacity must be a positive integer, got ${capacity}`);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** Look a value up and mark it most recently used. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) {
      return undefined;
    }
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Store a value, evicting the least recently used entry past capacity. */
  set(key: K, value: V): void {
    if (this.entries.has(key)) {
      const previous = this.entries.get(key) as V;
      this.entries.delete(key);
      if (previous !== value) {
        this.onEvict?.(key, previous);
      }
    }
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as K;
      const evicted = this.entries.get(oldest) as V;
      this.entries.delete(oldest);
      this.onEvict?.(oldest, evicted);
    }
  }

  values(): IterableIterator<V> {
    return this.entries.values();
  }

  /** Drop everything, telling `onEvict` about each entry. */
  clear(): void {
    const all = [...this.entries];
    this.entries.clear();
    for (const [key, value] of all) {
      this.onEvict?.(key, value);
    }
  }
}
