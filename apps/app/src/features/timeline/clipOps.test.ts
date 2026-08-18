import { describe, it, expect } from "vitest";
import {
  deleteClips,
  moveClip,
  moveClips,
  pasteClips,
  rippleDelete,
  splitAtPlayhead,
  splitClip,
  trimClipEnd,
  trimClipStart,
} from "./clipOps";
import {
  SCHEMA_VERSION,
  clipsOnTrack,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { assertTrimInvariant, spanOf } from "./geometry";
import { imageElement, textElement, videoElement } from "../renderer/testing";

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

/** Every op must leave a document whose tracks hold no overlapping clips. */
function expectValid(d: TimelineDocument) {
  for (const element of Object.values(d.elements)) {
    expect(() => assertTrimInvariant(element)).not.toThrow();
    expect(element.startTime).toBeGreaterThanOrEqual(0);
  }
  for (const track of d.tracks) {
    const spans = clipsOnTrack(d, track.id).map(([, el]) => spanOf(el));
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
  }
}

let counter = 0;
const idGen = () => `new${counter++}`;

describe("splitClip", () => {
  const base = doc([["v1", "video"]], {
    a: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }),
  });

  it("leaves both halves on the same track", () => {
    // The heart of requirement 1: a cut must not spawn a row.
    const next = splitClip(base, "a", 2000, "b");
    expect(next.tracks).toHaveLength(1);
    expect(next.elements.a.trackId).toBe("v1");
    expect(next.elements.b.trackId).toBe("v1");
    expectValid(next);
  });

  it("tiles the original span exactly", () => {
    const next = splitClip(base, "a", 2500, "b");
    expect(spanOf(next.elements.a)).toMatchObject({ start: 0, end: 2500 });
    expect(spanOf(next.elements.b)).toMatchObject({ start: 2500, end: 4000 });
  });

  it("splits the source window of a dynamic clip at the matching frame", () => {
    const withVideo = doc([["v1", "video"]], {
      v: videoElement({
        trackId: "v1",
        startTime: 1000,
        duration: 4000,
        speed: 1,
        trim: { startTime: 2000, endTime: 6000 },
        sourceDuration: 20_000,
      }),
    });
    const next = splitClip(withVideo, "v", 3000, "b");
    expect((next.elements.v as any).trim).toEqual({
      startTime: 2000,
      endTime: 4000,
    });
    expect((next.elements.b as any).trim).toEqual({
      startTime: 4000,
      endTime: 6000,
    });
    expectValid(next);
  });

  it("declines, by identity, when the playhead is off the clip", () => {
    // Identity is how `withCheckpoint` knows not to burn an undo step.
    expect(splitClip(base, "a", 9000, "b")).toBe(base);
    expect(splitClip(base, "a", 0, "b")).toBe(base);
    expect(splitClip(base, "a", 4000, "b")).toBe(base);
  });

  it("declines for an element that is not there", () => {
    expect(splitClip(base, "nope", 2000, "b")).toBe(base);
  });

  it("re-derives priorities so the new half is in paint order", () => {
    const next = splitClip(base, "a", 2000, "b");
    const priorities = Object.values(next.elements).map((el) => el.priority);
    expect(new Set(priorities).size).toBe(2);
  });
});

describe("splitAtPlayhead", () => {
  it("cuts every selected clip the playhead crosses", () => {
    const base = doc([["v1", "video"], ["v2", "video"]], {
      a: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }),
      b: imageElement({ trackId: "v2", startTime: 0, duration: 4000 }),
    });
    const next = splitAtPlayhead(base, ["a", "b"], 2000, idGen);
    expect(Object.keys(next.elements)).toHaveLength(4);
    expectValid(next);
  });

  it("skips clips the playhead misses without declining the rest", () => {
    const base = doc([["v1", "video"], ["v2", "video"]], {
      hit: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }),
      miss: imageElement({ trackId: "v2", startTime: 8000, duration: 1000 }),
    });
    const next = splitAtPlayhead(base, ["hit", "miss"], 2000, idGen);
    expect(Object.keys(next.elements)).toHaveLength(3);
  });

  it("declines entirely when nothing is crossed", () => {
    const base = doc([["v1", "video"]], {
      a: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }),
    });
    expect(splitAtPlayhead(base, ["a"], 9000, idGen)).toBe(base);
  });
});

describe("moveClips", () => {
  const base = doc([["v1", "video"], ["v2", "video"], ["a1", "audio"]], {
    a: imageElement({ trackId: "v1", startTime: 0, duration: 2000 }),
    b: imageElement({ trackId: "v1", startTime: 4000, duration: 2000 }),
  });

  it("shifts a clip in time", () => {
    const next = moveClip(base, "a", 500);
    expect(next.elements.a.startTime).toBe(500);
    expectValid(next);
  });

  it("moves a clip to another track", () => {
    const next = moveClip(base, "a", 0, 1);
    expect(next.elements.a.trackId).toBe("v2");
    expectValid(next);
  });

  it("refuses a move that would overlap a neighbour", () => {
    // Overlap is forbidden, and reverting beats overwriting footage.
    expect(moveClip(base, "a", 3500)).toBe(base);
  });

  it("allows a move that lands flush against a neighbour", () => {
    // Half-open spans: ending exactly where the next begins is not a collision.
    const next = moveClip(base, "a", 2000);
    expect(spanOf(next.elements.a).end).toBe(4000);
    expectValid(next);
  });

  it("refuses to move off the start of the timeline", () => {
    expect(moveClip(base, "a", -1000)).toBe(base);
  });

  it("refuses to move past the last track", () => {
    expect(moveClip(base, "a", 0, 5)).toBe(base);
    expect(moveClip(base, "a", 0, -1)).toBe(base);
  });

  it("refuses to move a clip onto a track of another kind", () => {
    const next = moveClip(base, "b", 0, 1);
    expect(next.elements.b.trackId).toBe("v2");
    // v2 -> a1 crosses from video to audio.
    expect(moveClip(next, "b", 0, 1)).toBe(next);
  });

  it("moves a whole selection together, preserving relative timing", () => {
    const next = moveClips(base, ["a", "b"], 1000);
    expect(next.elements.a.startTime).toBe(1000);
    expect(next.elements.b.startTime).toBe(5000);
    expectValid(next);
  });

  it("is atomic — one blocked clip stops the whole move", () => {
    const crowded = doc([["v1", "video"], ["v2", "video"]], {
      a: imageElement({ trackId: "v1", startTime: 0, duration: 2000 }),
      b: imageElement({ trackId: "v2", startTime: 0, duration: 2000 }),
      blocker: imageElement({ trackId: "v2", startTime: 3000, duration: 2000 }),
    });
    // "a" alone could slide to 3000 on v1; "b" cannot, so neither does.
    expect(moveClips(crowded, ["a", "b"], 3000)).toBe(crowded);
  });

  it("lets a selection slide past a clip that is itself moving", () => {
    // Members of the selection must not block each other at their old spots.
    const next = moveClips(base, ["a", "b"], 1000);
    expect(Object.keys(next.elements)).toHaveLength(2);
  });

  it("refuses when two moved clips would land on each other", () => {
    const stacked = doc([["v1", "video"], ["v2", "video"]], {
      a: imageElement({ trackId: "v1", startTime: 0, duration: 2000 }),
      b: imageElement({ trackId: "v2", startTime: 0, duration: 2000 }),
    });
    // Both dropping onto v2 at the same instant.
    expect(moveClips(stacked, ["a", "b"], 0, 1)).toBe(stacked);
  });

  it("declines an empty selection", () => {
    expect(moveClips(base, [], 1000)).toBe(base);
  });
});

describe("trimClipStart / trimClipEnd", () => {
  const base = doc([["v1", "video"]], {
    a: imageElement({ trackId: "v1", startTime: 2000, duration: 2000 }),
    b: imageElement({ trackId: "v1", startTime: 6000, duration: 2000 }),
  });

  it("shortens from the left", () => {
    const next = trimClipStart(base, "a", 500);
    expect(spanOf(next.elements.a)).toMatchObject({ start: 2500, end: 4000 });
    expectValid(next);
  });

  it("extends left only as far as the previous clip", () => {
    const crowded = doc([["v1", "video"]], {
      first: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }),
      second: imageElement({ trackId: "v1", startTime: 2000, duration: 2000 }),
    });
    // Asked for 5000ms of extension; only 1000ms exists before "first".
    const next = trimClipStart(crowded, "second", -5000);
    expect(spanOf(next.elements.second).start).toBe(1000);
    expectValid(next);
  });

  it("extends left only as far as the start of the timeline", () => {
    const next = trimClipStart(base, "a", -9000);
    expect(next.elements.a.startTime).toBe(0);
    expectValid(next);
  });

  it("lengthens to the right", () => {
    const next = trimClipEnd(base, "a", 1000);
    expect(spanOf(next.elements.a).end).toBe(5000);
    expectValid(next);
  });

  it("stops at the next clip rather than overlapping it", () => {
    // Clamped, not refused: an edge should slide until it meets its neighbour.
    const next = trimClipEnd(base, "a", 9000);
    expect(spanOf(next.elements.a).end).toBe(6000);
    expectValid(next);
  });

  it("has no neighbour limit on the last clip of a track", () => {
    const next = trimClipEnd(base, "b", 5000);
    expect(spanOf(next.elements.b).end).toBe(13_000);
  });

  it("keeps a dynamic clip's duration matched to its source window", () => {
    const withVideo = doc([["v1", "video"]], {
      v: videoElement({
        trackId: "v1",
        startTime: 0,
        duration: 4000,
        speed: 1,
        trim: { startTime: 1000, endTime: 5000 },
        sourceDuration: 20_000,
      }),
    });
    const next = trimClipStart(withVideo, "v", 1000);
    expect((next.elements.v as any).trim.startTime).toBe(2000);
    expect(next.elements.v.duration).toBe(3000);
    expectValid(next);
  });

  it("declines when nothing would change", () => {
    expect(trimClipEnd(base, "a", 0)).toBe(base);
    expect(trimClipStart(base, "nope", 100)).toBe(base);
  });
});

describe("deleteClips", () => {
  const base = doc([["v1", "video"]], {
    a: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }),
    b: imageElement({ trackId: "v1", startTime: 2000, duration: 1000 }),
  });

  it("removes the named clips and leaves the gap", () => {
    const next = deleteClips(base, ["a"]);
    expect(Object.keys(next.elements)).toEqual(["b"]);
    expect(next.elements.b.startTime).toBe(2000);
  });

  it("keeps the track even when it empties", () => {
    // Rows are the user's structure; deleting the last clip should not take the
    // lane with it.
    const next = deleteClips(base, ["a", "b"]);
    expect(next.tracks).toHaveLength(1);
  });

  it("declines when nothing matches", () => {
    expect(deleteClips(base, ["nope"])).toBe(base);
    expect(deleteClips(base, [])).toBe(base);
  });
});

describe("rippleDelete", () => {
  it("closes the gap on that track", () => {
    const base = doc([["v1", "video"]], {
      a: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }),
      b: imageElement({ trackId: "v1", startTime: 1000, duration: 1000 }),
      c: imageElement({ trackId: "v1", startTime: 2000, duration: 1000 }),
    });
    const next = rippleDelete(base, "b");
    expect(spanOf(next.elements.a)).toMatchObject({ start: 0, end: 1000 });
    expect(spanOf(next.elements.c)).toMatchObject({ start: 1000, end: 2000 });
    expectValid(next);
  });

  it("leaves other tracks where they are", () => {
    // Lane-local, not a magnetic timeline: pulling one row must not re-time
    // the music underneath it.
    const base = doc([["v1", "video"], ["a1", "audio"]], {
      a: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }),
      b: imageElement({ trackId: "v1", startTime: 1000, duration: 1000 }),
      music: imageElement({ trackId: "a1", startTime: 1500, duration: 4000 }),
    });
    const next = rippleDelete(base, "a");
    expect(next.elements.music.startTime).toBe(1500);
    expect(next.elements.b.startTime).toBe(0);
  });

  it("does not move clips that start before the deleted one", () => {
    const base = doc([["v1", "video"]], {
      early: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }),
      target: imageElement({ trackId: "v1", startTime: 5000, duration: 1000 }),
    });
    const next = rippleDelete(base, "target");
    expect(next.elements.early.startTime).toBe(0);
  });

  it("declines for a missing clip", () => {
    const base = doc([["v1", "video"]], {});
    expect(rippleDelete(base, "nope")).toBe(base);
  });
});

describe("pasteClips", () => {
  const clipboard = {
    x: imageElement({ trackId: "v1", startTime: 1000, duration: 1000 }),
    y: imageElement({ trackId: "v1", startTime: 3000, duration: 1000 }),
  };

  it("anchors the earliest clip at the paste point", () => {
    const base = doc([["v1", "video"]], {});
    const next = pasteClips(base, clipboard, 10_000, idGen);
    const starts = Object.values(next.elements)
      .map((el) => el.startTime)
      .sort((a, b) => a - b);
    expect(starts).toEqual([10_000, 12_000]);
    expectValid(next);
  });

  it("keeps the copied clips on their original track when it is free", () => {
    const base = doc([["v1", "video"]], {});
    const next = pasteClips(base, clipboard, 10_000, idGen);
    expect(next.tracks).toHaveLength(1);
    expect(clipsOnTrack(next, "v1")).toHaveLength(2);
  });

  it("finds another track when the original spot is taken", () => {
    const base = doc([["v1", "video"]], {
      blocker: imageElement({ trackId: "v1", startTime: 0, duration: 20_000 }),
    });
    const next = pasteClips(base, clipboard, 1000, idGen);
    expect(next.tracks.length).toBeGreaterThan(1);
    expectValid(next);
  });

  it("gives every pasted clip a fresh id, leaving the originals alone", () => {
    const base = doc([["v1", "video"]], {
      x: imageElement({ trackId: "v1", startTime: 1000, duration: 1000 }),
    });
    const next = pasteClips(base, clipboard, 20_000, idGen);
    expect(next.elements.x.startTime).toBe(1000);
    expect(Object.keys(next.elements)).toHaveLength(3);
  });

  it("declines an empty clipboard", () => {
    const base = doc([["v1", "video"]], {});
    expect(pasteClips(base, {}, 1000, idGen)).toBe(base);
  });

  it("clamps a paste that would start before zero", () => {
    const base = doc([["t1", "text"]], {});
    const next = pasteClips(
      base,
      { x: textElement({ trackId: "t1", startTime: 0, duration: 1000 }) },
      -5000,
      idGen,
    );
    expect(Object.values(next.elements)[0].startTime).toBe(0);
  });
});
