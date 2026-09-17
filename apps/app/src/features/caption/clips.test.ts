import { describe, expect, it } from "vitest";
import {
  clipFollows,
  clipLines,
  clipRanges,
  clipSections,
  joinClipLines,
  removedTotalOf,
  sweepClips,
  transcribeClips,
  type ClipJob,
} from "./clips";
import {
  linesFromWordGroups,
  mergeLineWithPrevious,
  removeLine,
  splitLineAt,
  type CaptionLine,
} from "./lines";
import { captionSources } from "./sources";
import type { JobOutcome } from "./transcribeSession";

function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

/** A whole-file transcript: words at 1s, 5s and 9s, the middle line two words. */
const transcript = (): CaptionLine[] =>
  linesFromWordGroups(
    [
      [{ word: "early", start: 1, end: 2 }],
      [
        { word: "inside", start: 5, end: 6 },
        { word: "edge", start: 7.5, end: 8.5 },
      ],
      [{ word: "late", start: 9, end: 10 }],
    ],
    counter("t"),
  );

describe("clipLines", () => {
  it("tags every line with the clip", () => {
    const out = clipLines(transcript(), { key: "x", window: null }, counter("x"));
    expect(out.map((l) => l.sourceKey)).toEqual(["x", "x", "x"]);
  });

  it("keeps every word when the clip has no window", () => {
    const out = clipLines(transcript(), { key: "x", window: null }, counter("x"));
    expect(out.map((l) => l.text)).toEqual(["early", "inside edge", "late"]);
  });

  // Speech the clip trimmed away used to be captioned anyway, before or after
  // the clip, and twice over for two clips cut from one file.
  it("drops lines with no word inside the clip's window", () => {
    const out = clipLines(
      transcript(),
      { key: "x", window: { startMs: 4_000, endMs: 8_600 } },
      counter("x"),
    );
    expect(out.map((l) => l.text)).toEqual(["inside edge"]);
  });

  it("keeps a word by its midpoint and clamps its edges to the window", () => {
    const [line] = clipLines(
      transcript(),
      { key: "x", window: { startMs: 5_500, endMs: 8_200 } },
      counter("x"),
    );
    // "inside" (midpoint 5.5) and "edge" (midpoint 8.0) both stay, clamped.
    expect(line.words.map((w) => [w.word, w.start, w.end])).toEqual([
      ["inside", 5.5, 6],
      ["edge", 7.5, 8.2],
    ]);
    expect([line.start, line.end]).toEqual([5.5, 8.2]);
    expect(line.text).toBe("inside edge");
  });

  it("rebuilds the text and the span of a line that lost words", () => {
    const [line] = clipLines(
      transcript(),
      { key: "x", window: { startMs: 4_000, endMs: 7_000 } },
      counter("x"),
    );
    expect(line).toMatchObject({ text: "inside", start: 5, end: 6 });
  });

  it("names every line afresh, so two clips of one transcript share no id", () => {
    const words = transcript();
    const mint = counter("n");
    const a = clipLines(words, { key: "a", window: null }, mint);
    const b = clipLines(words, { key: "b", window: null }, mint);
    const ids = [...a, ...b].map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => words.some((w) => w.id === id))).toBe(false);
  });
});

describe("joinClipLines", () => {
  it("concatenates in the chosen order and skips a clip it has no window for", () => {
    const out = joinClipLines(
      [
        { key: "b", lines: transcript() },
        { key: "a", lines: transcript() },
        { key: "gone", lines: transcript() },
      ],
      [
        { key: "a", window: { startMs: 0, endMs: 3_000 } },
        { key: "b", window: { startMs: 8_800, endMs: 11_000 } },
      ],
      counter("j"),
    );
    expect(out.map((l) => [l.sourceKey, l.text])).toEqual([
      ["b", "late"],
      ["a", "early"],
    ]);
  });
});

describe("clipRanges", () => {
  const two = () => [
    ...clipLines(transcript(), { key: "a", window: null }, counter("a")),
    ...clipLines(transcript(), { key: "b", window: null }, counter("b")),
  ];

  it("gives each clip its own struck lines only", () => {
    const ls = removeLine(two(), 4); // b's "inside edge"
    const ranges = clipRanges(
      ls,
      [
        { key: "a", window: null },
        { key: "b", window: null },
      ],
      {},
      true,
    );
    expect(ranges).toEqual([
      { key: "a", sourceRanges: [] },
      { key: "b", sourceRanges: [{ startMs: 5_000, endMs: 8_500 }] },
    ]);
  });

  it("adds each clip's silences while the toggle is on, and none while it is off", () => {
    const silence = { a: [{ startMs: 2_000, endMs: 4_000 }] };
    const clips = [{ key: "a", window: null }];
    expect(clipRanges(two(), clips, silence, true)[0].sourceRanges).toEqual(silence.a);
    expect(clipRanges(two(), clips, silence, false)[0].sourceRanges).toEqual([]);
  });

  it("keeps the chosen order", () => {
    const keys = clipRanges(
      two(),
      [
        { key: "b", window: null },
        { key: "a", window: null },
      ],
      {},
      true,
    ).map((r) => r.key);
    expect(keys).toEqual(["b", "a"]);
  });

  // The two halves of one recording have to be cut identically, or the sound
  // drifts from the picture.
  it("cuts a twin exactly as the clip it follows", () => {
    const ls = removeLine(two(), 0);
    const ranges = clipRanges(
      ls,
      [
        { key: "a", window: null },
        { key: "a-audio", window: null, follows: "a" },
      ],
      { a: [{ startMs: 2_000, endMs: 3_000 }] },
      true,
    );
    expect(ranges[1]).toEqual({ key: "a-audio", sourceRanges: ranges[0].sourceRanges });
    expect(ranges[0].sourceRanges.length).toBe(2);
  });

  it("adds everything up for the footer", () => {
    expect(
      removedTotalOf([
        { key: "a", sourceRanges: [{ startMs: 0, endMs: 500 }] },
        { key: "b", sourceRanges: [{ startMs: 100, endMs: 350 }, { startMs: 9, endMs: 3 }] },
      ]),
    ).toBe(750);
  });
});

describe("clipSections", () => {
  const two = () => [
    ...clipLines(transcript(), { key: "a", window: null }, counter("a")),
    ...clipLines(transcript(), { key: "b", window: null }, counter("b")),
  ];

  it("finds where each clip's lines sit, in the order asked", () => {
    expect(clipSections(two(), ["a", "b"])).toEqual([
      { key: "a", from: 0, to: 3 },
      { key: "b", from: 3, to: 6 },
    ]);
  });

  it("gives a clip with no speech an empty section where it would have been", () => {
    expect(clipSections(two(), ["a", "quiet", "b"])).toEqual([
      { key: "a", from: 0, to: 3 },
      { key: "quiet", from: 3, to: 3 },
      { key: "b", from: 3, to: 6 },
    ]);
    expect(clipSections([], ["quiet"])).toEqual([{ key: "quiet", from: 0, to: 0 }]);
  });

  it("stays contiguous through a split, a merge and a strike-out", () => {
    let ls = two();
    ls = splitLineAt(ls, 1, 6, "split");
    ls = mergeLineWithPrevious(ls, 4); // refused: a boundary
    ls = mergeLineWithPrevious(ls, 2);
    ls = removeLine(ls, 0);
    const sections = clipSections(ls, ["a", "b"]);
    expect(sections).toEqual([
      { key: "a", from: 0, to: 3 },
      { key: "b", from: 3, to: 6 },
    ]);
    for (const { key, from, to } of sections) {
      expect(ls.slice(from, to).every((l) => l.sourceKey === key)).toBe(true);
    }
  });
});

describe("clipFollows", () => {
  const rows = () =>
    captionSources({
      v: { filetype: "video", localpath: "file:///r.mov", startTime: 0, duration: 4_000 },
      a: { filetype: "audio", localpath: "file:///r.mov", startTime: 0, duration: 4_000 },
      moved: { filetype: "audio", localpath: "file:///r.mov", startTime: 50, duration: 4_000 },
    });

  it("makes the later of two twins follow the earlier, in the chosen order", () => {
    const [v, a] = rows();
    expect(clipFollows([a, v])).toEqual(new Map([["v", "a"]]));
    expect(clipFollows([v, a])).toEqual(new Map([["a", "v"]]));
  });

  it("does not pair clips that start apart, however close", () => {
    const [v, , moved] = rows();
    expect(clipFollows([v, moved]).size).toBe(0);
  });
});

describe("transcribeClips", () => {
  const job = (key: string, over: Partial<ClipJob> = {}): ClipJob => ({
    key,
    window: null,
    localpath: `file:///${key}.mov`,
    ...over,
  });
  const lines = (word: string): JobOutcome => ({
    kind: "lines",
    lines: linesFromWordGroups([[{ word, start: 0, end: 1 }]], counter(word)),
  });

  it("runs the clips one after another, in the chosen order", async () => {
    const calls: string[] = [];
    let inFlight = 0;
    let most = 0;
    const out = await transcribeClips([job("b"), job("a")], {
      cancelled: () => false,
      run: async (clip, index, total) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        calls.push(`${clip.key}:${index}/${total}`);
        await Promise.resolve();
        inFlight -= 1;
        return lines(clip.key);
      },
    });
    expect(calls).toEqual(["b:0/2", "a:1/2"]);
    expect(most).toBe(1);
    expect(out.kind === "lines" && out.byKey.map((e) => e.key)).toEqual(["b", "a"]);
  });

  it("skips a twin, and counts only the clips that run", async () => {
    const calls: string[] = [];
    await transcribeClips([job("v"), job("a", { follows: "v" }), job("c")], {
      cancelled: () => false,
      run: async (clip, index, total) => {
        calls.push(`${clip.key}:${index}/${total}`);
        return lines(clip.key);
      },
    });
    expect(calls).toEqual(["v:0/2", "c:1/2"]);
  });

  it("counts a clip with no speech as an answer", async () => {
    const out = await transcribeClips([job("quiet")], {
      cancelled: () => false,
      run: async () => ({ kind: "lines", lines: [] }),
    });
    expect(out).toEqual({ kind: "lines", byKey: [{ key: "quiet", lines: [] }] });
  });

  it("stops at the first failure and names the clip", async () => {
    const calls: string[] = [];
    const out = await transcribeClips([job("a"), job("b"), job("c")], {
      cancelled: () => false,
      run: async (clip) => {
        calls.push(clip.key);
        return clip.key === "b"
          ? { kind: "failed", message: "No such media file" }
          : lines(clip.key);
      },
    });
    expect(out).toEqual({ kind: "failed", key: "b", message: "No such media file" });
    expect(calls).toEqual(["a", "b"]);
  });

  it("stops when a job comes back cancelled", async () => {
    const calls: string[] = [];
    const out = await transcribeClips([job("a"), job("b")], {
      cancelled: () => false,
      run: async (clip) => {
        calls.push(clip.key);
        return { kind: "cancelled" };
      },
    });
    expect(out).toEqual({ kind: "cancelled" });
    expect(calls).toEqual(["a"]);
  });

  // `requestCancel` reaches only a running job. A Cancel pressed as one job
  // finished must not let the next one start.
  it("starts no further job once a cancel is asked for between two", async () => {
    let asked = false;
    const calls: string[] = [];
    const out = await transcribeClips([job("a"), job("b")], {
      cancelled: () => asked,
      run: async (clip) => {
        calls.push(clip.key);
        const result = lines(clip.key);
        asked = true;
        return result;
      },
    });
    expect(out).toEqual({ kind: "cancelled" });
    expect(calls).toEqual(["a"]);
  });

  it("starts nothing when cancelled before it begins", async () => {
    const calls: string[] = [];
    const out = await transcribeClips([job("a")], {
      cancelled: () => true,
      run: async (clip) => {
        calls.push(clip.key);
        return lines(clip.key);
      },
    });
    expect(out).toEqual({ kind: "cancelled" });
    expect(calls).toEqual([]);
  });
});

describe("sweepClips", () => {
  const job = (key: string, localpath: string, over: Partial<ClipJob> = {}): ClipJob => ({
    key,
    localpath,
    window: { startMs: 0, endMs: 10_000 },
    ...over,
  });

  /** Clip a speaks 1-2s; clip b, from another file, speaks 4-6s. */
  const ls = () => [
    ...clipLines(
      linesFromWordGroups([[{ word: "a", start: 1, end: 2 }]], counter("a")),
      { key: "a", window: null },
      counter("A"),
    ),
    ...clipLines(
      linesFromWordGroups([[{ word: "b", start: 4, end: 6 }]], counter("b")),
      { key: "b", window: null },
      counter("B"),
    ),
  ];

  const silentEverywhere = async () => ({
    ok: true,
    silences: [{ startMs: 0, endMs: 10_000 }],
  });

  // With one list of words for every clip, b's speech at 4-6s would have kept
  // a's footage at 4-6s, which is silence in a's own file.
  it("measures each clip's gaps against its own words only", async () => {
    const out = await sweepClips(
      [job("a", "file:///a.mov"), job("b", "file:///b.mov")],
      ls(),
      silentEverywhere,
      { keepMs: 0, minCutMs: 0 },
    );
    expect(out.byKey.a).toEqual([
      { startMs: 0, endMs: 1_000 },
      { startMs: 2_000, endMs: 10_000 },
    ]);
    expect(out.byKey.b).toEqual([
      { startMs: 0, endMs: 4_000 },
      { startMs: 6_000, endMs: 10_000 },
    ]);
  });

  it("decodes a file once however many clips are cut from it", async () => {
    const asked: string[] = [];
    await sweepClips(
      [
        job("a", "file:///same.mov"),
        job("b", "file:///same.mov"),
        job("c", "file:///other.mov"),
      ],
      ls(),
      async (localpath) => {
        asked.push(localpath);
        return silentEverywhere();
      },
    );
    expect(asked).toEqual(["file:///same.mov", "file:///other.mov"]);
  });

  it("keeps one clip's failure to that clip", async () => {
    const out = await sweepClips(
      [job("a", "file:///bad.mov"), job("b", "file:///b.mov"), job("c", "file:///throws.mov")],
      ls(),
      async (localpath) => {
        if (localpath === "file:///throws.mov") {
          throw new Error("decoder crashed");
        }
        return localpath === "file:///bad.mov"
          ? { ok: false, error: "No audio stream" }
          : silentEverywhere();
      },
    );
    expect(out.errors).toEqual({ a: "No audio stream", c: "decoder crashed" });
    expect(Object.keys(out.byKey)).toEqual(["b"]);
  });

  it("says something when a failure gives no reason", async () => {
    const out = await sweepClips([job("a", "file:///a.mov")], ls(), async () => null);
    expect(out.errors.a.length).toBeGreaterThan(0);
  });

  it("sweeps neither a twin nor a clip with no window", async () => {
    const asked: string[] = [];
    const out = await sweepClips(
      [
        job("a", "file:///a.mov"),
        job("twin", "file:///t.mov", { follows: "a" }),
        job("w", "file:///w.mov", { window: null }),
      ],
      ls(),
      async (localpath) => {
        asked.push(localpath);
        return silentEverywhere();
      },
    );
    expect(asked).toEqual(["file:///a.mov"]);
    expect(Object.keys(out.byKey)).toEqual(["a"]);
  });
});
