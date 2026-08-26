import { describe, it, expect } from "vitest";
import {
  addTransition,
  cutPointsOn,
  removeTransition,
  setTransitionAlignment,
  setTransitionDuration,
  setTransitionParams,
  setTransitionPreset,
  transitionAtCut,
  transitionsOnTrack,
} from "./transitionOps";
import { MIN_TRANSITION_MS } from "./transitionGeometry";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { findCollisions, freeGaps } from "./overlap";
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

/** Two abutting video clips with 2000ms of handle on either side of the cut. */
function twoClipDoc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      a: clip({ startTime: 0, trimIn: 2000, trimOut: 6000 }),
      b: clip({ startTime: 4000, trimIn: 2000, trimOut: 6000 }),
    },
  });
}

function transitionOf(
  doc: TimelineDocument,
  id: string,
): TransitionElementType {
  const element = doc.elements[id];
  if (element == null || element.filetype !== "transition") {
    throw new Error(`${id} is not a transition`);
  }
  return element;
}

describe("addTransition", () => {
  it("lays a window over the cut without moving either clip", () => {
    const doc = twoClipDoc();
    const next = addTransition(
      doc,
      "t1",
      "a",
      "b",
      "cross-dissolve",
      800,
      "center",
    );

    const t = transitionOf(next, "t1");
    expect(t.startTime).toBe(3600);
    expect(t.duration).toBe(800);
    expect(t.fromId).toBe("a");
    expect(t.toId).toBe("b");
    expect(t.trackId).toBe("v0");

    // The whole point: neither clip is touched.
    expect(next.elements.a.startTime).toBe(doc.elements.a.startTime);
    expect(next.elements.b.startTime).toBe(doc.elements.b.startTime);
    expect((next.elements.a as any).trim).toEqual(
      (doc.elements.a as any).trim,
    );
    expect((next.elements.b as any).trim).toEqual(
      (doc.elements.b as any).trim,
    );
  });

  it("does not occupy the track, so the clips still fit around it", () => {
    const doc = addTransition(
      twoClipDoc(),
      "t1",
      "a",
      "b",
      "cross-dissolve",
      800,
      "center",
    );

    // The transition spans 3600..4400, straddling both clips. If it counted as
    // an occupant, every one of these would report a collision.
    expect(findCollisions(doc, "v0", { start: 3600, end: 4400 }, ["a", "b"]))
      .toEqual([]);
    // And the track still reads as fully occupied 0..8000 by the two clips.
    expect(freeGaps(doc, "v0")).toEqual([{ start: 8000, end: Infinity }]);
  });

  it("shrinks to the available handles and records what was asked for", () => {
    const doc = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: {
        // 400ms of tail, 400ms of head.
        a: clip({
          startTime: 0,
          trimIn: 0,
          trimOut: 4000,
          sourceDuration: 4400,
        }),
        b: clip({ startTime: 4000, trimIn: 400, trimOut: 4400 }),
      },
    });

    const next = addTransition(doc, "t1", "a", "b", "cross", 2000, "center");
    const t = transitionOf(next, "t1");
    expect(t.duration).toBe(800);
    expect(t.requestedDuration).toBe(2000);
  });

  it("omits requestedDuration when the request was granted in full", () => {
    const next = addTransition(
      twoClipDoc(),
      "t1",
      "a",
      "b",
      "cross",
      800,
      "center",
    );
    expect(transitionOf(next, "t1").requestedDuration).toBeUndefined();
    // And it must not be a present-but-undefined key, which JSON.stringify
    // drops — a saved project would then differ from the one in memory.
    expect("requestedDuration" in transitionOf(next, "t1")).toBe(false);
  });

  describe("declines by identity", () => {
    it("when a clip is missing", () => {
      const doc = twoClipDoc();
      expect(addTransition(doc, "t1", "a", "nope", "x", 800, "center")).toBe(
        doc,
      );
    });

    it("when both ids are the same clip", () => {
      const doc = twoClipDoc();
      expect(addTransition(doc, "t1", "a", "a", "x", 800, "center")).toBe(doc);
    });

    it("when the clips are on different tracks", () => {
      const doc = normalizeDocument({
        schemaVersion: SCHEMA_VERSION,
        tracks: [createTrack("v0", "video", 0), createTrack("v1", "video", 1)],
        elements: {
          a: clip({ trackId: "v0", startTime: 0, trimIn: 2000, trimOut: 6000 }),
          b: clip({
            trackId: "v1",
            startTime: 4000,
            trimIn: 2000,
            trimOut: 6000,
          }),
        },
      });
      expect(addTransition(doc, "t1", "a", "b", "x", 800, "center")).toBe(doc);
    });

    it("when there is a gap between them", () => {
      const doc = normalizeDocument({
        schemaVersion: SCHEMA_VERSION,
        tracks: [createTrack("v0", "video", 0)],
        elements: {
          a: clip({ startTime: 0, trimIn: 2000, trimOut: 6000 }),
          b: clip({ startTime: 5000, trimIn: 2000, trimOut: 6000 }),
        },
      });
      expect(addTransition(doc, "t1", "a", "b", "x", 800, "center")).toBe(doc);
    });

    it("when that cut already carries one", () => {
      const once = addTransition(
        twoClipDoc(),
        "t1",
        "a",
        "b",
        "x",
        800,
        "center",
      );
      expect(addTransition(once, "t2", "a", "b", "y", 800, "center")).toBe(
        once,
      );
    });

    it("when neither side has any handle at all", () => {
      const doc = normalizeDocument({
        schemaVersion: SCHEMA_VERSION,
        tracks: [createTrack("v0", "video", 0)],
        elements: {
          a: clip({
            startTime: 0,
            trimIn: 0,
            trimOut: 4000,
            sourceDuration: 4000,
          }),
          b: clip({
            startTime: 4000,
            trimIn: 0,
            trimOut: 4000,
            sourceDuration: 4000,
          }),
        },
      });
      expect(addTransition(doc, "t1", "a", "b", "x", 800, "center")).toBe(doc);
    });

    it("when the id is already taken", () => {
      const doc = twoClipDoc();
      expect(addTransition(doc, "a", "a", "b", "x", 800, "center")).toBe(doc);
    });
  });
});

describe("setTransitionDuration", () => {
  it("re-lengths and re-centres in one step", () => {
    const doc = addTransition(
      twoClipDoc(),
      "t1",
      "a",
      "b",
      "x",
      800,
      "center",
    );
    const next = setTransitionDuration(doc, "t1", 1200);
    const t = transitionOf(next, "t1");
    expect(t.duration).toBe(1200);
    expect(t.startTime).toBe(3400);
  });

  it("clamps to the handles but remembers the ask", () => {
    const doc = addTransition(
      twoClipDoc(),
      "t1",
      "a",
      "b",
      "x",
      800,
      "center",
    );
    // Handles allow 4000 at most (2000 each side).
    const next = setTransitionDuration(doc, "t1", 9000);
    const t = transitionOf(next, "t1");
    expect(t.duration).toBe(4000);
    expect(t.requestedDuration).toBe(9000);
  });

  it("declines when the length is unchanged", () => {
    const doc = addTransition(
      twoClipDoc(),
      "t1",
      "a",
      "b",
      "x",
      800,
      "center",
    );
    expect(setTransitionDuration(doc, "t1", 800)).toBe(doc);
  });

  it("declines on a non-transition id", () => {
    const doc = twoClipDoc();
    expect(setTransitionDuration(doc, "a", 800)).toBe(doc);
  });
});

describe("setTransitionAlignment", () => {
  it("re-anchors a transition the centre could not support", () => {
    // `a` is trimmed to the last frame of its source: no tail whatsoever.
    const doc = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: {
        a: clip({
          startTime: 0,
          trimIn: 0,
          trimOut: 4000,
          sourceDuration: 4000,
        }),
        b: clip({ startTime: 4000, trimIn: 3000, trimOut: 7000 }),
      },
    });

    // Centre is impossible; end-aligned works off `b`'s 3000ms head.
    expect(addTransition(doc, "t1", "a", "b", "x", 800, "center")).toBe(doc);

    const placed = addTransition(doc, "t1", "a", "b", "x", 800, "end");
    const t = transitionOf(placed, "t1");
    expect(t.duration).toBe(800);
    expect(t.startTime).toBe(3200);
    expect(t.alignment).toBe("end");
  });

  it("re-resolves the length against the new alignment", () => {
    const doc = addTransition(twoClipDoc(), "t1", "a", "b", "x", 800, "center");
    const next = setTransitionAlignment(doc, "t1", "start");
    const t = transitionOf(next, "t1");
    expect(t.alignment).toBe("start");
    expect(t.startTime).toBe(4000);
  });

  it("declines when the alignment is unchanged", () => {
    const doc = addTransition(twoClipDoc(), "t1", "a", "b", "x", 800, "center");
    expect(setTransitionAlignment(doc, "t1", "center")).toBe(doc);
  });
});

describe("setTransitionPreset", () => {
  it("replaces the parameters wholesale rather than merging them", () => {
    const doc = addTransition(
      twoClipDoc(),
      "t1",
      "a",
      "b",
      "cross",
      800,
      "center",
      { softness: 5 },
    );
    const next = setTransitionPreset(doc, "t1", "wipe", { direction: 1 });
    const t = transitionOf(next, "t1");
    expect(t.presetId).toBe("wipe");
    // Carrying `softness` across would reinterpret it under a key the new
    // preset never declared — the failure `filterOps.ts` documents.
    expect(t.params).toEqual({ direction: 1 });
  });

  it("declines when the preset is already selected", () => {
    const doc = addTransition(twoClipDoc(), "t1", "a", "b", "cross", 800, "center");
    expect(setTransitionPreset(doc, "t1", "cross", {})).toBe(doc);
  });
});

describe("setTransitionParams", () => {
  it("patches only the named keys", () => {
    const doc = addTransition(
      twoClipDoc(),
      "t1",
      "a",
      "b",
      "wipe",
      800,
      "center",
      { direction: 0, softness: 5 },
    );
    const next = setTransitionParams(doc, "t1", { softness: 20 });
    expect(transitionOf(next, "t1").params).toEqual({
      direction: 0,
      softness: 20,
    });
  });

  it("declines when every value already matches", () => {
    const doc = addTransition(
      twoClipDoc(),
      "t1",
      "a",
      "b",
      "wipe",
      800,
      "center",
      { direction: 0 },
    );
    expect(setTransitionParams(doc, "t1", { direction: 0 })).toBe(doc);
    expect(setTransitionParams(doc, "t1", {})).toBe(doc);
  });
});

describe("removeTransition", () => {
  it("takes the transition and leaves the edit exactly as it was", () => {
    const before = twoClipDoc();
    const withT = addTransition(before, "t1", "a", "b", "x", 800, "center");
    const after = removeTransition(withT, "t1");

    expect(after.elements.t1).toBeUndefined();
    expect(after.elements.a).toEqual(before.elements.a);
    expect(after.elements.b).toEqual(before.elements.b);
  });

  it("declines on an id that is not a transition", () => {
    const doc = twoClipDoc();
    expect(removeTransition(doc, "a")).toBe(doc);
    expect(removeTransition(doc, "nope")).toBe(doc);
  });
});

describe("cutPointsOn", () => {
  it("finds the cut and reports it as bare until a transition lands", () => {
    const doc = twoClipDoc();
    expect(cutPointsOn(doc, "v0")).toEqual([
      { fromId: "a", toId: "b", atMs: 4000, transitionId: null },
    ]);

    const withT = addTransition(doc, "t1", "a", "b", "x", 800, "center");
    expect(cutPointsOn(withT, "v0")).toEqual([
      { fromId: "a", toId: "b", atMs: 4000, transitionId: "t1" },
    ]);
  });

  it("does not invent cuts on either side of a transition badge", () => {
    // The transition sits between the two clips in time order. Counting it as
    // a clip would report three "cuts" on a track that has one.
    const withT = addTransition(
      twoClipDoc(),
      "t1",
      "a",
      "b",
      "x",
      800,
      "center",
    );
    expect(cutPointsOn(withT, "v0")).toHaveLength(1);
  });

  it("skips a gap", () => {
    const doc = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: {
        a: clip({ startTime: 0, trimIn: 0, trimOut: 2000 }),
        b: clip({ startTime: 3000, trimIn: 0, trimOut: 2000 }),
      },
    });
    expect(cutPointsOn(doc, "v0")).toEqual([]);
  });

  it("finds every cut in a run of three", () => {
    const doc = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: {
        a: imageElement({ trackId: "v0", startTime: 0, duration: 1000 }),
        b: imageElement({ trackId: "v0", startTime: 1000, duration: 1000 }),
        c: imageElement({ trackId: "v0", startTime: 2000, duration: 1000 }),
      },
    });
    expect(cutPointsOn(doc, "v0").map((cut) => cut.atMs)).toEqual([1000, 2000]);
  });
});

describe("transitionsOnTrack / transitionAtCut", () => {
  it("lists what is there", () => {
    const doc = addTransition(twoClipDoc(), "t1", "a", "b", "x", 800, "center");
    expect(transitionsOnTrack(doc, "v0").map(([id]) => id)).toEqual(["t1"]);
    expect(transitionAtCut(doc, "a", "b")).toBe("t1");
    expect(transitionAtCut(doc, "b", "a")).toBeNull();
  });
});

describe("MIN_TRANSITION_MS", () => {
  it("is the floor a granted transition never falls below", () => {
    const doc = addTransition(twoClipDoc(), "t1", "a", "b", "x", 1, "center");
    expect(transitionOf(doc, "t1").duration).toBe(MIN_TRANSITION_MS);
  });
});
