/**
 * Minimal immutable update helper used by the timeline store to replace the
 * in-place-mutation pattern that tangled the data flow.
 *
 * The old `updateTimeline` reducer shallow-cloned only the top level, walked into
 * a live nested reference, mutated the leaf in place, then re-overlaid the
 * original object — so nested `trim`/`location`/`animation` stayed shared across
 * the store snapshot, every component alias, and every undo-history entry.
 *
 * `setIn` clones only the path from the root to the changed leaf (structural
 * sharing for everything else), producing a correct immutable update.
 */

export function setIn<T>(
  obj: T,
  path: ReadonlyArray<string | number>,
  value: unknown,
): T {
  if (path.length === 0) {
    return value as T;
  }
  const [head, ...rest] = path;
  const source: any = obj;
  const clone: any = Array.isArray(source) ? [...source] : { ...(source ?? {}) };
  clone[head] = setIn(source == null ? undefined : source[head], rest, value);
  return clone;
}
