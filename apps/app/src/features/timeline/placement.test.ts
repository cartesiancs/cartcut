import { describe, it, expect } from "vitest";
import { chooseTrackFor, placeNewElement } from "./placement";
import {
  SCHEMA_VERSION,
  clipsOnTrack,
  createTrack,
  emptyDocument,
  normalizeDocument,
  tracksOfKind,
  type TimelineDocument,
} from "./tracks";
import {
  audioElement,
  imageElement,
  textElement,
  videoElement,
} from "../renderer/testing";

function docWith(
  tracks: Array<[string, "video" | "audio" | "text"]>,
  elements: Record<string, any> = {},
): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: tracks.map(([id, kind], index) => createTrack(id, kind, index)),
    elements,
  });
}

describe("chooseTrackFor", () => {
  it("creates the first track of a kind when there is none", () => {
    const { doc, trackId } = chooseTrackFor(
      emptyDocument(),
      videoElement({}),
      0,
      "new",
    );
    expect(trackId).toBe("new");
    expect(doc.tracks).toHaveLength(1);
    expect(doc.tracks[0].kind).toBe("video");
  });

  it("reuses an existing track when the moment is free", () => {
    const doc = docWith([["v1", "video"]]);
    const result = chooseTrackFor(doc, videoElement({}), 5000, "new");
    expect(result.trackId).toBe("v1");
    expect(result.doc).toBe(doc);
  });

  it("adds a track only when every existing one is busy at that moment", () => {
    const doc = docWith(
      [["v1", "video"]],
      { a: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }) },
    );
    const result = chooseTrackFor(
      doc,
      imageElement({ duration: 1000 }),
      1000,
      "new",
    );
    expect(result.trackId).toBe("new");
    expect(tracksOfKind(result.doc, "video")).toHaveLength(2);
  });

  it("fills the bottom row before reaching for the one above", () => {
    // V1 before V2, as in every NLE.
    const doc = docWith([
      ["v2", "video"],
      ["v1", "video"],
    ]);
    expect(chooseTrackFor(doc, videoElement({}), 0, "new").trackId).toBe("v1");
  });

  it("skips a busy lower row and uses the free one above it", () => {
    const doc = docWith(
      [
        ["v2", "video"],
        ["v1", "video"],
      ],
      { a: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }) },
    );
    expect(chooseTrackFor(doc, imageElement({ duration: 1000 }), 1000, "new")
      .trackId).toBe("v2");
  });

  it("keeps each kind to its own tracks", () => {
    const doc = docWith([["v1", "video"]]);
    expect(chooseTrackFor(doc, audioElement({}), 0, "a1").trackId).toBe("a1");
    expect(chooseTrackFor(doc, textElement({}), 0, "t1").trackId).toBe("t1");
  });

  it("measures a sped-up clip by its timeline span when testing for room", () => {
    // 4s of source at 2x needs 2s of track, so it fits in a 2s gap.
    const doc = docWith(
      [["v1", "video"]],
      { a: imageElement({ trackId: "v1", startTime: 2000, duration: 4000 }) },
    );
    const fast = videoElement({
      duration: 4000,
      speed: 2,
      trim: { startTime: 0, endTime: 4000 },
      sourceDuration: 4000,
    });
    expect(chooseTrackFor(doc, fast, 0, "new").trackId).toBe("v1");
  });
});

describe("chooseTrackFor with a preferred track", () => {
  it("uses the row the drop aimed at, even if a lower one is free", () => {
    // Without this a drop onto V2 would silently land on V1, since V1 is
    // where the automatic search starts.
    const doc = docWith([
      ["v2", "video"],
      ["v1", "video"],
    ]);
    expect(
      chooseTrackFor(doc, videoElement({}), 0, "new", "v2").trackId,
    ).toBe("v2");
  });

  it("falls back rather than refusing when the aimed row is occupied", () => {
    const doc = docWith(
      [
        ["v2", "video"],
        ["v1", "video"],
      ],
      { blocker: imageElement({ trackId: "v2", startTime: 0, duration: 4000 }) },
    );
    expect(
      chooseTrackFor(doc, imageElement({ duration: 1000 }), 1000, "new", "v2")
        .trackId,
    ).toBe("v1");
  });

  it("ignores a preferred row of the wrong kind", () => {
    // Dropping audio onto a video row should not put it there.
    const doc = docWith([
      ["v1", "video"],
      ["a1", "audio"],
    ]);
    expect(chooseTrackFor(doc, audioElement({}), 0, "new", "v1").trackId).toBe(
      "a1",
    );
  });

  it("ignores a preferred row that no longer exists", () => {
    const doc = docWith([["v1", "video"]]);
    expect(
      chooseTrackFor(doc, videoElement({}), 0, "new", "gone").trackId,
    ).toBe("v1");
  });
});

describe("placeNewElement", () => {
  it("places a dropped clip on the row it was aimed at", () => {
    const base = docWith([
      ["v2", "video"],
      ["v1", "video"],
    ]);
    const doc = placeNewElement(
      base,
      "dropped",
      imageElement({ duration: 1000 }),
      3000,
      "new",
      "v2",
    );
    expect(doc.elements.dropped.trackId).toBe("v2");
    expect(doc.elements.dropped.startTime).toBe(3000);
  });

  it("places at the requested moment, not at zero", () => {
    // Everything used to be dropped at startTime 0 regardless.
    const doc = placeNewElement(
      emptyDocument(),
      "clip",
      videoElement({ startTime: 999 }),
      7000,
      "v1",
    );
    expect(doc.elements.clip.startTime).toBe(7000);
    expect(doc.elements.clip.trackId).toBe("v1");
  });

  it("puts a second clip on the same track as the first", () => {
    // The whole point: one track, many clips.
    let doc = placeNewElement(
      emptyDocument(),
      "a",
      imageElement({ duration: 1000 }),
      0,
      "v1",
    );
    doc = placeNewElement(doc, "b", imageElement({ duration: 1000 }), 2000, "v2");

    expect(doc.tracks).toHaveLength(1);
    expect(clipsOnTrack(doc, "v1").map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("collapses a whole transcript onto one text track", () => {
    // Forty captions used to mean forty rows. They never overlap, so they all
    // fit on one.
    let doc = emptyDocument();
    for (let i = 0; i < 40; i++) {
      doc = placeNewElement(
        doc,
        `caption${i}`,
        textElement({ duration: 900 }),
        i * 1000,
        `t${i}`,
      );
    }

    expect(tracksOfKind(doc, "text")).toHaveLength(1);
    expect(clipsOnTrack(doc, "t0")).toHaveLength(40);
  });

  it("still opens a second track for captions that do overlap", () => {
    let doc = placeNewElement(
      emptyDocument(),
      "a",
      textElement({ duration: 5000 }),
      0,
      "t0",
    );
    doc = placeNewElement(doc, "b", textElement({ duration: 5000 }), 1000, "t1");

    expect(tracksOfKind(doc, "text")).toHaveLength(2);
    expect(doc.elements.b.trackId).toBe("t1");
  });

  it("separates video, audio and text onto their own tracks", () => {
    let doc = placeNewElement(emptyDocument(), "v", videoElement({}), 0, "v1");
    doc = placeNewElement(doc, "a", audioElement({}), 0, "a1");
    doc = placeNewElement(doc, "t", textElement({}), 0, "t1");

    expect(doc.tracks).toHaveLength(3);
    expect(doc.elements.v.trackId).toBe("v1");
    expect(doc.elements.a.trackId).toBe("a1");
    expect(doc.elements.t.trackId).toBe("t1");
  });

  it("clamps a negative moment to the start of the timeline", () => {
    const doc = placeNewElement(
      emptyDocument(),
      "a",
      imageElement({}),
      -500,
      "v1",
    );
    expect(doc.elements.a.startTime).toBe(0);
  });

  it("derives a priority for the element it adds", () => {
    const doc = placeNewElement(
      emptyDocument(),
      "a",
      imageElement({ priority: 999 }),
      0,
      "v1",
    );
    expect(doc.elements.a.priority).toBe(1);
  });

  it("leaves the clips already present untouched", () => {
    const before = docWith(
      [["v1", "video"]],
      { a: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }) },
    );
    const after = placeNewElement(
      before,
      "b",
      imageElement({ duration: 1000 }),
      5000,
      "v2",
    );
    expect(after.elements.a.startTime).toBe(0);
    expect(before.elements.b).toBeUndefined();
  });
});
