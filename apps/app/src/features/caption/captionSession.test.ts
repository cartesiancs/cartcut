import { describe, expect, it } from "vitest";
import { videoElement } from "../renderer/testing";
import {
  SCHEMA_VERSION,
  clipsOnTrack,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";
import {
  CaptionSession,
  type CaptionSessionPorts,
} from "./captionSession";
import { revealDurationMs } from "./captionReveal";
import { linesFromWordGroups, setLineText, type CaptionLine } from "./lines";

const FRAME = { w: 1920, h: 1080 };

function doc(): TimelineDocument {
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
      }),
    },
  });
}

const lines = (): CaptionLine[] =>
  linesFromWordGroups(
    [
      [{ word: "one", start: 1, end: 2 }],
      [{ word: "two", start: 4, end: 5 }],
      [{ word: "three", start: 7, end: 8 }],
    ],
    counter("line"),
  );

function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

/**
 * A store, a lock and a clock, all of them lists of what happened.
 *
 * The orderings in `captionSession.ts` are the part that can be wrong, and none
 * of them is reachable from a test with the real store imported: `preview` and
 * `commitShown` would both just be "the document changed", with nothing saying
 * which one ran or how many history entries it cost.
 */
function harness(baseline: TimelineDocument) {
  let shown = baseline;
  const events: string[] = [];
  const frames: Array<() => void> = [];
  let now = 0;
  let locked = false;

  const ports: CaptionSessionPorts = {
    document: {
      read: () => shown,
      preview: (next) => {
        shown = next;
        events.push("preview");
      },
      commitShown: () => events.push("commit"),
      ensureBaseline: () => events.push("baseline"),
    },
    lock: {
      lock: () => {
        locked = true;
        events.push("lock");
      },
      unlock: () => {
        locked = false;
        events.push("unlock");
      },
    },
    scheduler: {
      request: (callback) => frames.push(callback),
      cancel: (handle) => {
        // `request` answers the new length, so the handle is a one-based index.
        frames[handle - 1] = () => {};
      },
    },
    now: () => now,
    mintId: counter("id"),
    // The real one snaps to the project's frame grid. A 10s clip and round
    // ranges make that a no-op here, and a fake keeps the suite free of
    // `renderOptionStore`.
    snap: (ms) => ms,
  };

  return {
    ports,
    events,
    get shown() {
      return shown;
    },
    get locked() {
      return locked;
    },
    get pendingFrames() {
      return frames.length;
    },
    /** Run every frame armed so far, at `now + dt`. */
    tick(dt = 0) {
      now += dt;
      const due = frames.splice(0, frames.length);
      for (const frame of due) {
        frame();
      }
    },
    /** Run frames until the reveal has had its whole duration. */
    settle(steps: number) {
      const duration = revealDurationMs(steps);
      for (let i = 0; i <= steps + 2; i += 1) {
        this.tick(Math.ceil(duration / Math.max(1, steps)) + 1);
      }
    },
  };
}

function start(h: ReturnType<typeof harness>, base: TimelineDocument) {
  const session = new CaptionSession(h.ports);
  session.start(oneClip(base, SILENCES));
  return session;
}

/**
 * The one clip every case below started from.
 *
 * Source ms. The clip sits at timeline 0 with no trim and no speed, so these
 * are the same numbers on either clock, which is what keeps the cases below
 * about the session rather than about `timing.ts`.
 */
function oneClip(base: TimelineDocument, sourceRanges: { startMs: number; endMs: number }[]) {
  return {
    lines: lines(),
    clips: [{ key: "clip", source: base.elements.clip, sourceRanges }],
    frame: FRAME,
    placement: "lowerThird" as const,
  };
}

/** Every cut the session will make, on any track. */
const allCuts = (session: CaptionSession) => [...session.cutsByTrack.values()].flat();

const SILENCES = [
  { startMs: 2500, endMs: 3000 },
  { startMs: 5500, endMs: 6000 },
];

/** What the panel sends on a change, with the toggle in one state or the other. */
const change = (lines: CaptionLine[], silenceOn: boolean) => ({
  lines,
  placement: "lowerThird" as const,
  ranges: [{ key: "clip", sourceRanges: silenceOn ? SILENCES : [] }],
});

const textClips = (d: TimelineDocument) =>
  Object.values(d.elements).filter((el) => el.filetype === "text");

const pieces = (d: TimelineDocument) => clipsOnTrack(d, "v1").length;

describe("starting", () => {
  it("records a baseline, then reads the document, then locks", () => {
    const base = doc();
    const h = harness(base);
    start(h, base);
    // The baseline entry and the document held here have to be the same state,
    // so the entry is recorded first and the read follows it.
    expect(h.events.slice(0, 2)).toEqual(["baseline", "lock"]);
    expect(h.locked).toBe(true);
  });

  it("records no undo step of its own, however many frames it takes", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    h.settle(5);
    expect(session.currentPhase).toBe("live");
    expect(h.events).not.toContain("commit");
  });
});

describe("the reveal", () => {
  it("lands the edit over several frames rather than in one write", () => {
    const base = doc();
    const h = harness(base);
    start(h, base);

    const afterFirst = textClips(h.shown).length;
    h.tick(10);
    h.tick(10);
    const partway = textClips(h.shown).length;
    h.settle(5);

    expect(afterFirst).toBeLessThan(textClips(h.shown).length);
    expect(partway).toBeLessThanOrEqual(textClips(h.shown).length);
    expect(textClips(h.shown)).toHaveLength(3);
  });

  it("ends with every caption placed and the silences cut", () => {
    const base = doc();
    const h = harness(base);
    start(h, base);
    h.settle(5);

    expect(textClips(h.shown)).toHaveLength(3);
    // Two cuts in the middle of one clip leave three pieces.
    expect(pieces(h.shown)).toBe(3);
  });

  it("arms no further frame once it is done", () => {
    const base = doc();
    const h = harness(base);
    start(h, base);
    h.settle(5);
    const before = h.pendingFrames;
    h.tick(100);
    expect(h.pendingFrames).toBe(before);
  });
});

describe("the silence toggle", () => {
  it("puts the footage back, and puts it back the way it was", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    h.settle(5);

    const cutPieces = pieces(h.shown);
    session.update(change(lines(), false));
    h.tick(16);
    expect(pieces(h.shown)).toBe(1);
    expect(textClips(h.shown)).toHaveLength(3);

    session.update(change(lines(), true));
    h.tick(16);
    expect(pieces(h.shown)).toBe(cutPieces);
  });

  it("reports the cuts it is making, and none once they are off", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    h.settle(5);

    expect(allCuts(session)).toHaveLength(2);
    session.update(change(lines(), false));
    expect(allCuts(session)).toHaveLength(0);
  });

  // Cutting everything would leave an emptied track and take every caption's
  // anchor with it. Refusing the cuts is recoverable by hand; that is not.
  it("refuses cuts that would take the whole clip, and says so", () => {
    const base = doc();
    const h = harness(base);
    const session = new CaptionSession(h.ports);
    session.start(oneClip(base, [{ startMs: 0, endMs: 10_000 }]));
    h.settle(4);

    expect(session.coveredClips).toEqual(["clip"]);
    expect(allCuts(session)).toHaveLength(0);
    expect(pieces(h.shown)).toBe(1);
    expect(textClips(h.shown)).toHaveLength(3);
  });
});

describe("editing", () => {
  it("shows a changed caption without recording an undo step", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    h.settle(5);

    const edited = setLineText(lines(), 0, "corrected");
    session.update(change(edited, true));
    h.tick(16);

    expect(
      textClips(h.shown).map((el) => (el as { text: string }).text),
    ).toContain("corrected");
    expect(h.events).not.toContain("commit");
  });

  // A rebuild is one pass over the captions and `placeNewElement` normalises
  // the document on each of them, so at typing speed one per key would be
  // measurable where one per frame is free.
  it("coalesces a burst of keystrokes into one write", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    h.settle(5);

    const before = h.events.filter((e) => e === "preview").length;
    for (const text of ["c", "co", "cor", "corr"]) {
      session.update(change(setLineText(lines(), 0, text), true));
    }
    h.tick(16);

    expect(h.events.filter((e) => e === "preview").length).toBe(before + 1);
  });

  it("ignores an edit once the session is over", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    h.settle(5);
    session.cancel();

    const before = h.events.length;
    session.update(change(lines(), true));
    h.tick(16);
    expect(h.events.length).toBe(before);
  });
});

describe("apply", () => {
  it("commits exactly one undo step, holding what is on screen", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    h.settle(5);
    session.apply();

    expect(h.events.filter((e) => e === "commit")).toHaveLength(1);
    expect(textClips(h.shown)).toHaveLength(3);
  });

  // Applying halfway would commit a document missing the captions that had not
  // landed yet, which is not a state the user chose or could see coming.
  it("finishes the reveal first when it is pressed early", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    session.apply();

    expect(textClips(h.shown)).toHaveLength(3);
    expect(pieces(h.shown)).toBe(3);
  });

  it("unlocks", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    h.settle(5);
    session.apply();
    expect(h.locked).toBe(false);
    expect(session.isLive).toBe(false);
  });
});

describe("cancel", () => {
  it("gives the project back exactly as it was", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    h.settle(5);
    session.cancel();

    expect(h.shown).toBe(base);
    expect(textClips(h.shown)).toHaveLength(0);
    expect(pieces(h.shown)).toBe(1);
  });

  it("records no undo step, so closing costs the user nothing", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    h.settle(5);
    session.cancel();
    expect(h.events).not.toContain("commit");
  });

  it("unlocks", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    session.cancel();
    expect(h.locked).toBe(false);
  });

  it("does nothing at all when there is no session", () => {
    const base = doc();
    const h = harness(base);
    const session = new CaptionSession(h.ports);
    session.cancel();
    expect(h.events).toEqual([]);
  });
});

// A lock outliving its session leaves the editor inert with no visible cause
// and nothing offering to release it. Both exits go through `finish`, and this
// is that pairing asserted rather than remembered.
describe("every way out unlocks", () => {
  for (const exit of ["apply", "cancel"] as const) {
    it(`unlocks after ${exit}, mid-reveal or not`, () => {
      for (const settle of [false, true]) {
        const base = doc();
        const h = harness(base);
        const session = start(h, base);
        if (settle) {
          h.settle(5);
        }
        session[exit]();
        expect(h.locked).toBe(false);
        expect(h.events.filter((e) => e === "lock")).toHaveLength(1);
        expect(h.events.filter((e) => e === "unlock")).toHaveLength(1);
      }
    });
  }

  // `Control` holds one session for the life of the app and restarts it each
  // time a transcript lands, so a second `start` on a live one is the ordinary
  // case: transcribe, close without applying, transcribe again.
  it("ends the run it is already in before beginning another", () => {
    const base = doc();
    const h = harness(base);
    const session = new CaptionSession(h.ports);
    const begin = () =>
      session.start(oneClip(base, [{ startMs: 2500, endMs: 3000 }]));

    begin();
    h.settle(4);
    begin();
    h.settle(4);

    expect(h.events.filter((e) => e === "unlock")).toHaveLength(1);
    expect(h.events.filter((e) => e === "lock")).toHaveLength(2);
    expect(h.locked).toBe(true);
    // The second run started from the project as it was, not from the first
    // run's output, so there is one set of captions rather than two.
    expect(textClips(h.shown)).toHaveLength(3);
    expect(pieces(h.shown)).toBe(2);
  });
});

describe("the two clocks", () => {
  it("maps a source moment onto the cut timeline, and back", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    h.settle(5);

    // 7s in the source is past both cuts, which remove a second between them.
    expect(session.timelineMsOf("clip", 7000)).toBe(6000);
    expect(session.sourcePositionsOf(6000)).toEqual([
      { key: "clip", seconds: expect.closeTo(7, 3) },
    ]);
  });

  it("is the identity once the cuts are switched off", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    h.settle(5);
    session.update(change(lines(), false));
    h.tick(16);

    expect(session.timelineMsOf("clip", 7000)).toBe(7000);
    expect(session.sourcePositionsOf(7000)).toEqual([
      { key: "clip", seconds: expect.closeTo(7, 3) },
    ]);
  });
});

describe("several clips", () => {
  const clip = (trackId: string, localpath: string, over: Record<string, unknown> = {}) =>
    videoElement({
      trackId,
      localpath,
      startTime: 0,
      duration: 10_000,
      trim: { startTime: 0, endTime: 10_000 },
      sourceDuration: 10_000,
      ...over,
    });

  /** X at 0-10s and Y at 10-20s on v1, and Z at 5-15s on v2. */
  function scene(extra: Record<string, ReturnType<typeof videoElement>> = {}) {
    return normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [
        createTrack("v1", "video", 0),
        createTrack("v2", "video", 1),
        createTrack("t1", "text", 2),
      ],
      elements: {
        x: clip("v1", "file:///x.mov"),
        y: clip("v1", "file:///y.mov", { startTime: 10_000 }),
        z: clip("v2", "file:///z.mov", { startTime: 5_000 }),
        ...extra,
      },
    });
  }

  const tagged = (key: string): CaptionLine[] =>
    linesFromWordGroups(
      [
        [{ word: `${key}-one`, start: 1, end: 2 }],
        [{ word: `${key}-two`, start: 7, end: 8 }],
      ],
      counter(`${key}-`),
    ).map((line) => ({ ...line, sourceKey: key }));

  type Ask = { key: string; sourceRanges: { startMs: number; endMs: number }[] };

  function begin(base: TimelineDocument, asks: Ask[], ls: CaptionLine[]) {
    const h = harness(base);
    const session = new CaptionSession(h.ports);
    session.start({
      lines: ls,
      clips: asks.map((ask) => ({ ...ask, source: base.elements[ask.key] })),
      frame: FRAME,
      placement: "lowerThird",
    });
    h.settle(8);
    return { h, session };
  }

  const on = (d: TimelineDocument, trackId: string) =>
    clipsOnTrack(d, trackId).map(([, el]) => ({
      file: (el as any).localpath,
      start: Math.round(el.startTime),
      from: Math.round((el as any).trim.startTime),
    }));

  const X_CUT = { startMs: 4_000, endMs: 5_000 };
  const Y_CUT = { startMs: 3_000, endMs: 4_000 };

  it("reveals every clip's captions and cuts", () => {
    const base = scene();
    const { h, session } = begin(
      base,
      [
        { key: "x", sourceRanges: [X_CUT] },
        { key: "y", sourceRanges: [Y_CUT] },
      ],
      [...tagged("x"), ...tagged("y")],
    );
    expect(session.currentPhase).toBe("live");
    expect(textClips(h.shown)).toHaveLength(4);
    expect(on(h.shown, "v1")).toEqual([
      { file: "file:///x.mov", start: 0, from: 0 },
      { file: "file:///x.mov", start: 4_000, from: 5_000 },
      { file: "file:///y.mov", start: 9_000, from: 0 },
      { file: "file:///y.mov", start: 12_000, from: 4_000 },
    ]);
  });

  it("reports the cuts per track, ascending, each clip's own", () => {
    const { session } = begin(
      scene(),
      [
        { key: "y", sourceRanges: [Y_CUT] },
        { key: "x", sourceRanges: [X_CUT] },
        { key: "z", sourceRanges: [{ startMs: 0, endMs: 500 }] },
      ],
      [],
    );
    expect(session.cutsByTrack.get("v1")).toEqual([
      { startMs: 4_000, endMs: 5_000 },
      { startMs: 13_000, endMs: 14_000 },
    ]);
    expect(session.cutsByTrack.get("v2")).toEqual([{ startMs: 5_000, endMs: 5_500 }]);
  });

  it("refuses only the clip whose ranges cover it whole", () => {
    const { h, session } = begin(
      scene(),
      [
        { key: "x", sourceRanges: [{ startMs: 0, endMs: 10_000 }] },
        { key: "y", sourceRanges: [Y_CUT] },
      ],
      [...tagged("x"), ...tagged("y")],
    );
    expect(session.coveredClips).toEqual(["x"]);
    expect(textClips(h.shown)).toHaveLength(4);
    expect(on(h.shown, "v1")).toEqual([
      { file: "file:///x.mov", start: 0, from: 0 },
      { file: "file:///y.mov", start: 10_000, from: 0 },
      { file: "file:///y.mov", start: 13_000, from: 4_000 },
    ]);
  });

  // Only the editing ops keep a track free of overlaps. A project can arrive
  // without it, and the ripple arithmetic is wrong for an overlap.
  it("refuses cuts to two chosen clips that overlap on one track, and still captions them", () => {
    const base = scene();
    const overlapping: TimelineDocument = {
      ...base,
      elements: {
        ...base.elements,
        y: { ...base.elements.y, startTime: 8_000 },
      },
    };
    const { h, session } = begin(
      overlapping,
      [
        { key: "x", sourceRanges: [X_CUT] },
        { key: "y", sourceRanges: [Y_CUT] },
        { key: "z", sourceRanges: [{ startMs: 0, endMs: 500 }] },
      ],
      [...tagged("x"), ...tagged("y")],
    );
    expect(session.refusedClips).toEqual([
      { key: "x", reason: "overlaps" },
      { key: "y", reason: "overlaps" },
    ]);
    expect(session.cutsByTrack.get("v1")).toBeUndefined();
    expect(session.cutsByTrack.get("v2")).toHaveLength(1);
    expect(textClips(h.shown)).toHaveLength(4);
  });

  it("refuses cuts to a clip that is not on a video or audio track", () => {
    const base = scene();
    const stray: TimelineDocument = {
      ...base,
      elements: { ...base.elements, x: { ...base.elements.x, trackId: "t1" } },
    };
    const { session } = begin(stray, [{ key: "x", sourceRanges: [X_CUT] }], tagged("x"));
    expect(session.refusedClips).toEqual([{ key: "x", reason: "noLane" }]);
    expect(allCuts(session)).toEqual([]);
  });

  it("holds a clip chosen twice once", () => {
    const { h, session } = begin(
      scene(),
      [
        { key: "x", sourceRanges: [X_CUT] },
        { key: "x", sourceRanges: [{ startMs: 6_000, endMs: 7_000 }] },
      ],
      tagged("x"),
    );
    expect(session.cutsByTrack.get("v1")).toEqual([X_CUT]);
    expect(textClips(h.shown)).toHaveLength(2);
  });

  it("drops a clip's cuts when an update leaves it out, and ignores a clip it does not hold", () => {
    const { h, session } = begin(
      scene(),
      [
        { key: "x", sourceRanges: [X_CUT] },
        { key: "y", sourceRanges: [Y_CUT] },
      ],
      [...tagged("x"), ...tagged("y")],
    );
    session.update({
      lines: [...tagged("x"), ...tagged("y")],
      placement: "lowerThird",
      ranges: [
        { key: "y", sourceRanges: [Y_CUT] },
        { key: "stranger", sourceRanges: [{ startMs: 0, endMs: 1_000 }] },
      ],
    });
    h.tick(16);
    expect(session.cutsByTrack.get("v1")).toEqual([{ startMs: 13_000, endMs: 14_000 }]);
    expect(on(h.shown, "v1").filter((p) => p.file === "file:///x.mov")).toHaveLength(1);
  });

  describe("the two clocks", () => {
    function live() {
      return begin(
        scene(),
        [
          { key: "x", sourceRanges: [X_CUT] },
          { key: "y", sourceRanges: [Y_CUT] },
          { key: "z", sourceRanges: [] },
        ],
        [...tagged("x"), ...tagged("y"), ...tagged("z")],
      ).session;
    }

    it("places Y's moments after what X lost", () => {
      const session = live();
      expect(session.timelineMsOf("x", 7_000)).toBe(6_000);
      // Y's 7s was at 17s; X lost 1s and Y its own 3-4s.
      expect(session.timelineMsOf("y", 7_000)).toBe(15_000);
      expect(session.timelineMsOf("stranger", 7_000)).toBeNull();
    });

    it("round-trips every word of both clips", () => {
      const session = live();
      for (const [key, seconds] of [
        ["x", 1],
        ["x", 7],
        ["y", 1],
        ["y", 7],
      ] as const) {
        const at = session.timelineMsOf(key, seconds * 1000)!;
        expect(session.sourcePositionsOf(at)).toContainEqual({
          key,
          seconds: expect.closeTo(seconds, 3),
        });
      }
    });

    it("answers both clips where two tracks play at once", () => {
      const session = live();
      // 5.5s: X (source 6.5s, past its cut) on v1, and Z (source 0.5s) on v2.
      expect(session.sourcePositionsOf(5_500)).toEqual([
        { key: "x", seconds: expect.closeTo(6.5, 3) },
        { key: "z", seconds: expect.closeTo(0.5, 3) },
      ]);
    });

    it("answers nothing in the gap after every clip", () => {
      expect(live().sourcePositionsOf(40_000)).toEqual([]);
    });
  });

  // A tail cut on X closes onto Y's first frame. The instant it resumes on is
  // Y's, not the last of X's.
  it("answers the next clip at the instant a tail cut resumes on", () => {
    const { session } = begin(
      scene(),
      [
        { key: "x", sourceRanges: [{ startMs: 9_000, endMs: 10_000 }] },
        { key: "y", sourceRanges: [] },
      ],
      [...tagged("x"), ...tagged("y")],
    );
    expect(session.sourcePositionsOf(9_000)).toEqual([
      { key: "y", seconds: expect.closeTo(0, 3) },
    ]);
  });

  it("answers the clip under the playhead for two clips cut from one file", () => {
    const base = scene({
      w: clip("v1", "file:///x.mov", {
        startTime: 20_000,
        trim: { startTime: 0, endTime: 10_000 },
      }),
    });
    const { session } = begin(
      base,
      [
        { key: "x", sourceRanges: [] },
        { key: "w", sourceRanges: [] },
      ],
      [...tagged("x"), ...tagged("w")],
    );
    expect(session.sourcePositionsOf(21_000)).toEqual([
      { key: "w", seconds: expect.closeTo(1, 3) },
    ]);
  });

  it("gives the project back exactly on cancel, and one step on apply", () => {
    const asks: Ask[] = [
      { key: "x", sourceRanges: [X_CUT] },
      { key: "z", sourceRanges: [{ startMs: 0, endMs: 500 }] },
    ];
    const base = scene();
    const cancelled = begin(base, asks, [...tagged("x"), ...tagged("z")]);
    cancelled.session.cancel();
    expect(cancelled.h.shown).toBe(base);

    const applied = begin(scene(), asks, [...tagged("x"), ...tagged("z")]);
    applied.session.apply();
    expect(applied.h.events.filter((e) => e === "commit")).toHaveLength(1);
    expect(applied.h.locked).toBe(false);
  });
});
