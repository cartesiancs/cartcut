import { describe, expect, it } from "vitest";
import { videoElement } from "../renderer/testing";
import type { TimeRange } from "../timeline/clipOps";
import { spanOf } from "../timeline/geometry";
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
  return mintSessionIds(null, ls, cutCount, counter("id"));
}

function planFor(
  base: TimelineDocument,
  ls: CaptionLine[],
  silenceOn: boolean,
  ids: CaptionSessionIds = idsFor(ls, cuts(base).length),
) {
  const plan = buildCaptionPlan({
    lines: ls,
    sourceKey: "clip",
    frame: FRAME,
    placement: "lowerThird",
    cuts: silenceOn ? cuts(base) : [],
    ids,
  });
  return { plan, steps: revealSteps(plan, base.elements.clip) };
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
    sourceKey: "clip",
    // `applyCaptionCommit` takes them the way `planCuts` answers: descending.
    cuts: silenceOn ? cuts(base) : [],
    rows,
    ids: {
      captions: rows.map((row) => plan.ids.captions.get(row.lineId)!),
      splits: plan.ids.splits.flatMap((pair) => [...pair]),
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

    const sequenced = projectCaptions(base, plan, steps, base.elements.clip);
    const batched = batch(base, ls, true);

    expect(captions(sequenced)).toEqual(captions(batched));
    expect(footage(sequenced)).toEqual(footage(batched));
  });

  it("agrees with the silence toggle off, where there is nothing to cut", () => {
    const base = doc();
    const ls = lines();
    const { plan, steps } = planFor(base, ls, false);

    expect(captions(projectCaptions(base, plan, steps, base.elements.clip)))
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

    const sequenced = projectCaptions(base, plan, steps, base.elements.clip);
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

    const sequenced = projectCaptions(base, plan, steps, base.elements.clip);
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
      state = advanceProjection(state, plan, steps, base.elements.clip, n);
      const now = captions(state.doc).length;
      expect(now).toBeGreaterThanOrEqual(placed);
      placed = now;
    }

    expect(captions(state.doc)).toEqual(
      captions(projectCaptions(base, plan, steps, base.elements.clip)),
    );
  });

  it("declines by identity when no further step is due", () => {
    const base = doc();
    const { plan, steps } = planFor(base, lines(), true);
    const state = advanceProjection(
      startProjection(base),
      plan,
      steps,
      base.elements.clip,
      3,
    );
    expect(advanceProjection(state, plan, steps, base.elements.clip, 3)).toBe(
      state,
    );
    expect(advanceProjection(state, plan, steps, base.elements.clip, 1)).toBe(
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
      names(projectCaptions(base, second.plan, second.steps, base.elements.clip)),
    ).toEqual(
      names(projectCaptions(base, first.plan, first.steps, base.elements.clip)),
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
      base.elements.clip,
      1,
    );
    const all = projectCaptions(base, plan, steps, base.elements.clip);

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
    const before = mintSessionIds(null, ls, 0, counter("id"));
    const after = mintSessionIds(before, removeLine(ls, 1), 0, counter("id"));

    for (const line of ls) {
      expect(after.captions.get(line.id)).toBe(before.captions.get(line.id));
    }
  });

  it("names a line a split has just created, and leaves the rest alone", () => {
    const ls = lines();
    const before = mintSessionIds(null, ls, 0, counter("id"));
    const grown = [...ls, { ...ls[0], id: "brand-new" }];
    const after = mintSessionIds(before, grown, 0, counter("id"));

    expect(after.captions.get("brand-new")).toBeDefined();
    expect(after.captions.get(ls[0].id)).toBe(before.captions.get(ls[0].id));
  });
});

describe("the silence toggle", () => {
  it("comes back to the baseline's own footage when it is switched off", () => {
    const base = doc();
    const ls = lines();
    const ids = idsFor(ls, cuts(base).length);

    const on = planFor(base, ls, true, ids);
    const off = planFor(base, ls, false, ids);

    const cut = projectCaptions(base, on.plan, on.steps, base.elements.clip);
    const restored = projectCaptions(
      base,
      off.plan,
      off.steps,
      base.elements.clip,
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

    const first = projectCaptions(base, on.plan, on.steps, base.elements.clip);
    projectCaptions(base, off.plan, off.steps, base.elements.clip);
    const again = projectCaptions(base, on.plan, on.steps, base.elements.clip);

    expect(footage(again)).toEqual(footage(first));
    expect(captions(again)).toEqual(captions(first));
    expect(Object.keys(again.elements).sort()).toEqual(
      Object.keys(first.elements).sort(),
    );
  });
});
