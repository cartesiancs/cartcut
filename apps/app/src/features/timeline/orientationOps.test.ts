import { describe, it, expect } from "vitest";
import type { VideoElementType } from "../../@types/timeline";
import { isReoriented, resetClipOrientation } from "./orientationOps";
import { setClipMirror } from "./mirrorOps";
import { applyReverse, isReversed, reverseSnapshotOf } from "./reverseOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { imageElement, textElement, videoElement } from "../renderer/testing";

const SOURCE = "file:///tmp/source.mp4";
const REVERSED = "file:///tmp/reversed/abc.mp4";

function doc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      clip: videoElement({
        trackId: "v0",
        localpath: SOURCE,
        startTime: 1000,
        duration: 3000,
        trim: { startTime: 2000, endTime: 5000 },
        sourceDuration: 10000,
        isExistAudio: true,
      }),
      still: imageElement({ trackId: "v0", startTime: 4000, duration: 1000 }),
      title: textElement({ trackId: "v0", startTime: 5000, duration: 1000 }),
    },
  });
}

function reversed(d: TimelineDocument): TimelineDocument {
  return applyReverse(d, "clip", reverseSnapshotOf(d.elements.clip)!, {
    localpath: REVERSED,
    durationMs: 3000,
    hasAudio: true,
  });
}

/** Mirrored, flipped and reversed: everything the section can set at once. */
function everything(): TimelineDocument {
  let d = reversed(doc());
  d = setClipMirror(d, "clip", "h", true);
  return setClipMirror(d, "clip", "v", true);
}

describe("isReoriented", () => {
  it("is false for a clip at rest", () => {
    expect(isReoriented(doc().elements.clip)).toBe(false);
  });

  it("is true for each of the three on its own", () => {
    expect(
      isReoriented(setClipMirror(doc(), "clip", "h", true).elements.clip),
    ).toBe(true);
    expect(
      isReoriented(setClipMirror(doc(), "clip", "v", true).elements.clip),
    ).toBe(true);
    expect(isReoriented(reversed(doc()).elements.clip)).toBe(true);
  });

  it("is false for a type that carries none of them, and for no element", () => {
    expect(isReoriented(doc().elements.title)).toBe(false);
    expect(isReoriented(undefined)).toBe(false);
  });
});

describe("resetClipOrientation", () => {
  it("clears both mirrors and the reversal in one document", () => {
    const before = everything();
    expect(isReoriented(before.elements.clip)).toBe(true);

    const after = resetClipOrientation(before, "clip");
    const clip = after.elements.clip as VideoElementType;
    expect(isReoriented(clip)).toBe(false);
    expect(isReversed(clip)).toBe(false);
    expect(clip.localpath).toBe(SOURCE);
    expect("flipH" in clip).toBe(false);
    expect("flipV" in clip).toBe(false);
  });

  it("saves byte-identically to a clip that was never touched", () => {
    const after = resetClipOrientation(everything(), "clip");
    expect(JSON.stringify(after.elements.clip)).toBe(
      JSON.stringify(doc().elements.clip),
    );
  });

  it("clears an image's mirrors, which is all an image has", () => {
    const before = setClipMirror(doc(), "still", "h", true);
    const after = resetClipOrientation(before, "still");
    expect(isReoriented(after.elements.still)).toBe(false);
  });

  it("leaves every other clip alone", () => {
    let before = everything();
    before = setClipMirror(before, "still", "v", true);
    const after = resetClipOrientation(before, "clip");
    expect(after.elements.still).toBe(before.elements.still);
  });

  describe("declines by identity", () => {
    it("for a clip already at rest", () => {
      const d = doc();
      expect(resetClipOrientation(d, "clip")).toBe(d);
    });

    it("for a type that cannot be oriented", () => {
      const d = doc();
      expect(resetClipOrientation(d, "title")).toBe(d);
    });

    it("for an id that is not in the document", () => {
      const d = everything();
      expect(resetClipOrientation(d, "missing")).toBe(d);
    });
  });
});
