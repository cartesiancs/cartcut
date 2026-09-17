/**
 * Assertions shared by the suites that cut footage out of a clip.
 *
 * Not a suite itself, and nothing in the app imports it. `clipOps.test.ts`
 * sweeps `removeRanges` directly and `captionProjection.test.ts` sweeps the
 * caption session built on it, and both have to ask the same questions of what
 * comes out, so the questions are written once.
 */

import { EDGE_SLACK_MS } from "../../utils/time";
import type { TimeRange } from "./clipOps";
import {
  isDynamicElement,
  sourceTimeAt,
  spanOf,
  type DynamicElement,
} from "./geometry";
import { clipsOnTrack, type TimelineDocument } from "./tracks";

/**
 * Everything wrong with a track after `cuts` were rippled out of `source`, as
 * readable lines. Empty means the edit is right.
 *
 * `cuts` is timeline ms, ascending, stated against the clip as it was before
 * any of them. The pieces must be exactly the stretches the cuts leave, in
 * order and butted together from where the clip started:
 *
 * - no hole and no overlap between two pieces, to within the microsecond the
 *   renderer's own window test allows (`utils/time.ts#isTimeInRange`);
 * - no piece of zero length, which is a clip nobody can see or select;
 * - every piece shows the source it should. A cut that fails to ripple leaves
 *   the plan's arithmetic one cut behind the document, so every later cut lands
 *   on the wrong footage. A check of the gaps alone cannot see that half.
 *
 * Only `source`'s own pieces are read, so the track may hold other clips.
 */
export function footageFaults(
  doc: TimelineDocument,
  trackId: string,
  source: DynamicElement,
  cuts: readonly TimeRange[],
): string[] {
  const span = spanOf(source);
  const kept: TimeRange[] = [];
  let cursor = span.start;
  for (const cut of cuts) {
    if (cut.startMs - cursor > EDGE_SLACK_MS) {
      kept.push({ startMs: cursor, endMs: cut.startMs });
    }
    cursor = Math.max(cursor, cut.endMs);
  }
  if (span.end - cursor > EDGE_SLACK_MS) {
    kept.push({ startMs: cursor, endMs: span.end });
  }

  const pieces = clipsOnTrack(doc, trackId)
    .map(([, element]) => element)
    .filter(isDynamicElement)
    .filter((element) => element.localpath === source.localpath)
    .sort((a, b) => a.startTime - b.startTime);

  if (pieces.length !== kept.length) {
    return [`${pieces.length} pieces, expected ${kept.length}`];
  }

  const faults: string[] = [];
  let expectedStart = span.start;
  pieces.forEach((piece, index) => {
    const { start, end, length } = spanOf(piece);
    if (Math.abs(start - expectedStart) > EDGE_SLACK_MS) {
      faults.push(`piece ${index} starts at ${start}, expected ${expectedStart}`);
    }
    if (length <= EDGE_SLACK_MS) {
      faults.push(`piece ${index} is ${length} ms long`);
    }
    const from = sourceTimeAt(source, kept[index].startMs);
    const to = sourceTimeAt(source, kept[index].endMs);
    if (
      Math.abs(piece.trim.startTime - from) > EDGE_SLACK_MS ||
      Math.abs(piece.trim.endTime - to) > EDGE_SLACK_MS
    ) {
      faults.push(
        `piece ${index} shows source ${piece.trim.startTime} to ${piece.trim.endTime}, expected ${from} to ${to}`,
      );
    }
    expectedStart = end;
  });
  return faults;
}

/**
 * A seeded stream in `[0, 1)`, so a failing sweep names a case that fails again.
 *
 * mulberry32, in 32-bit integer arithmetic throughout: a textbook LCG written
 * with `*` overflows 2^53 and stops being the generator it claims to be.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
