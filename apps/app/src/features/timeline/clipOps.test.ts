import { describe, it, expect } from "vitest";
import {
  deleteClips,
  moveClip,
  moveClips,
  normalizeRanges,
  pasteClips,
  removeRanges,
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
import {
  groupElement,
  imageElement,
  textElement,
  videoElement,
} from "../renderer/testing";

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

// =========================================================== keyframes
//
// Keyframe times are relative to `element.startTime`, which makes a move free
// and a split or a paste dangerous: the ops build their results with `{...clip}`
// spreads, so without help the pieces share one `animation` object.

import { bakeTrack, sampleTrack } from "../animation/keyframes";
import { keys } from "../renderer/testing";

function animated(over = {}) {
  const authored = keys([0, 0], [2000, 100]);
  return imageElement({
    trackId: "v1",
    startTime: 1000,
    duration: 2000,
    animation: {
      position: { isActivate: false, x: [], y: [], ax: [], ay: [] },
      opacity: { isActivate: true, x: authored, ax: bakeTrack(authored) },
      scale: { isActivate: false, x: [], ax: [] },
      rotation: { isActivate: false, x: [], ax: [] },
    },
    ...over,
  });
}

const opacityAt = (element: any, cursorMs: number) =>
  sampleTrack(element.animation.opacity, element.startTime, cursorMs, -1);

/**
 * How far two samples of the same curve may legitimately differ.
 *
 * A split is exact — `sliceKeyframes` subdivides the segment rather than
 * planting a default-handled keyframe — so the only slack is that the two
 * sides bake onto grids offset from each other, and sampling snaps to the
 * nearest point rather than blending. That is half a 60Hz sample of the ramp:
 * `animated()` covers 0 -> 100 across 2000ms, so ~0.42.
 */
const SAMPLE_SLACK = (100 * (1000 / 60)) / 2000;

function expectSameCurve(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(SAMPLE_SLACK);
}

describe("moveClips and keyframes", () => {
  it("carries the animation with the clip", () => {
    // This works for free because the times are relative — but "for free"
    // is exactly the kind of thing that stops being true silently.
    const before = doc([["v1", "video"]], { a: animated() });
    const after = moveClips(before, ["a"], 3000);

    expect((after.elements.a as any).startTime).toBe(4000);
    for (let offset = 0; offset <= 2000; offset += 100) {
      expect(opacityAt(after.elements.a, 4000 + offset)).toBe(
        opacityAt(before.elements.a, 1000 + offset),
      );
    }
  });

  it("leaves the keyframe times themselves untouched", () => {
    const before = doc([["v1", "video"]], { a: animated() });
    const after = moveClips(before, ["a"], 3000);
    expect((after.elements.a as any).animation.opacity.x.map((k) => k.p[0])).toEqual(
      [0, 2000],
    );
  });

  it("does not let a later keyframe edit reach the previous document", () => {
    // A move spreads the element shallowly, so the moved clip shares its
    // animation with the version before the move. That is safe only while
    // every keyframe write is immutable — which is what this pins.
    const before = doc([["v1", "video"]], { a: animated() });
    const snapshot = JSON.parse(JSON.stringify(before.elements.a));
    const after = moveClips(before, ["a"], 3000);

    (after.elements.a as any).animation = {
      ...(after.elements.a as any).animation,
      opacity: { isActivate: true, x: [], ax: [] },
    };

    expect(JSON.parse(JSON.stringify(before.elements.a))).toEqual(snapshot);
  });
});

describe("pasteClips and keyframes", () => {
  it("gives every paste its own animation object", () => {
    // Pasting twice from one clipboard used to produce two elements editing a
    // single animation, because `copySelected`'s `structuredClone` runs once at
    // copy time and the paste itself only spread the clip.
    const base = doc([["v1", "video"]], {});
    const clipboard = { a: animated() };

    let ids = 0;
    const idGen = () => `p${ids++}`;

    let after = pasteClips(base, clipboard, 5000, idGen);
    after = pasteClips(after, clipboard, 20_000, idGen);

    const pasted = Object.values(after.elements) as any[];
    expect(pasted).toHaveLength(2);
    expect(pasted[0].animation).not.toBe(pasted[1].animation);
    expect(pasted[0].animation).not.toBe(clipboard.a.animation);
    expect(pasted[0].animation.opacity.x[0]).not.toBe(
      pasted[1].animation.opacity.x[0],
    );
    expect(pasted[0].animation).toEqual(pasted[1].animation);
  });

  it("keeps the pasted clip showing what the original showed", () => {
    const base = doc([["v1", "video"]], {});
    const after = pasteClips(base, { a: animated() }, 5000, () => "p0");
    const pasted: any = after.elements.p0;

    for (let offset = 0; offset <= 2000; offset += 100) {
      expect(opacityAt(pasted, pasted.startTime + offset)).toBe(
        opacityAt(animated(), 1000 + offset),
      );
    }
  });
});

describe("splitClip and keyframes", () => {
  it("gives the halves independent animations at the document level", () => {
    const before = doc([["v1", "video"]], { a: animated() });
    const after = splitClip(before, "a", 2000, "b");

    const left: any = after.elements.a;
    const right: any = after.elements.b;
    expect(left.animation).not.toBe(right.animation);
    expect(left.animation.opacity.x[0]).not.toBe(right.animation.opacity.x[0]);
  });

  it("shows the same value across the seam as before the cut", () => {
    const before = doc([["v1", "video"]], { a: animated() });
    const after = splitClip(before, "a", 2000, "b");

    for (let cursor = 1000; cursor < 3000; cursor += 50) {
      const half = cursor < 2000 ? after.elements.a : after.elements.b;
      expectSameCurve(opacityAt(half, cursor), opacityAt(before.elements.a, cursor));
    }
  });

  it("survives being split repeatedly", () => {
    // The "used hard" case: cut, cut a piece again, and again.
    let d = doc([["v1", "video"]], { a: animated({ duration: 4000 }) });
    const original = d.elements.a;

    d = splitClip(d, "a", 2000, "b");
    d = splitClip(d, "b", 3000, "c");
    d = splitClip(d, "c", 4000, "e");

    const pieces = Object.values(d.elements) as any[];
    expect(pieces).toHaveLength(4);

    const seen = new Set<object>();
    for (const piece of pieces) {
      expect(seen.has(piece.animation)).toBe(false);
      seen.add(piece.animation);
      expect(piece.animation.opacity.ax).toEqual(
        bakeTrack(piece.animation.opacity.x),
      );
    }

    for (let cursor = 1000; cursor < 5000; cursor += 50) {
      const piece = pieces.find(
        (p) => cursor >= p.startTime && cursor < p.startTime + p.duration,
      );
      if (piece == null) continue;
      expectSameCurve(opacityAt(piece, cursor), opacityAt(original, cursor));
    }
  });
});

describe("rippleDelete and keyframes", () => {
  it("shifts a following clip without disturbing its keyframes", () => {
    const before = doc([["v1", "video"]], {
      a: animated({ startTime: 0, duration: 1000 }),
      b: animated({ startTime: 1000, duration: 2000 }),
    });
    const after = rippleDelete(before, "a");

    const moved: any = after.elements.b;
    expect(moved.startTime).toBe(0);
    expect(moved.animation.opacity.x.map((k: any) => k.p[0])).toEqual([0, 2000]);
  });
});

describe("normalizeRanges", () => {
  it("merges overlapping and touching ranges and orders them latest first", () => {
    expect(
      normalizeRanges([
        { startMs: 1000, endMs: 2000 },
        { startMs: 1500, endMs: 2500 },
        { startMs: 4000, endMs: 5000 },
        { startMs: 2500, endMs: 3000 },
      ]),
    ).toEqual([
      { startMs: 4000, endMs: 5000 },
      { startMs: 1000, endMs: 3000 },
    ]);
  });

  it("drops empty and inverted ranges", () => {
    expect(
      normalizeRanges([
        { startMs: 500, endMs: 500 },
        { startMs: 900, endMs: 300 },
      ]),
    ).toEqual([{ startMs: 300, endMs: 900 }]);
  });

  it("clamps a negative start rather than producing one", () => {
    expect(normalizeRanges([{ startMs: -200, endMs: 400 }])).toEqual([
      { startMs: 0, endMs: 400 },
    ]);
  });
});

describe("removeRanges", () => {
  const base = () =>
    doc([["v1", "video"]], {
      a: videoElement({
        trackId: "v1",
        startTime: 0,
        duration: 10000,
        trim: { startTime: 0, endTime: 10000 },
        sourceDuration: 10000,
      }),
    });

  it("cuts one window out and closes the gap", () => {
    const after = removeRanges(
      base(),
      "a",
      [{ startMs: 3000, endMs: 5000 }],
      true,
      idGen,
    );

    const spans = clipsOnTrack(after, "v1").map(([, el]) => spanOf(el));
    expect(spans).toHaveLength(2);
    // Head keeps its place; tail slides back by the 2s that was removed.
    expect(spans[0]).toMatchObject({ start: 0, end: 3000 });
    expect(spans[1]).toMatchObject({ start: 3000, end: 8000 });
    expectValid(after);
  });

  it("leaves a hole when ripple is off", () => {
    const after = removeRanges(
      base(),
      "a",
      [{ startMs: 3000, endMs: 5000 }],
      false,
      idGen,
    );

    const spans = clipsOnTrack(after, "v1").map(([, el]) => spanOf(el));
    expect(spans[0]).toMatchObject({ start: 0, end: 3000 });
    expect(spans[1]).toMatchObject({ start: 5000, end: 10000 });
    expectValid(after);
  });

  it("applies several ranges in one pass, in original coordinates", () => {
    // The caller holds a transcript: every range is stated against the clip as
    // it is now, not as it will be after the earlier cuts land.
    const after = removeRanges(
      base(),
      "a",
      [
        { startMs: 1000, endMs: 2000 },
        { startMs: 4000, endMs: 5000 },
        { startMs: 8000, endMs: 9000 },
      ],
      true,
      idGen,
    );

    const spans = clipsOnTrack(after, "v1").map(([, el]) => spanOf(el));
    expect(spans).toHaveLength(4);
    // 3s removed in total, and the survivors are contiguous.
    expect(spans[0]).toMatchObject({ start: 0, end: 1000 });
    expect(spans[spans.length - 1].end).toBe(7000);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBe(spans[i - 1].end);
    }
    expectValid(after);
  });

  it("keeps every surviving frame of the source", () => {
    const after = removeRanges(
      base(),
      "a",
      [{ startMs: 2000, endMs: 4000 }],
      true,
      idGen,
    );

    const windows = clipsOnTrack(after, "v1")
      .map(([, el]: any) => el.trim)
      .sort((x, y) => x.startTime - y.startTime);
    expect(windows).toEqual([
      { startTime: 0, endTime: 2000 },
      { startTime: 4000, endTime: 10000 },
    ]);
  });

  it("trims from the head when the range starts before the clip", () => {
    const after = removeRanges(
      base(),
      "a",
      [{ startMs: 0, endMs: 2000 }],
      false,
      idGen,
    );

    const spans = clipsOnTrack(after, "v1").map(([, el]) => spanOf(el));
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 2000, end: 10000 });
    expectValid(after);
  });

  it("never touches a neighbour that merely shares the track", () => {
    // The pieces of the target clip are found by position, so a bystander in
    // the same lane and the same window is exactly the thing that could be
    // deleted by mistake.
    const before = doc([["v1", "video"], ["v2", "video"]], {
      a: videoElement({ trackId: "v1", startTime: 0, duration: 4000 }),
      bystander: videoElement({ trackId: "v2", startTime: 1000, duration: 2000 }),
    });

    const after = removeRanges(
      before,
      "a",
      [{ startMs: 1000, endMs: 2000 }],
      false,
      idGen,
    );

    expect(after.elements.bystander).toBeDefined();
    expect(spanOf(after.elements.bystander)).toMatchObject({
      start: 1000,
      end: 3000,
    });
  });

  it("removes the whole clip when a range covers it", () => {
    const after = removeRanges(
      base(),
      "a",
      [{ startMs: 0, endMs: 10000 }],
      true,
      idGen,
    );
    expect(Object.keys(after.elements)).toHaveLength(0);
  });

  it("declines by identity when nothing bites", () => {
    const before = base();
    // Entirely past the clip, an empty range, and an unknown id.
    expect(removeRanges(before, "a", [{ startMs: 20000, endMs: 21000 }], true, idGen)).toBe(
      before,
    );
    expect(removeRanges(before, "a", [], true, idGen)).toBe(before);
    expect(removeRanges(before, "nope", [{ startMs: 0, endMs: 1 }], true, idGen)).toBe(
      before,
    );
  });
});

// ------------------------------------------------------------ groups

describe("clip ops with a transform hierarchy", () => {
  /** A group on "g1" holding two clips, plus an unrelated bystander. */
  function grouped(): TimelineDocument {
    return doc(
      [
        ["v1", "video"],
        ["g1", "group" as any],
      ],
      {
        grp: groupElement({ trackId: "g1", startTime: 0, duration: 4000 }),
        a: imageElement({ parentId: "grp", trackId: "v1", startTime: 0, duration: 1000 }),
        b: imageElement({ parentId: "grp", trackId: "v1", startTime: 2000, duration: 1000 }),
        loose: imageElement({ trackId: "v1", startTime: 6000, duration: 1000 }),
      },
    );
  }

  it("deletes a group's contents along with it", () => {
    // "Delete the group" has to mean the contents too, or the children scatter
    // to wherever their parent-local coordinates land in canvas space.
    const after = deleteClips(grouped(), ["grp"]);
    expect(after.elements.grp).toBeUndefined();
    expect(after.elements.a).toBeUndefined();
    expect(after.elements.b).toBeUndefined();
    expect(after.elements.loose).toBeDefined();
  });

  it("deletes a nested group's whole subtree", () => {
    const base = normalizeDocument({
      ...grouped(),
      elements: {
        ...grouped().elements,
        outer: groupElement({ trackId: "g1", startTime: 0, duration: 4000 }),
        grp: groupElement({
          trackId: "g1",
          startTime: 0,
          duration: 4000,
          parentId: "outer",
        }),
      },
    });
    const after = deleteClips(base, ["outer"]);
    expect(Object.keys(after.elements)).toEqual(["loose"]);
  });

  it("leaves a child's siblings alone when only the child is deleted", () => {
    const after = deleteClips(grouped(), ["a"]);
    expect(after.elements.grp).toBeDefined();
    expect(after.elements.b).toBeDefined();
  });

  it("takes the contents along on a ripple delete too", () => {
    const after = rippleDelete(grouped(), "grp");
    expect(after.elements.a).toBeUndefined();
    expect(after.elements.b).toBeUndefined();
  });

  it("keeps parentId on both halves of a split", () => {
    const after = splitClip(grouped(), "a", 500, "right");
    expect((after.elements.a as any).parentId).toBe("grp");
    expect((after.elements.right as any).parentId).toBe("grp");
  });

  it("keeps parentId when a clip is trimmed", () => {
    expect((trimClipStart(grouped(), "a", 200).elements.a as any).parentId).toBe("grp");
    expect((trimClipEnd(grouped(), "a", -200).elements.a as any).parentId).toBe("grp");
  });

  it("keeps parentId when a clip moves in time", () => {
    const after = moveClips(grouped(), ["a"], 4000);
    expect((after.elements.a as any).parentId).toBe("grp");
  });

  it("does not move a group's children when the group moves in time", () => {
    // Parenting here is spatial only. A group's bar carries its own keyframe
    // time base and nothing else.
    const after = moveClips(grouped(), ["grp"], 1000);
    expect(after.elements.grp.startTime).toBe(1000);
    expect(after.elements.a.startTime).toBe(0);
    expect(after.elements.b.startTime).toBe(2000);
  });

  it("remaps parentId when a group and its children are pasted together", () => {
    // Without the remap the copies keep pointing at the *original* group, so
    // two groups end up sharing one set of children.
    const source = grouped();
    const clipboard = {
      grp: source.elements.grp,
      a: source.elements.a,
      b: source.elements.b,
    };
    let n = 0;
    const gen = () => `new${n++}`;
    const after = pasteClips(source, clipboard as any, 10000, gen);

    const pastedGroupId = Object.keys(after.elements).find(
      (id) => id.startsWith("new") && after.elements[id].filetype === "group",
    );
    expect(pastedGroupId).toBeDefined();

    const pastedChildren = Object.entries(after.elements).filter(
      ([id, el]) => id.startsWith("new") && el.filetype !== "group",
    );
    expect(pastedChildren).toHaveLength(2);
    for (const [, child] of pastedChildren) {
      expect((child as any).parentId).toBe(pastedGroupId);
    }
    // …and the originals still point at the original group.
    expect((after.elements.a as any).parentId).toBe("grp");
  });

  it("keeps a lone pasted child attached to the group it came from", () => {
    const source = grouped();
    let n = 0;
    const after = pasteClips(
      source,
      { a: source.elements.a } as any,
      10000,
      () => `new${n++}`,
    );
    const pasted = Object.keys(after.elements).find((id) => id.startsWith("new"));
    expect((after.elements[pasted as string] as any).parentId).toBe("grp");
  });

  it("drops the link when the pasted child's group is not in the document", () => {
    // `normalizeDocument` runs `repairHierarchy`, so a dangling link cannot
    // survive a paste into a project that never had the group.
    const orphanSource = doc(
      [["v1", "video"]],
      { a: imageElement({ trackId: "v1", parentId: "elsewhere" }) },
    );
    const after = pasteClips(
      orphanSource,
      { a: orphanSource.elements.a } as any,
      5000,
      () => "fresh",
    );
    expect((after.elements.fresh as any).parentId).toBeUndefined();
  });

  it("gives each pasted clip a distinct id", () => {
    const source = grouped();
    let n = 0;
    const after = pasteClips(
      source,
      { a: source.elements.a, b: source.elements.b } as any,
      10000,
      () => `new${n++}`,
    );
    const pasted = Object.keys(after.elements).filter((id) => id.startsWith("new"));
    expect(new Set(pasted).size).toBe(pasted.length);
    expect(pasted).toHaveLength(2);
  });
});
