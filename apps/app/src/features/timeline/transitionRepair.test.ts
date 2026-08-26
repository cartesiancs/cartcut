/**
 * The claim this suite exists to prove: `clipOps.ts` is not modified, and every
 * op in it is transition-safe anyway.
 *
 * Each case drives a real editing operation — the same function the canvas
 * calls — and asserts what happened to a transition sitting on the cut. None of
 * those ops mentions transitions; `repairTransitions` inside `normalizeDocument`
 * is doing all of it.
 */

import { describe, it, expect } from "vitest";
import {
  deleteClips,
  moveClips,
  pasteClips,
  rippleDelete,
  splitClip,
  trimClipEnd,
  trimClipStart,
} from "./clipOps";
import { repairTransitions } from "./transitionRepair";
import { addTransition } from "./transitionOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { videoElement, imageElement } from "../renderer/testing";
import type { TransitionElementType } from "../../@types/timeline";

function clip(over: {
  trackId?: string;
  startTime: number;
  trimIn: number;
  trimOut: number;
  sourceDuration?: number;
}) {
  const {
    trackId = "v0",
    startTime,
    trimIn,
    trimOut,
    sourceDuration = 10_000,
  } = over;
  return videoElement({
    trackId,
    startTime,
    duration: trimOut - trimIn,
    trim: { startTime: trimIn, endTime: trimOut },
    sourceDuration,
  });
}

/** Two abutting clips with 2000ms of handle either side of the cut at 4000. */
function baseDoc(extraTracks: number = 0): TimelineDocument {
  const tracks = [createTrack("v0", "video", 0)];
  for (let i = 0; i < extraTracks; i++) {
    tracks.push(createTrack(`v${i + 1}`, "video", i + 1));
  }
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks,
    elements: {
      a: clip({ startTime: 0, trimIn: 2000, trimOut: 6000 }),
      b: clip({ startTime: 4000, trimIn: 2000, trimOut: 6000 }),
    },
  });
}

function withTransition(
  doc: TimelineDocument = baseDoc(),
  requestedMs = 800,
): TimelineDocument {
  return addTransition(doc, "t1", "a", "b", "cross", requestedMs, "center");
}

function transition(doc: TimelineDocument): TransitionElementType | null {
  const element = doc.elements.t1;
  return element != null && element.filetype === "transition" ? element : null;
}

describe("repairTransitions fast path", () => {
  it("returns the document by identity when nothing is a transition", () => {
    const doc = baseDoc();
    expect(repairTransitions(doc)).toBe(doc);
  });

  it("returns it by identity when every transition is still valid", () => {
    const doc = withTransition();
    expect(repairTransitions(doc)).toBe(doc);
  });
});

describe("deleteClips", () => {
  it("takes the transition with the clip it named", () => {
    const doc = withTransition();
    const next = deleteClips(doc, ["a"]);
    expect(next.elements.a).toBeUndefined();
    expect(transition(next)).toBeNull();
  });

  it("survives deleting an unrelated clip on another track", () => {
    const doc = withTransition(
      normalizeDocument({
        ...baseDoc(1),
        elements: {
          a: clip({ startTime: 0, trimIn: 2000, trimOut: 6000 }),
          b: clip({ startTime: 4000, trimIn: 2000, trimOut: 6000 }),
          other: imageElement({ trackId: "v1", startTime: 0, duration: 500 }),
        },
      }),
    );
    const next = deleteClips(doc, ["other"]);
    expect(transition(next)).not.toBeNull();
  });
});

describe("rippleDelete", () => {
  it("drops the transition when closing the gap separates its clips", () => {
    // Three clips; the transition sits on the a|b cut. Rippling `a` away pulls
    // `b` back to zero, so the cut the transition described no longer exists.
    const doc = addTransition(
      normalizeDocument({
        schemaVersion: SCHEMA_VERSION,
        tracks: [createTrack("v0", "video", 0)],
        elements: {
          a: clip({ startTime: 0, trimIn: 2000, trimOut: 6000 }),
          b: clip({ startTime: 4000, trimIn: 2000, trimOut: 6000 }),
          c: clip({ startTime: 8000, trimIn: 2000, trimOut: 6000 }),
        },
      }),
      "t1",
      "a",
      "b",
      "cross",
      800,
      "center",
    );

    const next = rippleDelete(doc, "a");
    expect(next.elements.a).toBeUndefined();
    expect(transition(next)).toBeNull();
  });
});

describe("moveClips", () => {
  it("drops the transition when one clip is dragged to another row", () => {
    const doc = withTransition(baseDoc(1));
    const next = moveClips(doc, ["b"], 0, 1);
    // The move must actually have happened, or this proves nothing.
    expect(next).not.toBe(doc);
    expect(next.elements.b.trackId).toBe("v1");
    expect(transition(next)).toBeNull();
  });

  it("drops the transition when a clip is dragged away in time", () => {
    const doc = withTransition();
    const next = moveClips(doc, ["b"], 2000);
    expect(next.elements.b.startTime).toBe(6000);
    expect(transition(next)).toBeNull();
  });

  it("follows the pair when both are moved together to another row", () => {
    const doc = withTransition(baseDoc(1));
    const next = moveClips(doc, ["a", "b"], 0, 1);
    const t = transition(next);
    expect(t).not.toBeNull();
    expect(t!.trackId).toBe("v1");
  });

  it("follows the pair when both are slid along in time", () => {
    const doc = withTransition();
    const next = moveClips(doc, ["a", "b"], 1000);
    const t = transition(next);
    expect(t).not.toBeNull();
    // The cut moved from 4000 to 5000; the window follows it.
    expect(t!.startTime).toBe(4600);
  });
});

describe("trimClipEnd / trimClipStart", () => {
  it("follows the cut when a trim moves it", () => {
    const doc = withTransition();
    // Pull `a`'s right edge in by 1000: the cut moves to 3000. `b` does not
    // move, so a gap opens and the transition should go.
    const next = trimClipEnd(doc, "a", -1000);
    expect(transition(next)).toBeNull();
  });

  it("re-fits when the pair stays adjacent through the trim", () => {
    // Trimming `b`'s left edge outwards moves the cut back and keeps them
    // touching, because `a`'s end and `b`'s start move together only if both
    // are edited. Here we trim `b`'s start out by 1000, which extends it left
    // into the space `a` occupies — the op clamps at the neighbour, so nothing
    // moves and the transition is untouched.
    const doc = withTransition();
    const next = trimClipStart(doc, "b", -1000);
    expect(next).toBe(doc);
  });

  it("drops it when a trim opens a gap at the cut", () => {
    // Worth pinning, because it is a real difference from Premiere. Trimming
    // here moves one clip's edge and leaves the other where it was, so a trim
    // under a transition genuinely destroys the cut rather than sliding it —
    // there is blank space between the clips afterwards. Dropping is the honest
    // outcome; the alternative would be a transition spanning a hole.
    const doc = withTransition();
    const next = trimClipStart(doc, "b", 2000);
    expect(next.elements.b.startTime).toBe(6000);
    expect(transition(next)).toBeNull();
  });
});

/**
 * Re-fitting a transition whose handles changed underneath it.
 *
 * No clip op reaches this state — every trim moves an edge and so destroys the
 * cut outright (above). It is reached by loading a project: a `.ngt` stores
 * paths, not media, so a source file that has been replaced with a shorter one
 * comes back with less handle than the stored transition was granted. Repair
 * runs on that load through `patchDocument`, and the transition must survive it
 * at a length the new media can actually supply.
 */
describe("re-fitting against changed handles", () => {
  /** The same edit, with `b`'s in-point moved without moving `b` itself. */
  function withHeadHandle(doc: TimelineDocument, headMs: number) {
    const b = doc.elements.b as ReturnType<typeof clip>;
    return {
      ...doc,
      elements: {
        ...doc.elements,
        b: {
          ...b,
          duration: b.trim.endTime - headMs,
          trim: { startTime: headMs, endTime: b.trim.endTime },
        },
      },
    };
  }

  it("shrinks to what the handles can now supply", () => {
    const doc = withTransition(baseDoc(), 4000);
    expect(transition(doc)!.duration).toBe(4000);

    // 200ms of head left, so a centred window can be at most 2 * 200.
    const next = repairTransitions(withHeadHandle(doc, 200));
    const t = transition(next);
    expect(t).not.toBeNull();
    expect(t!.duration).toBe(400);
    expect(t!.requestedDuration).toBe(4000);
  });

  it("drops it when the handles are gone entirely", () => {
    const doc = withTransition();
    const next = repairTransitions(withHeadHandle(doc, 0));
    expect(transition(next)).toBeNull();
  });
});

describe("splitClip", () => {
  it("drops the transition when a split puts a new clip between the pair", () => {
    const doc = withTransition();
    // Splitting `a` makes its right half the new neighbour of `b`, so the
    // transition's `fromId` no longer touches `toId`.
    const next = splitClip(doc, "a", 2000, "a2");
    expect(next.elements.a2).toBeDefined();
    expect(transition(next)).toBeNull();
  });

  it("keeps a transition whose own pair is untouched by the split", () => {
    const doc = addTransition(
      normalizeDocument({
        schemaVersion: SCHEMA_VERSION,
        tracks: [createTrack("v0", "video", 0)],
        elements: {
          a: clip({ startTime: 0, trimIn: 2000, trimOut: 6000 }),
          b: clip({ startTime: 4000, trimIn: 2000, trimOut: 6000 }),
          c: clip({ startTime: 8000, trimIn: 2000, trimOut: 6000 }),
        },
      }),
      "t1",
      "a",
      "b",
      "cross",
      800,
      "center",
    );
    const next = splitClip(doc, "c", 10_000, "c2");
    expect(next.elements.c2).toBeDefined();
    expect(transition(next)).not.toBeNull();
  });
});

describe("restoring a shrunk transition", () => {
  it("grows back to the requested length when the handles return", () => {
    const doc = withTransition(baseDoc(), 4000);
    const b = doc.elements.b as ReturnType<typeof clip>;
    const withHead = (headMs: number, source: TimelineDocument) => ({
      ...source,
      elements: {
        ...source.elements,
        b: {
          ...(source.elements.b as typeof b),
          duration: b.trim.endTime - headMs,
          trim: { startTime: headMs, endTime: b.trim.endTime },
        },
      },
    });

    const shrunk = repairTransitions(withHead(200, doc));
    expect(transition(shrunk)!.duration).toBe(400);

    // Give the head back. The length the user actually asked for returns with
    // it — without `requestedDuration` this would stay at 400 forever, shrunk
    // by a condition that no longer holds.
    const restored = repairTransitions(withHead(2000, shrunk));
    const t = transition(restored);
    expect(t!.duration).toBe(4000);
    expect(t!.requestedDuration).toBeUndefined();
    expect("requestedDuration" in t!).toBe(false);
  });
});

describe("pasteClips", () => {
  it("leaves an existing transition alone when a paste lands elsewhere", () => {
    const doc = withTransition();
    const next = pasteClips(
      doc,
      { pasted: imageElement({ trackId: "v0", startTime: 0, duration: 500 }) },
      20_000,
      () => "p1",
    );
    expect(transition(next)).not.toBeNull();
  });
});

describe("one transition per cut", () => {
  it("keeps the lowest id and drops the duplicate", () => {
    const base = withTransition();
    const t1 = base.elements.t1 as TransitionElementType;
    // Hand-build the state a duplicating paste or a hand-edited .ngt could
    // produce: two transitions naming the same pair.
    const doubled = repairTransitions({
      ...base,
      elements: { ...base.elements, t0: { ...t1 }, t2: { ...t1 } },
    });

    const survivors = Object.entries(doubled.elements)
      .filter(([, element]) => element.filetype === "transition")
      .map(([id]) => id);
    expect(survivors).toEqual(["t0"]);
  });
});

describe("document key order", () => {
  it("is preserved through a repair that changes something", () => {
    const base = withTransition(baseDoc(), 4000);
    const before = Object.keys(base.elements);

    const b = base.elements.b as ReturnType<typeof clip>;
    const shrunk = repairTransitions({
      ...base,
      elements: {
        ...base.elements,
        b: {
          ...b,
          duration: b.trim.endTime - 200,
          trim: { startTime: 200, endTime: b.trim.endTime },
        },
      },
    });

    expect(shrunk).not.toBe(base);
    expect(Object.keys(shrunk.elements)).toEqual(before);
  });
});
