/**
 * The caption session's document, as a fold over one ordered list of steps.
 *
 * While the auto-caption panel is open the timeline is not the user's any more:
 * it is a **projection** of `baseline` and whatever the panel currently says,
 * recomputed whenever the panel says something different and thrown away if the
 * user closes the window. This module is that projection, and nothing here
 * reads a store or touches the DOM, which is what lets the whole thing run
 * under `environment: "node"`.
 *
 * ## One list, applied one step at a time
 *
 * `applyCaptionCommit` already cuts and places in a single transform, and it
 * stays: it is the **definition** of the finished edit, and
 * `captionProjection.test.ts` holds this module to arriving at the same place.
 * What this adds is the same work expressed as a sequence, so the edit can be
 * revealed from 0ms rather than appearing all at once.
 *
 * A step is one cut or one caption, and the list is in timeline order with cuts
 * winning a tie, so the picture tightens and the words land from the start of
 * the project forwards.
 *
 * ## Two rules make the sequence come out where the batch does
 *
 * - **A caption is always placed against the *whole* cut list**, never against
 *   the cuts applied so far. Those two agree about where it starts, because
 *   `removedBefore` only counts cuts that begin before the caption does and
 *   those are exactly the applied ones. They disagree about its *length*: a
 *   caption straddling a later cut has to come out shorter, and passing the
 *   applied prefix would place it at full length over footage about to shrink.
 * - **A cut is applied to the piece that covers it now.** `removeRanges` splits
 *   the clip, and a later range falls in a piece that may not hold the original
 *   id, so each step re-finds the piece by position. Its range is carried into
 *   current coordinates by the cuts already applied, which is `shiftSpan` and
 *   nothing else.
 *
 * ## Ids are minted once and kept
 *
 * A caption's element id is keyed by the **line's** id, not by its position, so
 * striking out line three does not renumber every caption after it. A cut's two
 * split ids are keyed by the cut's index, not drawn from one running pool: the
 * pool order is the order `removeRanges` asks in, which for a prefix of k cuts
 * is a different order than for k+1, so every cut's pieces would be renamed on
 * every frame of the reveal. `loadedAssetStore` caches decoders by element id,
 * and on a 120fps source with an 8-second GOP one needless re-seek is visible.
 */

import type { TimelineElement } from "../../@types/timeline";
import {
  removeRanges,
  type TimeRange,
} from "../timeline/clipOps";
import { spanOf } from "../timeline/geometry";
import { overlaps } from "../timeline/overlap";
import { shiftSpan } from "../timeline/rippleMap";
import { clipsOnTrack, type TimelineDocument } from "../timeline/tracks";
import { placeCaptionRow, type CaptionIds } from "./applyCaptions";
import type { CaptionFrame, CaptionPlacement } from "./layout";
import type { CaptionLine } from "./lines";
import { captionRows, type CaptionRow } from "./rows";
import { captionToTimeline } from "./timing";

/**
 * The ids a session hands out, and goes on handing out.
 *
 * Both halves are keyed rather than positional. See the header.
 */
export type CaptionSessionIds = {
  /** Line id to the element and track it owns. Only ever grows. */
  captions: ReadonlyMap<string, CaptionIds>;
  /** Two per cut, indexed by the cut's place in the ascending list. */
  splits: readonly (readonly [string, string])[];
};

/** Everything the projection needs, with nothing left to decide. */
export type CaptionPlan = {
  sourceKey: string | null;
  /**
   * Timeline ms, **ascending**.
   *
   * `planCuts` answers descending, because that is the order `removeRanges`
   * wants when it is handed the lot at once. A reveal runs forwards, so the
   * list is turned round here, once, where it is easy to see.
   */
  cuts: TimeRange[];
  /** Source ms, from `rows.ts#captionRows`. */
  rows: CaptionRow[];
  ids: CaptionSessionIds;
};

export type RevealStep =
  | { kind: "cut"; at: number; index: number }
  | { kind: "caption"; at: number; row: CaptionRow };

/** Where a fold has got to. Carried between frames of a reveal. */
export type ProjectionState = {
  doc: TimelineDocument;
  /** How many steps have been applied. */
  applied: number;
  /** Those of them that were cuts, ascending. */
  appliedCuts: TimeRange[];
};

/**
 * Give every line and every cut a name, reusing the ones already handed out.
 *
 * Called on each rebuild rather than once, because a split makes a line the
 * session has never seen. A line that goes away keeps its entry: undo can bring
 * it back, and an element id that survives that is one the user's own undo
 * history still matches.
 */
export function mintSessionIds(
  previous: CaptionSessionIds | null,
  lines: CaptionLine[],
  cutCount: number,
  mintId: () => string,
): CaptionSessionIds {
  const captions = new Map<string, CaptionIds>(previous?.captions ?? []);
  for (const line of lines) {
    if (!captions.has(line.id)) {
      captions.set(line.id, { element: mintId(), track: mintId() });
    }
  }

  const splits = [...(previous?.splits ?? [])];
  while (splits.length < cutCount) {
    splits.push([mintId(), mintId()] as const);
  }

  return { captions, splits };
}

/**
 * The plan, from the panel's state and the cuts the session has planned.
 *
 * `cuts` arrives as `planCuts` left it: timeline ms, snapped, merged, clamped
 * and descending. The silence toggle needs no flag here, because switching it
 * off means the panel asked for fewer ranges and the list is simply shorter.
 * That is what makes the toggle exact rather than an attempt to undo a cut that
 * has no inverse: both states are built from the same baseline.
 */
export function buildCaptionPlan(input: {
  lines: CaptionLine[];
  sourceKey: string | null;
  frame: CaptionFrame;
  placement: CaptionPlacement;
  /** Descending, from `planCuts`. */
  cuts: TimeRange[];
  ids: CaptionSessionIds;
}): CaptionPlan {
  const cuts = [...input.cuts].reverse();

  return {
    sourceKey: input.sourceKey,
    cuts,
    rows: captionRows(
      input.lines,
      input.sourceKey,
      input.frame,
      input.placement,
    ),
    ids: input.ids,
  };
}

/**
 * The steps, in the order the user will watch them happen.
 *
 * A caption is ordered by where it sits on the **original** timeline, before
 * any cut, because that is the only clock every step shares. A cut at the same
 * instant goes first: the hole closes, then the word arrives on the footage
 * that closed it.
 */
export function revealSteps(
  plan: CaptionPlan,
  source: TimelineElement | undefined,
): RevealStep[] {
  const steps: RevealStep[] = plan.cuts.map((cut, index) => ({
    kind: "cut" as const,
    at: cut.startMs,
    index,
  }));

  for (const row of plan.rows) {
    steps.push({
      kind: "caption",
      at: captionToTimeline(
        { startTime: row.startTime, duration: row.duration },
        source,
      ).startTime,
      row,
    });
  }

  return steps.sort((a, b) => {
    if (a.at !== b.at) {
      return a.at - b.at;
    }
    return rank(a) - rank(b);
  });
}

/** A fold with nothing applied yet. */
export function startProjection(baseline: TimelineDocument): ProjectionState {
  return { doc: baseline, applied: 0, appliedCuts: [] };
}

/**
 * Apply steps until `upTo` of them have been.
 *
 * Resumable on purpose. A reveal frame advances the previous state by however
 * many steps are now due, so the whole animation costs one pass over the list
 * rather than one pass per frame. `placeNewElement` runs `normalizeDocument` on
 * every call, so re-folding from the baseline each frame would be quadratic in
 * the number of captions for no gain.
 *
 * Returns `state` by identity when there is nothing left to apply, so a caller
 * writing the result to the store wakes nobody.
 */
export function advanceProjection(
  state: ProjectionState,
  plan: CaptionPlan,
  steps: RevealStep[],
  source: TimelineElement | undefined,
  upTo: number,
): ProjectionState {
  const target = Math.min(steps.length, Math.max(0, upTo));
  if (target <= state.applied) {
    return state;
  }

  let doc = state.doc;
  let appliedCuts = state.appliedCuts;

  for (let index = state.applied; index < target; index += 1) {
    const step = steps[index];

    if (step.kind === "caption") {
      const ids = plan.ids.captions.get(step.row.lineId);
      if (ids != null) {
        // The whole cut list, never the applied prefix. See the header.
        doc = placeCaptionRow(doc, step.row, ids, source, plan.cuts);
      }
      continue;
    }

    const next = applyCut(doc, plan, step.index, appliedCuts, source);
    if (next !== doc) {
      doc = next;
      appliedCuts = [...appliedCuts, plan.cuts[step.index]];
    }
  }

  return { doc, applied: target, appliedCuts };
}

/** The whole plan at once. What a rebuild and the toggle both want. */
export function projectCaptions(
  baseline: TimelineDocument,
  plan: CaptionPlan,
  steps: RevealStep[],
  source: TimelineElement | undefined,
): TimelineDocument {
  return advanceProjection(
    startProjection(baseline),
    plan,
    steps,
    source,
    steps.length,
  ).doc;
}

function rank(step: RevealStep): number {
  return step.kind === "cut" ? 0 : 1;
}

/**
 * Cut one range out of whichever piece covers it now.
 *
 * The range is authored against the original timeline, so it is carried forward
 * by the cuts already made. Those all end at or before this one starts, since
 * `normalizeRanges` leaves the list disjoint and the reveal runs forwards, so
 * the shift is a translation and the length does not change.
 */
function applyCut(
  doc: TimelineDocument,
  plan: CaptionPlan,
  index: number,
  appliedCuts: TimeRange[],
  source: TimelineElement | undefined,
): TimelineDocument {
  const trackId = source?.trackId;
  const range = plan.cuts[index];
  if (trackId == null || range == null) {
    return doc;
  }

  const moved = shiftSpan(range, appliedCuts);
  if (moved == null) {
    return doc;
  }

  const pieceId = pieceCovering(doc, trackId, moved);
  if (pieceId == null) {
    return doc;
  }

  // Two ids, this cut's own. `removeRanges` draws the tail's first and may draw
  // neither when the range is flush to both edges; an undrawn id is simply
  // unused, which is the price of every cut keeping the same names whatever
  // else has been applied.
  const pool = plan.ids.splits[index] ?? [];
  let drawn = 0;
  return removeRanges(doc, pieceId, [moved], true, () => {
    const id = pool[drawn];
    drawn += 1;
    if (id == null) {
      // The pool is two deep and a single range draws at most two. Reaching
      // here means that stopped being true, and a fresh uuid would make the
      // reveal and the rebuild disagree about what the clips are called.
      throw new Error("captionProjection ran out of split ids.");
    }
    return id;
  });
}

/**
 * Which clip on the source's track holds `range` now.
 *
 * By position, because the piece that covers a given moment is not necessarily
 * the one holding the id the session started with: a cut flush to the left edge
 * makes the head the deleted middle. The search is safe to run over the whole
 * track because every range came through `planCuts`, which clamps it to the
 * transcribed clip's own span, and a ripple moves that clip's pieces and its
 * neighbours by the same amount.
 */
function pieceCovering(
  doc: TimelineDocument,
  trackId: string,
  range: TimeRange,
): string | null {
  for (const [id, element] of clipsOnTrack(doc, trackId)) {
    if (overlaps(spanOf(element), { start: range.startMs, end: range.endMs })) {
      return id;
    }
  }
  return null;
}
