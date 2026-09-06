/**
 * Which video clips are worth holding a decoder for, given where the playhead is.
 *
 * Every video clip used to get its own `<video>` and keep it for the life of the
 * session. Three things follow from that, and all three were measured on a real
 * project of twenty-seven clips:
 *
 * - **Decoders scale with cuts, not with footage.** Twelve video clips came from
 *   four files; seven of them were the same file. `loadedAssetStore` keys its
 *   handles by element id, so that is seven independent decoders on one source.
 * - **Chromium blocks the 76th.** `WebMediaPlayer` creation is capped at 75 per
 *   frame on desktop, and each playing or `preload="auto"` element costs roughly
 *   30-80MB. A long edit reaches both limits without the project getting any
 *   more complicated to look at.
 * - **At most two of them are ever on screen.** Everything else is a decoder
 *   kept alive to show nothing.
 *
 * The window is deliberately two windows, not one. Loading only what is visible
 * *now* means a clip starts decoding at the instant the playhead arrives, which
 * is a stutter exactly at the cut; releasing as soon as it is not visible means
 * a clip is torn down and rebuilt every time the playhead crosses its edge. So
 * the load window leads the playhead and the release window is wider than it,
 * and the gap between them is the hysteresis.
 *
 * Pure and DOM-free: it answers questions about spans, and `loadedAssetStore`
 * decides what to do with the answers.
 */

import type { Timeline, TimelineElement } from "../../@types/timeline";
import { spanOf } from "../timeline/geometry";

/**
 * How far ahead of the playhead a clip is decoded before it is needed.
 *
 * Generous, because the cost of being wrong is asymmetric: a decoder held three
 * seconds early is idle memory, and a decoder started late is a visible hitch on
 * the frame the user is looking at. Three seconds is also comfortably longer
 * than a `loadeddata` for a local file.
 */
export const PRELOAD_AHEAD_MS = 3000;

/** How far behind the playhead a clip stays loaded. Shorter: nothing is coming. */
export const PRELOAD_BEHIND_MS = 1000;

/**
 * How far ahead a clip may drift before its decoder is released.
 *
 * The margin over `PRELOAD_AHEAD_MS` is what stops a playhead sitting near a
 * boundary — or a scrub jittering across one — from tearing a decoder down and
 * rebuilding it on alternate frames.
 */
export const RELEASE_AHEAD_MS = 10_000;

/** How far behind a clip may drift before its decoder is released. */
export const RELEASE_BEHIND_MS = 6000;

export type Window = { start: number; end: number };

export function loadWindow(cursorMs: number): Window {
  return {
    start: cursorMs - PRELOAD_BEHIND_MS,
    end: cursorMs + PRELOAD_AHEAD_MS,
  };
}

export function releaseWindow(cursorMs: number): Window {
  return {
    start: cursorMs - RELEASE_BEHIND_MS,
    end: cursorMs + RELEASE_AHEAD_MS,
  };
}

/**
 * Whether a clip's span overlaps a window at all.
 *
 * Half-open on both sides in the same sense `spanOf` is: a clip that ends
 * exactly where the window starts does not overlap it.
 */
export function spanOverlaps(element: TimelineElement, w: Window): boolean {
  const { start, end } = spanOf(element);
  return end > w.start && start < w.end;
}

/**
 * The clips whose decoders should be alive at `cursorMs`.
 *
 * `keep` is what must not be released; `load` is the subset worth decoding now.
 * `load` is always contained in `keep`, which is the invariant that makes the
 * two windows a hysteresis band rather than two independent policies —
 * `decoderWindow.test.ts` asserts it across a table of cursors.
 */
export function decodersFor(
  timeline: Timeline,
  cursorMs: number,
): { load: Set<string>; keep: Set<string> } {
  const load = new Set<string>();
  const keep = new Set<string>();
  const lw = loadWindow(cursorMs);
  const rw = releaseWindow(cursorMs);

  for (const [id, element] of Object.entries(timeline)) {
    if (element.filetype !== "video") {
      continue;
    }
    if (spanOverlaps(element, rw)) {
      keep.add(id);
    }
    if (spanOverlaps(element, lw)) {
      load.add(id);
    }
  }

  return { load, keep };
}
