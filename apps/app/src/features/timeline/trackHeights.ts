/**
 * How tall each timeline row is.
 *
 * View state, not document state: a row's height is kept outside
 * `TimelineDocument`, so it never enters the undo history (a ⌘Z meant for a cut
 * must not shrink a row instead) and the caption panel's lock, which exists to
 * keep the document still, does not stop anyone resizing a row while it is open.
 * It is still saved with the project, in its own `.ngt` entry
 * (`features/project/timelineView.ts`).
 *
 * The map holds only rows that differ from the default, keyed by track id, and
 * setting a row back to the default deletes its key. That is the optional-field
 * rule every feature here follows: a project nobody has resized a row in has an
 * empty map, writes no entry, and saves byte-identically to one written before
 * rows could be resized.
 *
 * A leaf: imports nothing, so `layout.ts`, the store and the project file can
 * all depend on it without a cycle.
 */

/** The height every row had before it could be resized. */
export const DEFAULT_TRACK_HEIGHT = 40;

/**
 * The shortest a row may be.
 *
 * The tallest of the things a row has to keep working: the level line needs 29
 * (`levelLine.ts`, a 17px inset plus a 12px band) and the cut affordance's ±9
 * band needs a few px of trim handle above and below it, which 32 leaves. The
 * header's 24px icon, the label (20) and the keyframe lane (16) fit beneath that.
 */
export const MIN_TRACK_HEIGHT = 32;

/** The tallest a row may be. Also the filmstrip's top decode rung. */
export const MAX_TRACK_HEIGHT = 200;

export type TrackHeights = Readonly<Record<string, number>>;

export const NO_TRACK_HEIGHTS: TrackHeights = Object.freeze({});

/**
 * A height fit to store, from anything.
 *
 * Whole pixels, because the filmstrip keys its decoded tiles by height and
 * `createImageBitmap` truncates a fractional size: a row at 57.5px would decode
 * one set of tiles and look up another.
 */
export function coerceTrackHeight(px: unknown): number {
  if (typeof px !== "number" || !Number.isFinite(px)) {
    return DEFAULT_TRACK_HEIGHT;
  }
  return Math.min(MAX_TRACK_HEIGHT, Math.max(MIN_TRACK_HEIGHT, Math.round(px)));
}

/**
 * The height of one row. Never throws, whatever the map holds.
 *
 * Own properties only, so a track whose id happens to be `constructor` or
 * `__proto__` reads its own entry or the default, never something inherited.
 */
export function trackHeightOf(heights: TrackHeights, trackId: string): number {
  if (!Object.prototype.hasOwnProperty.call(heights, trackId)) {
    return DEFAULT_TRACK_HEIGHT;
  }
  const px = heights[trackId];
  if (
    typeof px !== "number" ||
    !Number.isInteger(px) ||
    px < MIN_TRACK_HEIGHT ||
    px > MAX_TRACK_HEIGHT
  ) {
    return DEFAULT_TRACK_HEIGHT;
  }
  return px;
}

/**
 * The map with one row set, or the same map when nothing would change.
 *
 * Returning the input by identity is what lets the store decline a write that
 * changes nothing and wake no subscriber, and setting the default removes the
 * key rather than storing 40, so resizing a row away and back reads as clean.
 */
export function withTrackHeight(
  heights: TrackHeights,
  trackId: string,
  px: number,
): TrackHeights {
  const next = coerceTrackHeight(px);
  const has = Object.prototype.hasOwnProperty.call(heights, trackId);

  if (next === DEFAULT_TRACK_HEIGHT) {
    if (!has) {
      return heights;
    }
    return Object.fromEntries(
      Object.entries(heights).filter(([id]) => id !== trackId),
    );
  }

  if (has && heights[trackId] === next) {
    return heights;
  }
  return Object.fromEntries([
    ...Object.entries(heights).filter(([id]) => id !== trackId),
    [trackId, next],
  ]);
}

/**
 * The entries for `trackIds` that differ from the default, keys sorted.
 *
 * What gets saved and hashed. A row deleted from the timeline keeps its entry in
 * memory, so undoing the delete brings the height back with it, and this is
 * where that orphan is left out: the file only describes rows that exist.
 */
export function heightsFor(
  heights: TrackHeights,
  trackIds: Iterable<string>,
): TrackHeights {
  const entries: [string, number][] = [];
  for (const id of new Set(trackIds)) {
    const px = trackHeightOf(heights, id);
    if (px !== DEFAULT_TRACK_HEIGHT) {
      entries.push([id, px]);
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}
