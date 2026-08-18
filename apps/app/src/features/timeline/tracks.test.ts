import { describe, it, expect } from "vitest";
import {
  SCHEMA_VERSION,
  appendTrackOfKind,
  clipsOnTrack,
  createTrack,
  defaultTrackKindFor,
  derivePriorities,
  emptyDocument,
  insertTrackAt,
  moveTrack,
  nameTracks,
  normalizeDocument,
  normalizeTrackIndices,
  paintOrder,
  removeTrack,
  trackById,
  trackIndexOf,
  tracksOfKind,
  type TimelineDocument,
  type TrackKind,
} from "./tracks";
import { audioElement, imageElement, textElement, videoElement } from "../renderer/testing";

/** A document with `kinds.length` tracks, top row first. */
function docWithTracks(...kinds: TrackKind[]): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: kinds.map((kind, index) => createTrack(`t${index}`, kind, index)),
    elements: {},
  });
}

function withClips(
  doc: TimelineDocument,
  clips: Record<string, any>,
): TimelineDocument {
  return normalizeDocument({ ...doc, elements: clips });
}

describe("defaultTrackKindFor", () => {
  it("routes each element type to its natural track", () => {
    expect(defaultTrackKindFor("video")).toBe("video");
    expect(defaultTrackKindFor("audio")).toBe("audio");
    expect(defaultTrackKindFor("text")).toBe("text");
  });

  it("puts stills, GIFs and shapes on video tracks, as every NLE does", () => {
    expect(defaultTrackKindFor("image")).toBe("video");
    expect(defaultTrackKindFor("gif")).toBe("video");
    expect(defaultTrackKindFor("shape")).toBe("video");
  });
});

describe("normalizeTrackIndices", () => {
  it("closes gaps left by a removal", () => {
    const tracks = [
      createTrack("a", "video", 0),
      createTrack("b", "video", 5),
      createTrack("c", "audio", 9),
    ];
    expect(normalizeTrackIndices(tracks).map((t) => t.index)).toEqual([0, 1, 2]);
  });

  it("preserves relative order while renumbering", () => {
    const tracks = [
      createTrack("c", "audio", 9),
      createTrack("a", "video", 0),
      createTrack("b", "video", 5),
    ];
    expect(normalizeTrackIndices(tracks).map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("does not mutate its input", () => {
    const tracks = [createTrack("a", "video", 3)];
    normalizeTrackIndices(tracks);
    expect(tracks[0].index).toBe(3);
  });
});

describe("nameTracks", () => {
  it("numbers each kind from the bottom up", () => {
    // V1 is the bottom video row, so the higher number is the front-most —
    // the convention Premiere and Final Cut share.
    const named = nameTracks([
      createTrack("top", "video", 0),
      createTrack("mid", "video", 1),
      createTrack("bottom", "video", 2),
    ]);
    expect(named.map((t) => t.name)).toEqual(["V3", "V2", "V1"]);
  });

  it("counts kinds independently", () => {
    const named = nameTracks([
      createTrack("t", "text", 0),
      createTrack("v2", "video", 1),
      createTrack("v1", "video", 2),
      createTrack("a", "audio", 3),
    ]);
    expect(named.map((t) => t.name)).toEqual(["T1", "V2", "V1", "A1"]);
  });
});

describe("paintOrder", () => {
  it("paints the bottom row first so the top row lands in front", () => {
    // This is the inversion the whole z-order model rests on.
    const doc = withClips(docWithTracks("video", "video"), {
      front: imageElement({ trackId: "t0" }),
      back: imageElement({ trackId: "t1" }),
    });
    expect(paintOrder(doc)).toEqual(["back", "front"]);
  });

  it("orders clips on one track by time", () => {
    const doc = withClips(docWithTracks("video"), {
      late: imageElement({ trackId: "t0", startTime: 5000 }),
      early: imageElement({ trackId: "t0", startTime: 0 }),
    });
    expect(paintOrder(doc)).toEqual(["early", "late"]);
  });

  it("breaks ties deterministically rather than by object key order", () => {
    const doc = withClips(docWithTracks("video"), {
      b: imageElement({ trackId: "t0", startTime: 0 }),
      a: imageElement({ trackId: "t0", startTime: 0 }),
    });
    expect(paintOrder(doc)).toEqual(["a", "b"]);
  });

  it("sorts an orphaned clip to the very back instead of dropping it", () => {
    const doc = withClips(docWithTracks("video"), {
      onTrack: imageElement({ trackId: "t0" }),
      orphan: imageElement({ trackId: "gone" }),
    });
    expect(paintOrder(doc)).toEqual(["orphan", "onTrack"]);
  });

  it("is empty for an empty document", () => {
    expect(paintOrder(emptyDocument())).toEqual([]);
  });
});

describe("derivePriorities", () => {
  it("numbers from 1 in paint order, so low priority is behind", () => {
    // The renderer sorts ascending and paints in that order; this keeps that
    // contract intact while the row model changes underneath it.
    const doc = withClips(docWithTracks("video", "video"), {
      front: imageElement({ trackId: "t0" }),
      back: imageElement({ trackId: "t1" }),
    });
    const elements = derivePriorities(doc);
    expect(elements.back.priority).toBe(1);
    expect(elements.front.priority).toBe(2);
  });

  it("emits keys in paint order, which renderMain's for..in relies on", () => {
    const doc = withClips(docWithTracks("video", "video"), {
      front: imageElement({ trackId: "t0" }),
      back: imageElement({ trackId: "t1" }),
    });
    expect(Object.keys(derivePriorities(doc))).toEqual(["back", "front"]);
  });

  it("is stable across repeated application", () => {
    const doc = withClips(docWithTracks("video", "text"), {
      a: imageElement({ trackId: "t1" }),
      b: textElement({ trackId: "t0" }),
    });
    const once = derivePriorities(doc);
    const twice = derivePriorities({ ...doc, elements: once });
    expect(twice).toEqual(once);
  });

  it("keeps every element", () => {
    const doc = withClips(docWithTracks("video"), {
      a: imageElement({ trackId: "t0", startTime: 0 }),
      b: imageElement({ trackId: "t0", startTime: 1000 }),
      c: imageElement({ trackId: "t0", startTime: 2000 }),
    });
    expect(Object.keys(derivePriorities(doc)).sort()).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the elements it is given", () => {
    const doc = withClips(docWithTracks("video"), {
      a: imageElement({ trackId: "t0", priority: 99 }),
    });
    const before = doc.elements.a;
    derivePriorities(doc);
    expect(before).toBe(doc.elements.a);
  });
});

describe("clipsOnTrack", () => {
  it("returns only that track's clips, in time order", () => {
    // The headline capability: one track, many clips.
    const doc = withClips(docWithTracks("text", "video"), {
      c3: textElement({ trackId: "t0", startTime: 3000 }),
      c1: textElement({ trackId: "t0", startTime: 1000 }),
      c2: textElement({ trackId: "t0", startTime: 2000 }),
      other: videoElement({ trackId: "t1" }),
    });
    expect(clipsOnTrack(doc, "t0").map(([id]) => id)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
  });

  it("is empty for a track with nothing on it", () => {
    expect(clipsOnTrack(docWithTracks("video"), "t0")).toEqual([]);
  });
});

describe("trackById / trackIndexOf / tracksOfKind", () => {
  it("finds a track and reports its row", () => {
    const doc = docWithTracks("video", "audio");
    expect(trackById(doc, "t1")?.kind).toBe("audio");
    expect(trackIndexOf(doc, "t1")).toBe(1);
  });

  it("reports a missing track as furthest back rather than as row 0", () => {
    // Row 0 is the front, so defaulting there would put orphans on top.
    expect(trackIndexOf(docWithTracks("video"), "nope")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(trackById(docWithTracks("video"), "nope")).toBeNull();
  });

  it("filters by kind", () => {
    const doc = docWithTracks("video", "text", "video");
    expect(tracksOfKind(doc, "video").map((t) => t.id)).toEqual(["t0", "t2"]);
  });
});

describe("insertTrackAt", () => {
  it("pushes existing rows down", () => {
    const doc = insertTrackAt(docWithTracks("video", "audio"), 0, "text", "new");
    expect(doc.tracks.map((t) => t.id)).toEqual(["new", "t0", "t1"]);
    expect(doc.tracks.map((t) => t.index)).toEqual([0, 1, 2]);
  });

  it("appends when the index is past the end", () => {
    const doc = insertTrackAt(docWithTracks("video"), 99, "audio", "new");
    expect(doc.tracks.map((t) => t.id)).toEqual(["t0", "new"]);
  });

  it("clamps a negative index to the top", () => {
    const doc = insertTrackAt(docWithTracks("video"), -5, "video", "new");
    expect(doc.tracks[0].id).toBe("new");
  });

  it("renames and re-derives priorities in one pass", () => {
    const base = withClips(docWithTracks("video"), {
      a: imageElement({ trackId: "t0" }),
    });
    const doc = insertTrackAt(base, 0, "video", "new");
    expect(doc.tracks.map((t) => t.name)).toEqual(["V2", "V1"]);
    expect(doc.elements.a.priority).toBe(1);
  });
});

describe("appendTrackOfKind", () => {
  it("adds the new track directly above the topmost of its kind", () => {
    // Adding V2 to a stack that already has V1 should not bury it under audio.
    const doc = appendTrackOfKind(docWithTracks("video", "audio"), "video", "v2");
    expect(doc.tracks.map((t) => t.id)).toEqual(["v2", "t0", "t1"]);
  });

  it("appends at the bottom when the kind is new to the document", () => {
    const doc = appendTrackOfKind(docWithTracks("video"), "audio", "a1");
    expect(doc.tracks.map((t) => t.id)).toEqual(["t0", "a1"]);
  });

  it("starts a document off with a single track", () => {
    const doc = appendTrackOfKind(emptyDocument(), "video", "v1");
    expect(doc.tracks).toHaveLength(1);
    expect(doc.tracks[0]).toMatchObject({ index: 0, name: "V1" });
  });
});

describe("removeTrack", () => {
  it("refuses to take clips with it by default", () => {
    const doc = withClips(docWithTracks("video", "audio"), {
      a: imageElement({ trackId: "t0" }),
    });
    expect(removeTrack(doc, "t0")).toBe(doc);
  });

  it("removes an empty track and closes the gap", () => {
    const doc = removeTrack(docWithTracks("video", "audio", "text"), "t1");
    expect(doc.tracks.map((t) => t.id)).toEqual(["t0", "t2"]);
    expect(doc.tracks.map((t) => t.index)).toEqual([0, 1]);
  });

  it("drops the clips too when explicitly asked", () => {
    const doc = withClips(docWithTracks("video", "audio"), {
      a: imageElement({ trackId: "t0" }),
      b: audioElement({ trackId: "t1" }),
    });
    const next = removeTrack(doc, "t0", "delete-clips");
    expect(Object.keys(next.elements)).toEqual(["b"]);
  });

  it("is a no-op for a track that is not there", () => {
    const doc = docWithTracks("video");
    expect(removeTrack(doc, "nope")).toBe(doc);
  });

  it("re-derives priorities for the survivors", () => {
    const doc = withClips(docWithTracks("video", "video"), {
      a: imageElement({ trackId: "t0" }),
      b: imageElement({ trackId: "t1" }),
    });
    const next = removeTrack(doc, "t0", "delete-clips");
    expect(next.elements.b.priority).toBe(1);
  });
});

describe("moveTrack", () => {
  it("moves a row down and slides the rows it passes", () => {
    const doc = moveTrack(docWithTracks("video", "audio", "text"), "t0", 2);
    expect(doc.tracks.map((t) => t.id)).toEqual(["t1", "t2", "t0"]);
  });

  it("moves a row up", () => {
    const doc = moveTrack(docWithTracks("video", "audio", "text"), "t2", 0);
    expect(doc.tracks.map((t) => t.id)).toEqual(["t2", "t0", "t1"]);
  });

  it("changes z-order, since the row is the z-order", () => {
    const base = withClips(docWithTracks("video", "video"), {
      a: imageElement({ trackId: "t0" }),
      b: imageElement({ trackId: "t1" }),
    });
    expect(paintOrder(base)).toEqual(["b", "a"]);
    expect(paintOrder(moveTrack(base, "t0", 1))).toEqual(["a", "b"]);
  });

  it("clamps past either end instead of losing the track", () => {
    const doc = docWithTracks("video", "audio");
    expect(moveTrack(doc, "t0", 99).tracks.map((t) => t.id)).toEqual([
      "t1",
      "t0",
    ]);
    expect(moveTrack(doc, "t1", -99).tracks.map((t) => t.id)).toEqual([
      "t1",
      "t0",
    ]);
  });

  it("is a no-op when the row does not change", () => {
    const doc = docWithTracks("video", "audio");
    expect(moveTrack(doc, "t0", 0)).toBe(doc);
    expect(moveTrack(doc, "nope", 1)).toBe(doc);
  });
});
