import { describe, expect, it } from "vitest";
import { transitionElement, videoElement } from "../renderer/testing";
import type { VideoElementType } from "../../@types/timeline";
import type { TimeRange } from "../timeline/clipOps";
import { snapMsToFrame } from "../timeline/frames";
import { spanOf } from "../timeline/geometry";
import { footageFaults, seededRandom } from "../timeline/testing";
import {
  SCHEMA_VERSION,
  clipsOnTrack,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";
import { applyCaptionCommit } from "./applyCaptions";
import {
  advanceProjection,
  buildCaptionPlan,
  mintSessionIds,
  projectCaptions,
  revealSteps,
  startProjection,
  type CaptionSessionIds,
} from "./captionProjection";
import { clipLines } from "./clips";
import { planCuts } from "./cuts";
import { linesFromWordGroups, removeLine, type CaptionLine } from "./lines";
import { captionRows } from "./rows";

const FRAME = { w: 1920, h: 1080 };

/** A 10s clip, source 0..10000, sitting at timeline 0. */
function doc(over: Record<string, unknown> = {}): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements: {
      clip: videoElement({
        trackId: "v1",
        startTime: 0,
        duration: 10_000,
        trim: { startTime: 0, endTime: 10_000 },
        sourceDuration: 10_000,
        ...over,
      }),
    },
  });
}

/** Four lines a second long, at 1s, 4s, 6s and 8s. */
const lines = (): CaptionLine[] =>
  linesFromWordGroups(
    [
      [{ word: "one", start: 1, end: 2 }],
      [{ word: "two", start: 4, end: 5 }],
      [{ word: "three", start: 6, end: 7 }],
      [{ word: "four", start: 8, end: 9 }],
    ],
    counter("line"),
  );

/** Named in sequence, so two runs of the same plan are comparable. */
function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

/** Cuts at 2.5-3s, 5-5.5s and 7.2-7.6s, descending as `planCuts` leaves them. */
function cuts(base: TimelineDocument): TimeRange[] {
  return planCuts(
    [
      { startMs: 2500, endMs: 3000 },
      { startMs: 5000, endMs: 5500 },
      { startMs: 7200, endMs: 7600 },
    ],
    base.elements.clip,
  ).cuts;
}

function idsFor(ls: CaptionLine[], cutCount: number): CaptionSessionIds {
  return mintSessionIds(null, ls, new Map([["clip", cutCount]]), counter("id"));
}

/** A clip's split ids, flattened into the pool `applyCaptionCommit` draws from. */
function poolOf(ids: CaptionSessionIds, key: string): string[] {
  return (ids.splits.get(key) ?? []).flatMap((pair) => [...pair]);
}

/** The one-clip plan every suite below started from. */
function oneClip(
  base: TimelineDocument,
  ls: CaptionLine[],
  cutList: TimeRange[],
  ids: CaptionSessionIds,
) {
  const plan = buildCaptionPlan({
    lines: ls,
    clips: [{ key: "clip", source: base.elements.clip, cuts: cutList }],
    frame: FRAME,
    placement: "lowerThird",
    ids,
  });
  return { plan, steps: revealSteps(plan) };
}

function planFor(
  base: TimelineDocument,
  ls: CaptionLine[],
  silenceOn: boolean,
  ids: CaptionSessionIds = idsFor(ls, cuts(base).length),
) {
  return oneClip(base, ls, silenceOn ? cuts(base) : [], ids);
}

/** Every placed caption, in time order, with its text and span. */
function captions(d: TimelineDocument) {
  return Object.values(d.elements)
    .filter((el) => el.filetype === "text")
    .sort((a, b) => a.startTime - b.startTime)
    .map((el) => ({
      text: (el as { text: string }).text,
      startTime: el.startTime,
      duration: el.duration,
    }));
}

/** Where the surviving footage sits on the source track, in order. */
function footage(d: TimelineDocument) {
  return clipsOnTrack(d, "v1")
    .map(([, el]) => ({ ...spanOf(el), trim: (el as any).trim }))
    .sort((a, b) => a.start - b.start)
    .map((piece) => ({
      start: Math.round(piece.start),
      end: Math.round(piece.end),
      from: Math.round(piece.trim.startTime),
      to: Math.round(piece.trim.endTime),
    }));
}

/** The batch answer, built from the same plan the sequence is built from. */
function batch(base: TimelineDocument, ls: CaptionLine[], silenceOn: boolean) {
  const ids = idsFor(ls, cuts(base).length);
  const { plan } = planFor(base, ls, silenceOn, ids);
  const rows = captionRows(ls, "clip", FRAME, "lowerThird");
  return applyCaptionCommit(base, {
    clips: [
      {
        key: "clip",
        // `applyCaptionCommit` takes them the way `planCuts` answers: descending.
        cuts: silenceOn ? cuts(base) : [],
        splits: poolOf(plan.ids, "clip"),
      },
    ],
    rows,
    ids: {
      captions: rows.map((row) => plan.ids.captions.get(row.lineId)!),
    },
  });
}

// The claim the whole module exists to keep. `applyCaptionCommit` is the
// definition of the finished edit; this is that edit expressed as a sequence so
// it can be watched happening, and the two have to land in the same place.
describe("the sequence arrives where the batch does", () => {
  it("agrees about every caption and every frame of surviving footage", () => {
    const base = doc();
    const ls = lines();
    const { plan, steps } = planFor(base, ls, true);

    const sequenced = projectCaptions(base, plan, steps);
    const batched = batch(base, ls, true);

    expect(captions(sequenced)).toEqual(captions(batched));
    expect(footage(sequenced)).toEqual(footage(batched));
  });

  it("agrees with the silence toggle off, where there is nothing to cut", () => {
    const base = doc();
    const ls = lines();
    const { plan, steps } = planFor(base, ls, false);

    expect(captions(projectCaptions(base, plan, steps)))
      .toEqual(captions(batch(base, ls, false)));
  });

  it("agrees on a trimmed clip playing at 2x, where the two clocks differ", () => {
    const base = doc({
      startTime: 3_000,
      duration: 8_000,
      speed: 2,
      trim: { startTime: 2_000, endTime: 10_000 },
    });
    const ls = lines();
    const { plan, steps } = planFor(base, ls, true);

    const sequenced = projectCaptions(base, plan, steps);
    const batched = batch(base, ls, true);

    expect(captions(sequenced)).toEqual(captions(batched));
    expect(footage(sequenced)).toEqual(footage(batched));
  });

  // A caption straddling a cut has to come out *shorter*, not merely earlier.
  // The sequence places it before that cut has been applied, so it can only be
  // right because `placeCaptionRow` is handed the whole cut list rather than
  // the prefix applied so far. This is the case that would catch the other
  // reading, and it is the one a suite would not think to write.
  it("shortens a caption the later cuts eat into", () => {
    const base = doc();
    const straddling = linesFromWordGroups(
      [[{ word: "long", start: 1, end: 6 }]],
      counter("line"),
    );
    const { plan, steps } = planFor(base, straddling, true);

    const sequenced = projectCaptions(base, plan, steps);
    expect(captions(sequenced)).toEqual(captions(batch(base, straddling, true)));
    // 1s to 6s is 5000ms, less the 2500-3000 and 5000-5500 cuts inside it.
    expect(captions(sequenced)[0].duration).toBe(4000);
  });
});

describe("the reveal", () => {
  it("runs in timeline order, from the start of the project forwards", () => {
    const base = doc();
    const { steps } = planFor(base, lines(), true);
    const times = steps.map((step) => step.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("applies a cut before a caption that begins at the same instant", () => {
    const base = doc();
    const together = linesFromWordGroups(
      [[{ word: "on-the-cut", start: 2.5, end: 3.5 }]],
      counter("line"),
    );
    const { steps } = planFor(base, together, true);
    const at2500 = steps.filter((step) => step.at === 2500);
    expect(at2500.map((step) => step.kind)).toEqual(["cut", "caption"]);
  });

  it("adds one step at a time and never takes one back", () => {
    const base = doc();
    const { plan, steps } = planFor(base, lines(), true);

    let state = startProjection(base);
    let placed = 0;
    for (let n = 1; n <= steps.length; n += 1) {
      state = advanceProjection(state, plan, steps, n);
      const now = captions(state.doc).length;
      expect(now).toBeGreaterThanOrEqual(placed);
      placed = now;
    }

    expect(captions(state.doc)).toEqual(
      captions(projectCaptions(base, plan, steps)),
    );
  });

  it("declines by identity when no further step is due", () => {
    const base = doc();
    const { plan, steps } = planFor(base, lines(), true);
    const state = advanceProjection(
      startProjection(base),
      plan,
      steps,
      3,
    );
    expect(advanceProjection(state, plan, steps, 3)).toBe(
      state,
    );
    expect(advanceProjection(state, plan, steps, 1)).toBe(
      state,
    );
  });
});

// Ids are what stop a rebuild from looking like a delete and an insert. The
// decoders `loadedAssetStore` caches are keyed by element id, and on the kind
// of source this app is used with one needless re-seek is visible.
describe("ids survive being rebuilt", () => {
  it("gives the same clips the same names on every rebuild", () => {
    const base = doc();
    const ls = lines();
    const ids = idsFor(ls, cuts(base).length);

    const first = planFor(base, ls, true, ids);
    const second = planFor(base, ls, true, ids);

    const names = (d: TimelineDocument) => Object.keys(d.elements).sort();
    expect(
      names(projectCaptions(base, second.plan, second.steps)),
    ).toEqual(
      names(projectCaptions(base, first.plan, first.steps)),
    );
  });

  it("keeps a cut's own names when the cuts before it go away", () => {
    const base = doc();
    const ls = lines();
    const ids = idsFor(ls, cuts(base).length);
    const { plan, steps } = planFor(base, ls, true, ids);

    // The last cut alone, versus all three. Drawing split ids from one running
    // pool would rename this cut's pieces between the two, because
    // `removeRanges` asks in descending order and there would be two fewer
    // draws before it.
    const lastOnly = advanceProjection(
      startProjection(base),
      plan,
      steps.filter((step) => step.kind === "cut" && step.index === 2),
      1,
    );
    const all = projectCaptions(base, plan, steps);

    const fromLastCut = Object.keys(lastOnly.doc.elements).filter(
      (key) => key !== "clip",
    );
    expect(fromLastCut.length).toBeGreaterThan(0);
    for (const key of fromLastCut) {
      expect(Object.keys(all.elements)).toContain(key);
    }
  });

  it("names a line once and keeps that name when other lines are struck out", () => {
    const ls = lines();
    const before = mintSessionIds(null, ls, new Map(), counter("id"));
    const after = mintSessionIds(before, removeLine(ls, 1), new Map(), counter("id"));

    for (const line of ls) {
      expect(after.captions.get(line.id)).toBe(before.captions.get(line.id));
    }
  });

  it("names a line a split has just created, and leaves the rest alone", () => {
    const ls = lines();
    const before = mintSessionIds(null, ls, new Map(), counter("id"));
    const grown = [...ls, { ...ls[0], id: "brand-new" }];
    const after = mintSessionIds(before, grown, new Map(), counter("id"));

    expect(after.captions.get("brand-new")).toBeDefined();
    expect(after.captions.get(ls[0].id)).toBe(before.captions.get(ls[0].id));
  });
});

// `applyCaptions.ts` states this hazard for the batch path and
// `applyCaptions.test.ts` pins it there. The sequence has to survive it too,
// and it is harder here: each step re-finds the piece by position, so a cut
// that leaves the original id behind would strand every later step.
describe("a cut flush to the clip's own edge", () => {
  const firstLineRemoved = (): CaptionLine[] =>
    removeLine(
      linesFromWordGroups(
        [
          [{ word: "opening", start: 0, end: 1.5 }],
          [{ word: "middle", start: 4, end: 5 }],
          [{ word: "closing", start: 7, end: 8 }],
        ],
        counter("line"),
      ),
      0,
    );

  /** The struck-out line's own span, which is what the panel sends. */
  const cutsFromLines = (base: TimelineDocument, ls: CaptionLine[]) =>
    planCuts(
      ls
        .filter((line) => line.removed === true)
        .map((line) => ({ startMs: line.start * 1000, endMs: line.end * 1000 })),
      base.elements.clip,
    ).cuts;

  function planned(base: TimelineDocument, ls: CaptionLine[]) {
    const cuts = cutsFromLines(base, ls);
    return oneClip(base, ls, cuts, idsFor(ls, cuts.length));
  }

  it("takes the head off, and the survivor carries a new name", () => {
    const base = doc();
    const ls = firstLineRemoved();
    const { plan, steps } = planned(base, ls);

    const after = projectCaptions(base, plan, steps);

    // The id the session started with is the deleted middle: gone, not renamed.
    expect(after.elements.clip).toBeUndefined();
    expect(footage(after)).toHaveLength(1);
    // 1.5s off the front of a 10s clip, rippled back to the start.
    expect(footage(after)[0]).toMatchObject({ start: 0, end: 8500, from: 1500 });
  });

  it("still places the captions that survived, in the right places", () => {
    const base = doc();
    const ls = firstLineRemoved();
    const { plan, steps } = planned(base, ls);

    const after = projectCaptions(base, plan, steps);
    expect(captions(after)).toEqual([
      { text: "middle", startTime: 2500, duration: 1000 },
      { text: "closing", startTime: 5500, duration: 1000 },
    ]);
  });

  it("arrives where the batch does, id churn and all", () => {
    const base = doc();
    const ls = firstLineRemoved();
    const cuts = cutsFromLines(base, ls);
    const ids = idsFor(ls, cuts.length);
    const { plan, steps } = planned(base, ls);
    const rows = captionRows(ls, "clip", FRAME, "lowerThird");

    const batched = applyCaptionCommit(base, {
      clips: [{ key: "clip", cuts, splits: poolOf(ids, "clip") }],
      rows,
      ids: {
        captions: rows.map((row) => ids.captions.get(row.lineId)!),
      },
    });

    const sequenced = projectCaptions(base, plan, steps);
    expect(captions(sequenced)).toEqual(captions(batched));
    expect(footage(sequenced)).toEqual(footage(batched));
  });
});

describe("the silence toggle", () => {
  it("comes back to the baseline's own footage when it is switched off", () => {
    const base = doc();
    const ls = lines();
    const ids = idsFor(ls, cuts(base).length);

    const on = planFor(base, ls, true, ids);
    const off = planFor(base, ls, false, ids);

    const cut = projectCaptions(base, on.plan, on.steps);
    const restored = projectCaptions(
      base,
      off.plan,
      off.steps,
    );

    expect(footage(cut)).not.toEqual(footage(base));
    expect(footage(restored)).toEqual(footage(base));
  });

  it("is exact over a round trip, because both sides come from the baseline", () => {
    const base = doc();
    const ls = lines();
    const ids = idsFor(ls, cuts(base).length);
    const on = planFor(base, ls, true, ids);
    const off = planFor(base, ls, false, ids);

    const first = projectCaptions(base, on.plan, on.steps);
    projectCaptions(base, off.plan, off.steps);
    const again = projectCaptions(base, on.plan, on.steps);

    expect(footage(again)).toEqual(footage(first));
    expect(captions(again)).toEqual(captions(first));
    expect(Object.keys(again.elements).sort()).toEqual(
      Object.keys(first.elements).sort(),
    );
  });
});

// `clipsOnTrack` lists transitions too, sorted by start, and a centred one
// starts half its length before the cut it covers. The sweep's lead-in cut
// begins exactly at the clip's first frame, which is inside that window, so a
// search by position over the whole track found the transition first and cut
// it instead of the clip.
describe("a transition leading into the clip", () => {
  function withTransition(): TimelineDocument {
    return normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0)],
      elements: {
        prev: videoElement({
          trackId: "v1",
          startTime: 0,
          duration: 5_000,
          trim: { startTime: 0, endTime: 5_000 },
          sourceDuration: 10_000,
        }),
        clip: videoElement({
          trackId: "v1",
          startTime: 5_000,
          duration: 10_000,
          trim: { startTime: 1_000, endTime: 11_000 },
          sourceDuration: 12_000,
        }),
        tr: transitionElement({
          trackId: "v1",
          fromId: "prev",
          toId: "clip",
          startTime: 4_500,
          duration: 1_000,
        }),
      },
    });
  }

  /** Clips only: a transition has no trim to report. */
  const occupants = (d: TimelineDocument) =>
    clipsOnTrack(d, "v1")
      .filter(([, el]) => el.filetype !== "transition")
      .map(([, el]) => ({
        start: Math.round(spanOf(el).start),
        end: Math.round(spanOf(el).end),
        from: Math.round((el as any).trim.startTime),
      }));

  it("cuts the clip's own head, not the transition over it", () => {
    const base = withTransition();
    expect(base.elements.tr).toBeDefined();

    const leadIn = planCuts(
      [{ startMs: 1_000, endMs: 1_500 }],
      base.elements.clip,
    ).cuts;
    expect(leadIn).toEqual([{ startMs: 5_000, endMs: 5_500 }]);

    const ls = linesFromWordGroups(
      [[{ word: "hello", start: 3, end: 4 }]],
      counter("line"),
    );
    const { plan, steps } = oneClip(base, ls, leadIn, idsFor(ls, leadIn.length));
    const after = projectCaptions(base, plan, steps);

    expect(occupants(after)).toEqual([
      { start: 0, end: 5_000, from: 0 },
      { start: 5_000, end: 14_500, from: 1_500 },
    ]);
  });
});

// Several clips, one fold. The same parity claim as above, plus the two things
// that are new: cuts are tracked per track, and a clip's split ids are its own.
describe("several clips", () => {
  const lane = (trackId: string) => trackId;

  function clipOn(
    trackId: string,
    localpath: string,
    over: Record<string, unknown> = {},
  ) {
    return videoElement({
      trackId: lane(trackId),
      localpath,
      startTime: 0,
      duration: 10_000,
      trim: { startTime: 0, endTime: 10_000 },
      sourceDuration: 10_000,
      ...over,
    });
  }

  function build(
    tracks: string[],
    elements: Record<string, ReturnType<typeof videoElement>>,
  ): TimelineDocument {
    return normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: tracks.map((id, index) => createTrack(id, "video", index)),
      elements,
    });
  }

  /** One line per word, tagged with `key`. */
  function said(key: string, words: Array<[string, number, number]>): CaptionLine[] {
    return clipLines(
      linesFromWordGroups(
        words.map(([word, start, end]) => [{ word, start, end }]),
        counter(`${key}-raw`),
      ),
      { key, window: null },
      counter(`${key}-line`),
    );
  }

  type Ask = { key: string; ranges: TimeRange[] };

  function run(
    base: TimelineDocument,
    ls: CaptionLine[],
    asks: Ask[],
    previous: CaptionSessionIds | null = null,
    mint: () => string = counter("id"),
  ) {
    const clips = asks.map((ask) => ({
      key: ask.key,
      source: base.elements[ask.key],
      cuts: planCuts(ask.ranges, base.elements[ask.key]).cuts,
    }));
    const ids = mintSessionIds(
      previous,
      ls,
      new Map(clips.map((clip) => [clip.key, clip.cuts.length])),
      mint,
    );
    const plan = buildCaptionPlan({
      lines: ls,
      clips,
      frame: FRAME,
      placement: "lowerThird",
      ids,
    });
    const steps = revealSteps(plan);
    const batched = applyCaptionCommit(base, {
      clips: clips.map((clip) => ({
        key: clip.key,
        cuts: clip.cuts,
        splits: poolOf(ids, clip.key),
      })),
      rows: plan.rows,
      ids: { captions: plan.rows.map((row) => ids.captions.get(row.lineId)!) },
    });
    return {
      plan,
      steps,
      ids,
      sequenced: projectCaptions(base, plan, steps),
      batched,
    };
  }

  /** Every placed caption, with the text track it landed on. */
  const placed = (d: TimelineDocument) =>
    Object.values(d.elements)
      .filter((el) => el.filetype === "text")
      .sort((a, b) => a.startTime - b.startTime || a.trackId.localeCompare(b.trackId))
      .map((el) => ({
        text: (el as { text: string }).text,
        startTime: el.startTime,
        duration: el.duration,
        trackId: el.trackId,
      }));

  /** Footage on one track, with the file each piece plays. */
  const lanePieces = (d: TimelineDocument, trackId: string) =>
    clipsOnTrack(d, trackId)
      .filter(([, el]) => el.filetype !== "transition")
      .map(([id, el]) => ({
        id,
        file: (el as any).localpath as string,
        start: Math.round(spanOf(el).start),
        end: Math.round(spanOf(el).end),
        from: Math.round((el as any).trim.startTime),
      }));

  const withoutIds = (pieces: ReturnType<typeof lanePieces>) =>
    pieces.map(({ id, ...rest }) => rest);

  /** X at 0-10s and Y at 10-20s, both on v1, from two files. */
  const oneLane = () =>
    build(["v1"], {
      x: clipOn("v1", "file:///x.mov"),
      y: clipOn("v1", "file:///y.mov", { startTime: 10_000 }),
    });

  const twoSpeakers = () => [
    ...said("x", [
      ["x-one", 1, 2],
      ["x-two", 5, 6],
    ]),
    ...said("y", [
      ["y-one", 1, 2],
      ["y-two", 5, 6],
    ]),
  ];

  it("arrives where the batch does for two clips on one track", () => {
    const { sequenced, batched } = run(oneLane(), twoSpeakers(), [
      { key: "x", ranges: [{ startMs: 2_500, endMs: 3_500 }] },
      { key: "y", ranges: [{ startMs: 3_000, endMs: 4_000 }] },
    ]);
    expect(placed(sequenced)).toEqual(placed(batched));
    expect(withoutIds(lanePieces(sequenced, "v1"))).toEqual(
      withoutIds(lanePieces(batched, "v1")),
    );
  });

  it("moves the later clip's captions by exactly what the earlier clip lost", () => {
    const { sequenced } = run(oneLane(), twoSpeakers(), [
      { key: "x", ranges: [{ startMs: 2_500, endMs: 3_500 }] },
      { key: "y", ranges: [{ startMs: 7_000, endMs: 8_000 }] },
    ]);
    expect(placed(sequenced).map(({ text, startTime }) => [text, startTime])).toEqual([
      ["x-one", 1_000],
      ["x-two", 4_000],
      // Y started at 10s; X lost 1s before it. Y's own later cut moves nothing
      // of X's, and nothing of Y's that precedes it.
      ["y-one", 10_000],
      ["y-two", 14_000],
    ]);
  });

  // Merged, the two would be one range clamped to one piece: X's tail would go
  // and Y's head would stay, while the arithmetic subtracted both.
  it("makes both cuts when X's tail cut touches Y's head cut", () => {
    const { sequenced, batched } = run(oneLane(), twoSpeakers(), [
      { key: "x", ranges: [{ startMs: 9_000, endMs: 10_000 }] },
      { key: "y", ranges: [{ startMs: 0, endMs: 500 }] },
    ]);
    expect(withoutIds(lanePieces(sequenced, "v1"))).toEqual([
      { file: "file:///x.mov", start: 0, end: 9_000, from: 0 },
      { file: "file:///y.mov", start: 9_000, end: 18_500, from: 500 },
    ]);
    expect(withoutIds(lanePieces(batched, "v1"))).toEqual(
      withoutIds(lanePieces(sequenced, "v1")),
    );
    expect(placed(sequenced)).toEqual(placed(batched));
    expect(placed(sequenced).find((c) => c.text === "y-one")?.startTime).toBe(9_500);
  });

  it("agrees when the second clip is trimmed and plays at 2x", () => {
    const base = build(["v1"], {
      x: clipOn("v1", "file:///x.mov"),
      y: clipOn("v1", "file:///y.mov", {
        startTime: 10_000,
        duration: 8_000,
        speed: 2,
        trim: { startTime: 1_000, endTime: 9_000 },
      }),
    });
    const { sequenced, batched } = run(base, twoSpeakers(), [
      { key: "x", ranges: [{ startMs: 3_000, endMs: 4_000 }] },
      { key: "y", ranges: [{ startMs: 2_500, endMs: 3_500 }] },
    ]);
    expect(placed(sequenced)).toEqual(placed(batched));
    expect(withoutIds(lanePieces(sequenced, "v1"))).toEqual(
      withoutIds(lanePieces(batched, "v1")),
    );
  });

  describe("on two tracks", () => {
    /** X at 0-10s on v1, Y at 5-15s on v2: they play together from 5s. */
    const twoLanes = () =>
      build(["v1", "v2"], {
        x: clipOn("v1", "file:///x.mov"),
        y: clipOn("v2", "file:///y.mov", { startTime: 5_000 }),
      });
    const asks: Ask[] = [
      { key: "x", ranges: [{ startMs: 2_500, endMs: 3_500 }] },
      { key: "y", ranges: [{ startMs: 0, endMs: 500 }, { startMs: 3_000, endMs: 4_000 }] },
    ];

    it("arrives where the batch does, text tracks included", () => {
      const { sequenced, batched } = run(twoLanes(), twoSpeakers(), asks);
      expect(placed(sequenced)).toEqual(placed(batched));
      for (const trackId of ["v1", "v2"]) {
        expect(withoutIds(lanePieces(sequenced, trackId))).toEqual(
          withoutIds(lanePieces(batched, trackId)),
        );
      }
    });

    it("cuts each track by its own clip's cuts and nobody else's", () => {
      const { sequenced } = run(twoLanes(), twoSpeakers(), asks);
      expect(withoutIds(lanePieces(sequenced, "v1"))).toEqual([
        { file: "file:///x.mov", start: 0, end: 2_500, from: 0 },
        { file: "file:///x.mov", start: 2_500, end: 9_000, from: 3_500 },
      ]);
      expect(withoutIds(lanePieces(sequenced, "v2"))).toEqual([
        { file: "file:///y.mov", start: 5_000, end: 7_500, from: 500 },
        { file: "file:///y.mov", start: 7_500, end: 13_500, from: 4_000 },
      ]);
      // Y's captions move by Y's cuts only: y-one at source 1s sat at 6s.
      expect(placed(sequenced).find((c) => c.text === "y-one")?.startTime).toBe(5_500);
      expect(placed(sequenced).find((c) => c.text === "x-two")?.startTime).toBe(4_000);
    });

    it("runs the reveal in original timeline order across both tracks", () => {
      const { steps } = run(twoLanes(), twoSpeakers(), asks);
      const times = steps.map((step) => step.at);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(new Set(steps.filter((s) => s.kind === "cut").map((s) => (s as any).trackId)))
        .toEqual(new Set(["v1", "v2"]));
    });

    it("tracks the applied cuts per track, and a resumed reveal lands where a whole one does", () => {
      const base = twoLanes();
      const { plan, steps } = run(base, twoSpeakers(), asks);
      let state = startProjection(base);
      for (let n = 1; n <= steps.length; n += 1) {
        state = advanceProjection(state, plan, steps, n);
      }
      expect(state.appliedCuts.get("v1")).toHaveLength(1);
      expect(state.appliedCuts.get("v2")).toHaveLength(2);
      expect(placed(state.doc)).toEqual(placed(projectCaptions(base, plan, steps)));
    });
  });

  // `loadedAssetStore` caches decoders by element id. Striking a line out in X
  // must not rename Y's pieces.
  it("keeps Y's piece names when X's cut count changes", () => {
    const base = oneLane();
    const ls = twoSpeakers();
    const yCuts = { key: "y", ranges: [{ startMs: 3_000, endMs: 4_000 }] };
    const mint = counter("id");
    const many = run(base, ls, [
      { key: "x", ranges: [{ startMs: 2_500, endMs: 3_000 }, { startMs: 7_000, endMs: 8_000 }] },
      yCuts,
    ], null, mint);
    const fewer = run(base, ls, [
      { key: "x", ranges: [{ startMs: 7_000, endMs: 8_000 }] },
      yCuts,
    ], many.ids, mint);

    const yPieces = (d: TimelineDocument) =>
      lanePieces(d, "v1")
        .filter((p) => p.file === "file:///y.mov")
        .map((p) => p.id)
        .sort();
    expect(yPieces(fewer.sequenced)).toEqual(yPieces(many.sequenced));
    expect(yPieces(many.sequenced).length).toBe(2);
  });

  it("ripples an unchosen clip between two chosen ones, and never cuts it", () => {
    const base = build(["v1"], {
      x: clipOn("v1", "file:///x.mov", { duration: 5_000, trim: { startTime: 0, endTime: 5_000 } }),
      m: clipOn("v1", "file:///m.mov", {
        startTime: 5_000,
        duration: 3_000,
        trim: { startTime: 0, endTime: 3_000 },
      }),
      y: clipOn("v1", "file:///y.mov", {
        startTime: 8_000,
        duration: 5_000,
        trim: { startTime: 0, endTime: 5_000 },
      }),
    });
    const { sequenced, batched } = run(base, twoSpeakers(), [
      { key: "x", ranges: [{ startMs: 1_000, endMs: 2_000 }] },
      { key: "y", ranges: [{ startMs: 0, endMs: 1_000 }] },
    ]);
    const middle = lanePieces(sequenced, "v1").filter((p) => p.file === "file:///m.mov");
    expect(middle).toEqual([
      { id: "m", file: "file:///m.mov", start: 4_000, end: 7_000, from: 0 },
    ]);
    expect(withoutIds(lanePieces(sequenced, "v1"))).toEqual(
      withoutIds(lanePieces(batched, "v1")),
    );
  });

  it("places nothing for a line whose clip is not in the plan", () => {
    const ls = [...twoSpeakers(), ...said("ghost", [["boo", 1, 2]])];
    const { sequenced, batched, steps } = run(oneLane(), ls, [
      { key: "x", ranges: [] },
      { key: "y", ranges: [] },
    ]);
    expect(placed(sequenced).map((c) => c.text)).not.toContain("boo");
    expect(placed(batched).map((c) => c.text)).not.toContain("boo");
    expect(steps).toHaveLength(4);
  });

  // Both receive the one cached transcript of the file, and each keeps only
  // the words inside its own window, under ids of its own.
  it("captions two clips of one file once each", () => {
    const base = build(["v1"], {
      a: clipOn("v1", "file:///same.mov", { duration: 8_000, trim: { startTime: 0, endTime: 8_000 } }),
      b: clipOn("v1", "file:///same.mov", {
        startTime: 8_000,
        duration: 6_000,
        trim: { startTime: 4_000, endTime: 10_000 },
      }),
    });
    const file = linesFromWordGroups(
      [
        [{ word: "w1", start: 1, end: 2 }],
        [{ word: "w5", start: 5, end: 6 }],
        [{ word: "w9", start: 9, end: 9.5 }],
      ],
      counter("file"),
    );
    const mint = counter("line");
    const ls = [
      ...clipLines(file, { key: "a", window: { startMs: 0, endMs: 8_000 } }, mint),
      ...clipLines(file, { key: "b", window: { startMs: 4_000, endMs: 10_000 } }, mint),
    ];
    const { sequenced, batched } = run(base, ls, [
      { key: "a", ranges: [] },
      { key: "b", ranges: [] },
    ]);
    expect(placed(sequenced).map(({ text, startTime }) => [text, startTime])).toEqual([
      ["w1", 1_000],
      ["w5", 5_000],
      ["w5", 9_000],
      ["w9", 13_000],
    ]);
    expect(placed(sequenced)).toEqual(placed(batched));
    const textIds = Object.values(sequenced.elements).filter((el) => el.filetype === "text");
    expect(new Set(Object.keys(sequenced.elements)).size).toBe(
      Object.keys(sequenced.elements).length,
    );
    expect(textIds).toHaveLength(4);
  });

  it("keeps a single untagged clip working, by treating its lines as that clip's", () => {
    const base = doc();
    const ls = lines();
    const { plan } = run(base, ls, [{ key: "clip", ranges: [] }]);
    expect(plan.rows.every((row) => row.sourceKey === "clip")).toBe(true);
  });
});

// Silence cuts land a frame apart on a non-integer grid, so every edge the
// session computes is a float that two different sums reach. Before
// `clipOps.ts#rippleDelete` allowed for that, one cut in a few at 60fps left
// its tail behind, and because the plan's arithmetic assumed it had moved,
// every later cut took footage from the wrong place.
describe("footage stays contiguous", () => {
  it("closes both of the first two silences found in a 60fps recording", () => {
    // IMG_5587.MOV, where this was reported: the second tail stayed 650 ms
    // late and every cut after it landed 650 ms early, on speech.
    const base = doc({
      duration: 30_000,
      trim: { startTime: 0, endTime: 30_000 },
      sourceDuration: 30_000,
    });
    const source = base.elements.clip as VideoElementType;
    const cutList = planCuts(
      [
        { startMs: 11967, endMs: 12383 },
        { startMs: 24033, endMs: 24683 },
      ],
      source,
      (ms) => snapMsToFrame(ms, 60),
    ).cuts;
    const { plan, steps } = oneClip(base, [], cutList, idsFor([], cutList.length));

    const after = projectCaptions(base, plan, steps);

    expect(footageFaults(after, "v1", source, [...cutList].reverse())).toEqual([]);
    const third = clipsOnTrack(after, "v1")
      .map(([, el]) => el as VideoElementType)
      .sort((a, b) => a.startTime - b.startTime)[2];
    expect(third.startTime).toBeCloseTo(23616.667, 2);
    expect(third.trim.startTime).toBeCloseTo(24683.333, 2);
  });

  it("holds for seeded silences at four rates and three speeds, sequence and batch alike", () => {
    const random = seededRandom(917);
    const faults: string[] = [];

    for (const fps of [24, 30, 60, 120]) {
      for (const speed of [1, 1.5, 2]) {
        for (let run = 0; run < 12; run += 1) {
          const length = 30_000 + Math.floor(random() * 90_000);
          const base = doc({
            // On the grid and a third or two thirds of a second off it.
            startTime: (Math.floor(random() * 3) * 1000) / 3,
            duration: length,
            speed,
            trim: { startTime: 0, endTime: length },
            sourceDuration: length,
          });
          const source = base.elements.clip as VideoElementType;

          const silences: TimeRange[] = [];
          let at = run % 3 === 0 ? 0 : random() * 3000;
          while (at < length) {
            const width = 150 + random() * 900;
            silences.push({ startMs: at, endMs: Math.min(length, at + width) });
            at += width + 200 + random() * 6000;
          }
          if (run % 4 === 0) {
            silences.push({ startMs: length - 700, endMs: length });
          }

          const plan = planCuts(silences, source, (ms) => snapMsToFrame(ms, fps));
          if (plan.cuts.length === 0 || plan.coversWholeClip) {
            continue;
          }
          const ids = idsFor([], plan.cuts.length);
          const sequence = oneClip(base, [], plan.cuts, ids);
          const results = {
            sequence: projectCaptions(base, sequence.plan, sequence.steps),
            batch: applyCaptionCommit(base, {
              clips: [{ key: "clip", cuts: plan.cuts, splits: poolOf(ids, "clip") }],
              rows: [],
              ids: { captions: [] },
            }),
          };

          const ascending = [...plan.cuts].reverse();
          for (const [path, result] of Object.entries(results)) {
            for (const fault of footageFaults(result, "v1", source, ascending)) {
              faults.push(`${path}, ${fps}fps at ${speed}x, run ${run}: ${fault}`);
            }
          }
        }
      }
    }

    expect(faults).toEqual([]);
  });
});
