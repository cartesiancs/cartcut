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
 * ## Several clips, one fold
 *
 * A session can caption several clips at once. Each brings its own cuts, and a
 * cut ripples only the track it is made on (`clipOps.ts#rippleDelete`), so the
 * cuts are kept **per track**: a step shifts by the cuts already made on its own
 * track, and a caption is carried across every cut on its clip's track and no
 * other. Each cut is still **made** with its own clip's list, on that clip's
 * own pieces. Two cuts touching at the boundary between two clips are two
 * `removeRanges` calls on two pieces; handed over as one merged range, they
 * would be clamped to one piece and half of the footage would stay, while the
 * arithmetic, which is indifferent to merging, subtracted both halves.
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
 * split ids are keyed by its **clip** and its index within that clip, not drawn
 * from one running pool: the pool order is the order `removeRanges` asks in,
 * which for a prefix of k cuts is a different order than for k+1, so every
 * cut's pieces would be renamed on every frame of the reveal. Keying by clip is
 * what keeps a struck-out line in one clip from renaming another clip's pieces. `loadedAssetStore` caches decoders by element id,
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
  /**
   * Clip key to two ids per cut, indexed by the cut's place in that clip's
   * ascending list. Only ever grows.
   */
  splits: ReadonlyMap<string, readonly (readonly [string, string])[]>;
};

/** One chosen clip, as the plan needs it. */
export type CaptionPlanClip = {
  key: string;
  /** The clip as the session first saw it, before anything cut it. */
  source: TimelineElement | undefined;
  /** Where its cuts are made. Null for a clip that is not cut at all. */
  trackId: string | null;
  /** Timeline ms, **ascending**. */
  cuts: TimeRange[];
};

/** Everything the projection needs, with nothing left to decide. */
export type CaptionPlan = {
  /** In the order the user chose them. */
  clips: CaptionPlanClip[];
  /**
   * Every cut on each track, ascending: the clips' own lists laid end to end.
   * Only ever used for arithmetic; the cuts themselves are made per clip. See
   * the header.
   */
  lanes: ReadonlyMap<string, TimeRange[]>;
  /** Source ms, from `rows.ts#captionRows`, each carrying its clip's key. */
  rows: CaptionRow[];
  ids: CaptionSessionIds;
};

export type RevealStep =
  | { kind: "cut"; at: number; clipKey: string; index: number; trackId: string }
  | { kind: "caption"; at: number; row: CaptionRow };

/** Where a fold has got to. Carried between frames of a reveal. */
export type ProjectionState = {
  doc: TimelineDocument;
  /** How many steps have been applied. */
  applied: number;
  /** Those of them that were cuts, ascending, by the track they were made on. */
  appliedCuts: ReadonlyMap<string, TimeRange[]>;
};

/**
 * Give every line and every cut a name, reusing the ones already handed out.
 *
 * Called on each rebuild rather than once, because a split makes a line the
 * session has never seen. A line that goes away keeps its entry: undo can bring
 * it back, and an element id that survives that is one the user's own undo
 * history still matches.
 *
 * `cutCounts` is how many cuts each clip has now, by key.
 */
export function mintSessionIds(
  previous: CaptionSessionIds | null,
  lines: CaptionLine[],
  cutCounts: ReadonlyMap<string, number>,
  mintId: () => string,
): CaptionSessionIds {
  const captions = new Map<string, CaptionIds>(previous?.captions ?? []);
  for (const line of lines) {
    if (!captions.has(line.id)) {
      captions.set(line.id, { element: mintId(), track: mintId() });
    }
  }

  const splits = new Map(previous?.splits ?? []);
  for (const [key, count] of cutCounts) {
    const pairs = [...(splits.get(key) ?? [])];
    while (pairs.length < count) {
      pairs.push([mintId(), mintId()] as const);
    }
    splits.set(key, pairs);
  }

  return { captions, splits };
}

/**
 * The plan, from the panel's state and the cuts the session has planned.
 *
 * Each clip's `cuts` arrives as `planCuts` left it: timeline ms, snapped,
 * merged, clamped to that clip and descending. The silence toggle needs no flag
 * here, because switching it off means the panel asked for fewer ranges and the
 * lists are simply shorter. That is what makes the toggle exact rather than an
 * attempt to undo a cut that has no inverse: both states are built from the
 * same baseline.
 *
 * A line with no key belongs to the only clip there is, when there is only one.
 */
export function buildCaptionPlan(input: {
  lines: CaptionLine[];
  clips: readonly {
    key: string;
    source: TimelineElement | undefined;
    /** Descending, from `planCuts`. */
    cuts: TimeRange[];
  }[];
  frame: CaptionFrame;
  placement: CaptionPlacement;
  ids: CaptionSessionIds;
}): CaptionPlan {
  const clips: CaptionPlanClip[] = input.clips.map((clip) => {
    const trackId = clip.source?.trackId;
    return {
      key: clip.key,
      source: clip.source,
      trackId: typeof trackId === "string" && trackId.length > 0 ? trackId : null,
      cuts: [...clip.cuts].reverse(),
    };
  });

  const lanes = new Map<string, TimeRange[]>();
  for (const clip of clips) {
    if (clip.trackId == null || clip.cuts.length === 0) {
      continue;
    }
    lanes.set(clip.trackId, [...(lanes.get(clip.trackId) ?? []), ...clip.cuts]);
  }
  for (const cuts of lanes.values()) {
    // Stable, and the lists are disjoint because the clips on one track are:
    // sorting orders them without joining anything.
    cuts.sort((a, b) => a.startMs - b.startMs);
  }

  return {
    clips,
    lanes,
    rows: captionRows(
      input.lines,
      clips.length === 1 ? clips[0].key : null,
      input.frame,
      input.placement,
    ),
    ids: input.ids,
  };
}

/**
 * The steps, in the order the user will watch them happen.
 *
 * A step is ordered by where it sits on the **original** timeline, before any
 * cut, because that is the only clock every step shares, across clips and
 * across tracks. A cut at the same instant goes first: the hole closes, then
 * the word arrives on the footage that closed it. The sort is stable, so ties
 * between clips keep the chosen order.
 *
 * A caption whose clip is not in the plan is left out: there is nothing to map
 * it through, and placing it at its source time would be placing it nowhere in
 * particular.
 */
export function revealSteps(plan: CaptionPlan): RevealStep[] {
  const steps: RevealStep[] = [];
  for (const clip of plan.clips) {
    if (clip.trackId == null) {
      continue;
    }
    clip.cuts.forEach((cut, index) => {
      steps.push({
        kind: "cut",
        at: cut.startMs,
        clipKey: clip.key,
        index,
        trackId: clip.trackId!,
      });
    });
  }

  for (const row of plan.rows) {
    const placed = placementOf(plan, row);
    if (placed == null) {
      continue;
    }
    steps.push({
      kind: "caption",
      at: captionToTimeline(
        { startTime: row.startTime, duration: row.duration },
        placed.source,
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
  return { doc: baseline, applied: 0, appliedCuts: new Map() };
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
      const placed = placementOf(plan, step.row);
      if (ids != null && placed != null) {
        // The whole of this track's cut list, never the applied prefix. See
        // the header.
        doc = placeCaptionRow(doc, step.row, ids, placed.source, placed.cuts);
      }
      continue;
    }

    const applied = appliedCuts.get(step.trackId) ?? [];
    const next = applyCut(doc, plan, step, applied);
    if (next !== doc) {
      doc = next;
      const range = cutOf(plan, step);
      if (range != null) {
        appliedCuts = new Map(appliedCuts).set(step.trackId, [...applied, range]);
      }
    }
  }

  return { doc, applied: target, appliedCuts };
}

/** The whole plan at once. What a rebuild and the toggle both want. */
export function projectCaptions(
  baseline: TimelineDocument,
  plan: CaptionPlan,
  steps: RevealStep[],
): TimelineDocument {
  return advanceProjection(
    startProjection(baseline),
    plan,
    steps,
    steps.length,
  ).doc;
}

function rank(step: RevealStep): number {
  return step.kind === "cut" ? 0 : 1;
}

/**
 * The clip a row maps through, and the cuts it has to survive.
 *
 * A row with no key has no clip and no cuts, which is `captionToTimeline`'s
 * non-dynamic branch. A row naming a clip the plan does not hold is not placed.
 */
function placementOf(
  plan: CaptionPlan,
  row: CaptionRow,
): { source: TimelineElement | undefined; cuts: TimeRange[] } | null {
  if (row.sourceKey == null) {
    return { source: undefined, cuts: [] };
  }
  const clip = plan.clips.find((candidate) => candidate.key === row.sourceKey);
  if (clip == null) {
    return null;
  }
  return {
    source: clip.source,
    cuts: clip.trackId == null ? [] : (plan.lanes.get(clip.trackId) ?? []),
  };
}

function cutOf(
  plan: CaptionPlan,
  step: Extract<RevealStep, { kind: "cut" }>,
): TimeRange | undefined {
  return plan.clips.find((clip) => clip.key === step.clipKey)?.cuts[step.index];
}

/**
 * Cut one range out of whichever piece of its clip covers it now.
 *
 * The range is authored against the original timeline, so it is carried forward
 * by the cuts already made on its track. Those all end at or before this one
 * starts, since each clip's list is disjoint, the clips on a track do not
 * overlap and the reveal runs forwards, so the shift is a translation and the
 * length does not change.
 */
function applyCut(
  doc: TimelineDocument,
  plan: CaptionPlan,
  step: Extract<RevealStep, { kind: "cut" }>,
  applied: TimeRange[],
): TimelineDocument {
  const range = cutOf(plan, step);
  if (range == null) {
    return doc;
  }

  const moved = shiftSpan(range, applied);
  if (moved == null) {
    return doc;
  }

  const pieceId = pieceCovering(
    doc,
    step.trackId,
    piecesOf(plan, step.clipKey),
    moved,
  );
  if (pieceId == null) {
    return doc;
  }

  // Two ids, this cut's own. `removeRanges` draws the tail's first and may draw
  // neither when the range is flush to both edges; an undrawn id is simply
  // unused, which is the price of every cut keeping the same names whatever
  // else has been applied.
  const pool = plan.ids.splits.get(step.clipKey)?.[step.index] ?? [];
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
 * Every id a piece of one clip can carry: its own, and the split ids this
 * session hands out for it. The same set `removeRanges` keeps as `pieces`.
 */
function piecesOf(plan: CaptionPlan, key: string): ReadonlySet<string> {
  const ids = new Set<string>((plan.ids.splits.get(key) ?? []).flat());
  ids.add(key);
  return ids;
}

/**
 * Which piece of the clip holds `range` now.
 *
 * By position, because the piece that covers a given moment is not necessarily
 * the one holding the id the session started with: a cut flush to the left edge
 * makes the head the deleted middle.
 *
 * Only the clip's own pieces are candidates. `clipsOnTrack` lists transitions
 * as well, and a centred one starts half its length before the cut it covers,
 * so the sweep's lead-in cut, which begins on the clip's first frame, used to
 * find the transition first and split that instead of the clip. The same
 * restriction keeps a cut from landing on the neighbouring clip of another
 * chosen source.
 */
function pieceCovering(
  doc: TimelineDocument,
  trackId: string,
  pieces: ReadonlySet<string>,
  range: TimeRange,
): string | null {
  for (const [id, element] of clipsOnTrack(doc, trackId)) {
    if (!pieces.has(id)) {
      continue;
    }
    if (overlaps(spanOf(element), { start: range.startMs, end: range.endMs })) {
      return id;
    }
  }
  return null;
}
