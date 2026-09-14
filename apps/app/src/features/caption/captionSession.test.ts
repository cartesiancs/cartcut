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
  session.start({
    lines: lines(),
    sourceKey: "clip",
    source: base.elements.clip,
    frame: FRAME,
    placement: "lowerThird",
    // Source ms. The clip sits at timeline 0 with no trim and no speed, so
    // these are the same numbers on either clock, which is what keeps the
    // cases below about the session rather than about `timing.ts`.
    sourceRanges: SILENCES,
  });
  return session;
}

const SILENCES = [
  { startMs: 2500, endMs: 3000 },
  { startMs: 5500, endMs: 6000 },
];

/** What the panel sends on a change, with the toggle in one state or the other. */
const change = (lines: CaptionLine[], silenceOn: boolean) => ({
  lines,
  placement: "lowerThird" as const,
  sourceRanges: silenceOn ? SILENCES : [],
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

    expect(session.cuts).toHaveLength(2);
    session.update(change(lines(), false));
    expect(session.cuts).toHaveLength(0);
  });

  // Cutting everything would leave an emptied track and take every caption's
  // anchor with it. Refusing the cuts is recoverable by hand; that is not.
  it("refuses cuts that would take the whole clip, and says so", () => {
    const base = doc();
    const h = harness(base);
    const session = new CaptionSession(h.ports);
    session.start({
      lines: lines(),
      sourceKey: "clip",
      source: base.elements.clip,
      frame: FRAME,
      placement: "lowerThird",
      sourceRanges: [{ startMs: 0, endMs: 10_000 }],
    });
    h.settle(4);

    expect(session.coversWholeClip).toBe(true);
    expect(session.cuts).toHaveLength(0);
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
      session.start({
        lines: lines(),
        sourceKey: "clip",
        source: base.elements.clip,
        frame: FRAME,
        placement: "lowerThird",
        sourceRanges: [{ startMs: 2500, endMs: 3000 }],
      });

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
    expect(session.timelineMsOf(7000)).toBe(6000);
    expect(session.sourceSecondsOf(6000)).toBeCloseTo(7, 3);
  });

  it("is the identity once the cuts are switched off", () => {
    const base = doc();
    const h = harness(base);
    const session = start(h, base);
    h.settle(5);
    session.update(change(lines(), false));
    h.tick(16);

    expect(session.timelineMsOf(7000)).toBe(7000);
    expect(session.sourceSecondsOf(7000)).toBeCloseTo(7, 3);
  });
});
