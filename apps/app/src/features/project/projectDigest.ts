/**
 * A fingerprint of the project's saveable state, for deciding whether it has
 * diverged from what is on disk.
 *
 * This replaces the detector on `features/element/elementTimeline.ts`, which
 * was a 32-bit DJB2 hash of `JSON.stringify(this.timeline)` kept in an
 * unbounded table keyed by `Date.now()`. Four things were wrong with it, and
 * each matters more once a save deletes a recovery copy:
 *
 * - **It hashed elements only.** A track rename or reorder read as
 *   unmodified, so File -> Open would `clearTimeline()` straight over unsaved
 *   track work.
 * - **32 bits, with weak avalanche.** The birthday bound is not the problem;
 *   a *near-neighbour* collision on a one-field edit is, because the
 *   consequence of "unchanged" is now "delete the only unsaved copy".
 * - `isTimelineChange` compared against `Object.keys(table)[length - 1]`,
 *   which is the newest entry only because V8 sorts integer-like keys
 *   numerically, and two saves in one millisecond collide.
 * - The table grew for the life of the session and only its last entry was
 *   ever read.
 *
 * ## Why a hand-rolled hash
 *
 * `crypto.subtle.digest` is the obvious answer and is wrong here twice: it is
 * async, and the web build is served over plain `http` from `express`, which
 * is not a secure context, so `crypto.subtle` is `undefined` there. A dirty
 * detector must not rest on a secure-context subtlety. Nothing in
 * `package.json` provides a hash, and adding a dependency for sixteen lines is
 * not worth it.
 *
 * So: two 32-bit lanes with different seeds, multipliers and rotations, mixed
 * with `Math.imul`, avalanched at the end and concatenated to 64 bits. The two
 * lanes are what buy the width. One lane hashed twice would correlate.
 */

import type { Timeline } from "../../@types/timeline";
import type { RenderOptions } from "../../states/renderOptionStore";
import type { TimelineTrack } from "../timeline/tracks";

/**
 * A 64-bit digest of `text`, as 16 lowercase hex characters.
 *
 * `Math.imul` is what keeps each multiply a 32-bit integer operation rather
 * than a float that silently loses the low bits past 2^53.
 */
export function digest64(text: string): string {
  let a = 0x9e3779b9;
  let b = 0x85ebca6b;

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    // A rotation as well as a different multiplier, so the two lanes disagree
    // about which input bits reach which output bits.
    b = Math.imul(b ^ c, 0x85ebca6b);
    b = (b << 13) | (b >>> 19);
  }

  return `${hex32(avalanche(a))}${hex32(avalanche(b))}`;
}

/**
 * The murmur3 finalizer.
 *
 * Without it a single changed character near the end of a long document moves
 * only the low bits, which is exactly the near-neighbour case that has to be
 * caught.
 */
function avalanche(h: number): number {
  let x = h;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

/**
 * The digest of everything a `.ngt` would preserve.
 *
 * **It takes the store's `RenderOptions`, not the `RenderOptionsFile` shape**,
 * and that is load-bearing rather than convenient. The file shape carries
 * `videoDestination` and `previewRatio`, which are save *context* and differ
 * between the `.ngt`'s path and an autosave's path — so hashing them would
 * make every autosave read as diverged from the save baseline forever, and the
 * recovery ring would never be dropped. Taking the store shape makes those two
 * fields absent by construction rather than by a comment someone has to
 * remember.
 *
 * `assetPaths.json` is excluded for the same reason: it is derived from the
 * elements plus an anchor, so including it would make the digest depend on
 * where the file is going.
 */
export function projectStateDigest(
  elements: Timeline,
  tracks: TimelineTrack[],
  options: RenderOptions,
  extensionData: string | null = null,
): string {
  return digest64(projectStateText(elements, tracks, options, extensionData));
}

/**
 * The text `projectStateDigest` hashes.
 *
 * Exported so a failing digest assertion can say *what* changed rather than
 * only that something did. The parts are joined with a newline, which cannot
 * occur unescaped inside `JSON.stringify` output, so no arrangement of one
 * part can imitate a boundary.
 */
export function projectStateText(
  elements: Timeline,
  tracks: TimelineTrack[],
  options: RenderOptions,
  /**
   * The `extensions.json` entry, or `null` when there is none.
   *
   * Included because it is saved with the project, so changing it has to make
   * the project dirty: without this an extension could store something, the
   * user could quit, and the quit guard would say there was nothing to save.
   * Defaulted so every existing caller and every existing test keeps the
   * digest it had for a project no extension has touched.
   */
  extensionData: string | null = null,
): string {
  return [
    JSON.stringify(elements),
    JSON.stringify(tracks),
    JSON.stringify(digestableOptions(options)),
    ...(extensionData == null ? [] : [extensionData]),
  ].join("\n");
}

/**
 * The render options that describe the project rather than a particular write.
 *
 * Listed field by field rather than spread, so a field added to
 * `RenderOptions` has to be considered here instead of silently joining the
 * digest. `exportSettings` is included whole: the codec and preset are the
 * user's choices and the file preserves them.
 */
function digestableOptions(options: RenderOptions): unknown {
  return {
    previewSize: options.previewSize,
    fps: options.fps,
    duration: options.duration,
    backgroundColor: options.backgroundColor,
    exportSettings: options.exportSettings,
  };
}
