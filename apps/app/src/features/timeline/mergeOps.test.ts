import { describe, it, expect } from "vitest";
import { canMergeClips, mergeClips } from "./mergeOps";
import { splitClip } from "./clipOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { assertTrimInvariant, spanOf } from "./geometry";
import { textElement, videoElement } from "../renderer/testing";

function doc(
  tracks: Array<[string, "video" | "audio" | "text"]>,
  elements: Record<string, any> = {},
): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: tracks.map(([id, kind], index) => createTrack(id, kind, index)),
    elements,
  });
}

/** One 4s video on one track, as it stands before any cut. */
function oneClip(over: Record<string, any> = {}) {
  return doc(
    [["track-1", "video"]],
    { a: videoElement({ trackId: "track-1", ...over }) },
  );
}

describe("mergeClips — the split round trip", () => {
  it("puts a cut clip back exactly as it was", () => {
    const before = oneClip();
    const split = splitClip(before, "a", 1500, "b");
    expect(Object.keys(split.elements)).toHaveLength(2);

    const after = mergeClips(split, ["a", "b"]);

    expect(Object.keys(after.elements)).toEqual(["a"]);
    expect(spanOf(after.elements.a)).toEqual(spanOf(before.elements.a));
    expect(after.elements.a.trim).toEqual(before.elements.a.trim);
    expect(after.elements.a.duration).toBe(before.elements.a.duration);
  });

  it("survives the round trip on a sped-up clip, where spans are fractional", () => {
    const before = oneClip({ speed: 1.5 });
    const split = splitClip(before, "a", 1234, "b");

    const after = mergeClips(split, ["a", "b"]);

    expect(Object.keys(after.elements)).toEqual(["a"]);
    expect(after.elements.a.trim).toEqual(before.elements.a.trim);
    assertTrimInvariant(after.elements.a);
  });

  it("collapses a chain of three, in whatever order they are named", () => {
    let next = oneClip();
    next = splitClip(next, "a", 1000, "b");
    next = splitClip(next, "b", 2000, "c");
    expect(Object.keys(next.elements)).toHaveLength(3);

    const after = mergeClips(next, ["c", "a", "b"]);

    expect(Object.keys(after.elements)).toEqual(["a"]);
    expect(after.elements.a.trim).toEqual({ startTime: 0, endTime: 4000 });
  });

  it("keeps the leftmost id, so references to it stay valid", () => {
    const split = splitClip(oneClip(), "a", 1500, "b");

    const after = mergeClips(split, ["a", "b"]);

    expect(after.elements.a).toBeDefined();
    expect(after.elements.b).toBeUndefined();
  });

  it("holds duration === trim.endTime - trim.startTime", () => {
    const split = splitClip(oneClip(), "a", 900, "b");

    const after = mergeClips(split, ["a", "b"]);

    assertTrimInvariant(after.elements.a);
  });

  it("joins two adjacent static clips by summing their durations", () => {
    const base = doc([["track-1", "text"]], {
      a: textElement({ trackId: "track-1", startTime: 0, duration: 1000 }),
      b: textElement({ trackId: "track-1", startTime: 1000, duration: 500 }),
    });

    const after = mergeClips(base, ["a", "b"]);

    expect(Object.keys(after.elements)).toEqual(["a"]);
    expect(after.elements.a.duration).toBe(1500);
  });
});

describe("mergeClips — declining by identity", () => {
  const declines = (before: TimelineDocument, ids: string[]) => {
    expect(canMergeClips(before, ids)).toBe(false);
    expect(mergeClips(before, ids)).toBe(before);
  };

  it("declines a single clip", () => {
    const before = splitClip(oneClip(), "a", 1500, "b");
    declines(before, ["a"]);
  });

  it("declines an empty selection", () => {
    declines(oneClip(), []);
  });

  it("declines an id that is not in the document", () => {
    const before = splitClip(oneClip(), "a", 1500, "b");
    declines(before, ["a", "ghost"]);
  });

  it("declines clips on different tracks", () => {
    const before = doc([["track-1", "video"], ["track-2", "video"]], {
      a: videoElement({
        trackId: "track-1",
        startTime: 0,
        duration: 1000,
        trim: { startTime: 0, endTime: 1000 },
      }),
      b: videoElement({
        trackId: "track-2",
        startTime: 1000,
        duration: 1000,
        trim: { startTime: 1000, endTime: 2000 },
      }),
    });

    declines(before, ["a", "b"]);
  });

  it("declines clips with a gap between them", () => {
    const before = doc([["track-1", "video"]], {
      a: videoElement({
        trackId: "track-1",
        startTime: 0,
        duration: 1000,
        trim: { startTime: 0, endTime: 1000 },
      }),
      b: videoElement({
        trackId: "track-1",
        startTime: 1500,
        duration: 1000,
        trim: { startTime: 1000, endTime: 2000 },
      }),
    });

    declines(before, ["a", "b"]);
  });

  // Flush on the timeline but showing frames from elsewhere in the file: this
  // is what a trimmed cut looks like, and joining it would splice out the part
  // the user deliberately removed.
  it("declines clips whose source windows are not continuous", () => {
    const before = doc([["track-1", "video"]], {
      a: videoElement({
        trackId: "track-1",
        startTime: 0,
        duration: 1000,
        trim: { startTime: 0, endTime: 1000 },
      }),
      b: videoElement({
        trackId: "track-1",
        startTime: 1000,
        duration: 1000,
        trim: { startTime: 2500, endTime: 3500 },
      }),
    });

    declines(before, ["a", "b"]);
  });

  it("declines clips from different source files", () => {
    const before = doc([["track-1", "video"]], {
      a: videoElement({
        trackId: "track-1",
        localpath: "/tmp/one.mp4",
        startTime: 0,
        duration: 1000,
        trim: { startTime: 0, endTime: 1000 },
      }),
      b: videoElement({
        trackId: "track-1",
        localpath: "/tmp/two.mp4",
        startTime: 1000,
        duration: 1000,
        trim: { startTime: 1000, endTime: 2000 },
      }),
    });

    declines(before, ["a", "b"]);
  });

  it("declines clips playing at different speeds", () => {
    const before = doc([["track-1", "video"]], {
      a: videoElement({
        trackId: "track-1",
        speed: 1,
        startTime: 0,
        duration: 1000,
        trim: { startTime: 0, endTime: 1000 },
      }),
      b: videoElement({
        trackId: "track-1",
        speed: 2,
        startTime: 1000,
        duration: 1000,
        trim: { startTime: 1000, endTime: 2000 },
      }),
    });

    declines(before, ["a", "b"]);
  });

  it("declines two text clips that say different things", () => {
    const before = doc([["track-1", "text"]], {
      a: textElement({
        trackId: "track-1",
        text: "one",
        startTime: 0,
        duration: 1000,
      }),
      b: textElement({
        trackId: "track-1",
        text: "two",
        startTime: 1000,
        duration: 1000,
      }),
    });

    declines(before, ["a", "b"]);
  });

  it("declines clips in different groups", () => {
    const before = doc([["track-1", "video"]], {
      a: videoElement({
        trackId: "track-1",
        startTime: 0,
        duration: 1000,
        trim: { startTime: 0, endTime: 1000 },
      }),
      b: videoElement({
        trackId: "track-1",
        startTime: 1000,
        duration: 1000,
        trim: { startTime: 1000, endTime: 2000 },
      }),
    });
    // Set after construction: `repairHierarchy` drops a `parentId` naming a
    // group that does not exist.
    (before.elements.b as any).parentId = "group-1";

    declines(before, ["a", "b"]);
  });

  // There is no way to concatenate two baked animation tracks, so refusing is
  // the honest answer rather than silently keeping one clip's motion.
  it("declines when either clip is animated", () => {
    const before = splitClip(oneClip(), "a", 1500, "b");
    (before.elements.a as any).animation.opacity = {
      isActivate: true,
      x: [{ t: 0, v: 100 }],
      ax: [],
    };

    declines(before, ["a", "b"]);
  });
});
