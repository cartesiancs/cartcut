import { describe, it, expect } from "vitest";
import type { VideoElementType } from "../../@types/timeline";
import {
  applyReverse,
  isReversed,
  isReversible,
  reverseSnapshotOf,
  unreverse,
  unreverseMany,
  type ReverseResult,
} from "./reverseOps";
import { hasValidTrim, spanOf } from "./geometry";
import { splitClip } from "./clipOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { imageElement, videoElement } from "../renderer/testing";

const SOURCE = "file:///tmp/source.mp4";
const REVERSED = "file:///tmp/reversed/abc.mp4";

/**
 * A clip showing source [2000, 5000) of a ten-second file, placed at 1s. The
 * window is deliberately not at the start of the file, so a mapping that
 * forgets `from` or `to` gives a different number rather than the same one.
 */
function doc(over: Partial<VideoElementType> = {}): TimelineDocument {
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
        ...over,
      }),
      still: imageElement({ trackId: "v0", startTime: 5000, duration: 1000 }),
    },
  });
}

const result = (over: Partial<ReverseResult> = {}): ReverseResult => ({
  localpath: REVERSED,
  durationMs: 3000,
  hasAudio: true,
  ...over,
});

function reversedDoc(): TimelineDocument {
  const d = doc();
  return applyReverse(d, "clip", reverseSnapshotOf(d.elements.clip)!, result());
}

const video = (d: TimelineDocument, id = "clip") =>
  d.elements[id] as VideoElementType;

describe("applyReverse", () => {
  it("points the clip at the reversed file over its whole window", () => {
    const after = video(reversedDoc());
    expect(after.localpath).toBe(REVERSED);
    expect(after.trim).toEqual({ startTime: 0, endTime: 3000 });
    expect(after.duration).toBe(3000);
    expect(after.reversed).toEqual({
      localpath: SOURCE,
      from: 2000,
      to: 5000,
      sourceDuration: 10000,
      isExistAudio: true,
    });
    expect(hasValidTrim(after)).toBe(true);
    expect(isReversed(after)).toBe(true);
    expect(isReversible(after)).toBe(false);
  });

  it("does not move the clip or anything beside it", () => {
    const before = doc();
    const after = reversedDoc();
    expect(spanOf(video(after))).toEqual(spanOf(video(before)));
    expect(after.elements.still).toEqual(before.elements.still);
  });

  it("keeps the speed, and so the span, of a retimed clip", () => {
    const d = doc({ speed: 2 });
    const after = applyReverse(
      d,
      "clip",
      reverseSnapshotOf(d.elements.clip)!,
      result(),
    );
    expect(video(after).speed).toBe(2);
    expect(spanOf(video(after))).toEqual(spanOf(video(d)));
  });

  it("takes the audio flag from the file it now plays", () => {
    const d = doc();
    const after = applyReverse(
      d,
      "clip",
      reverseSnapshotOf(d.elements.clip)!,
      result({ hasAudio: false }),
    );
    expect(video(after).isExistAudio).toBe(false);
    expect(video(after).reversed?.isExistAudio).toBe(true);
  });

  it("pads a file that came back a hair short, keeping the trim valid", () => {
    const d = doc();
    const after = applyReverse(
      d,
      "clip",
      reverseSnapshotOf(d.elements.clip)!,
      result({ durationMs: 2990 }),
    );
    expect(video(after).sourceDuration).toBe(3000);
    expect(hasValidTrim(video(after))).toBe(true);
  });

  describe("declines by identity", () => {
    it("for a missing id and for a clip that is not video", () => {
      const d = doc();
      const snap = reverseSnapshotOf(d.elements.clip)!;
      expect(applyReverse(d, "nope", snap, result())).toBe(d);
      expect(applyReverse(d, "still", snap, result())).toBe(d);
    });

    it("for a clip that is already reversed", () => {
      const d = reversedDoc();
      const snap = { localpath: REVERSED, trim: { startTime: 0, endTime: 3000 } };
      expect(applyReverse(d, "clip", snap, result({ localpath: "file:///x" }))).toBe(d);
    });

    it("when the clip was trimmed while the file was being made", () => {
      const d = doc();
      const stale = { localpath: SOURCE, trim: { startTime: 2000, endTime: 4000 } };
      expect(applyReverse(d, "clip", stale, result())).toBe(d);
    });

    it("when the clip was relinked while the file was being made", () => {
      const d = doc();
      const stale = {
        localpath: "file:///tmp/other.mp4",
        trim: { startTime: 2000, endTime: 5000 },
      };
      expect(applyReverse(d, "clip", stale, result())).toBe(d);
    });

    it("for an unusable result", () => {
      const d = doc();
      const snap = reverseSnapshotOf(d.elements.clip)!;
      expect(applyReverse(d, "clip", snap, result({ durationMs: 0 }))).toBe(d);
      expect(applyReverse(d, "clip", snap, result({ durationMs: NaN }))).toBe(d);
      expect(applyReverse(d, "clip", snap, result({ localpath: "" }))).toBe(d);
      expect(applyReverse(d, "clip", snap, result({ localpath: SOURCE }))).toBe(d);
    });
  });
});

describe("reverseSnapshotOf", () => {
  it("is null for anything that cannot be reversed", () => {
    const d = reversedDoc();
    expect(reverseSnapshotOf(d.elements.clip)).toBeNull();
    expect(reverseSnapshotOf(d.elements.still)).toBeNull();
    expect(reverseSnapshotOf(undefined)).toBeNull();
  });
});

describe("unreverse", () => {
  it("restores the forward clip exactly", () => {
    const before = doc();
    const back = unreverse(reversedDoc(), "clip");
    expect(back.elements.clip).toEqual(before.elements.clip);
    expect("reversed" in back.elements.clip).toBe(false);
  });

  it("saves byte-identically to a clip that was never reversed", () => {
    const back = unreverse(reversedDoc(), "clip");
    expect(JSON.stringify(back.elements.clip)).toBe(
      JSON.stringify(doc().elements.clip),
    );
  });

  it("maps an inner trim back through `to - r`", () => {
    // Reversed file time [500, 2500) is original [5000 - 2500, 5000 - 500).
    const d = reversedDoc();
    const trimmed: TimelineDocument = {
      ...d,
      elements: {
        ...d.elements,
        clip: {
          ...video(d),
          trim: { startTime: 500, endTime: 2500 },
          duration: 2000,
        },
      },
    };
    const back = video(unreverse(trimmed, "clip"));
    expect(back.trim).toEqual({ startTime: 2500, endTime: 4500 });
    expect(back.duration).toBe(2000);
    expect(hasValidTrim(back)).toBe(true);
  });

  it("gives each half of a split reversed clip its own window back", () => {
    // Split one second in. The left half plays the *end* of the original
    // window backwards, so it maps to [4000, 5000); the right half to
    // [2000, 4000).
    const split = splitClip(reversedDoc(), "clip", 2000, "right");
    expect(video(split, "clip").trim).toEqual({ startTime: 0, endTime: 1000 });
    expect(video(split, "right").reversed?.to).toBe(5000);

    const back = unreverseMany(split, ["clip", "right"]);
    expect(video(back, "clip").trim).toEqual({ startTime: 4000, endTime: 5000 });
    expect(video(back, "right").trim).toEqual({ startTime: 2000, endTime: 4000 });
    expect(video(back, "clip").localpath).toBe(SOURCE);
    expect(video(back, "right").localpath).toBe(SOURCE);
  });

  it("stays inside the original when the trim reaches into the padding", () => {
    const d = doc({ trim: { startTime: 0, endTime: 3000 }, sourceDuration: 3000 });
    const reversed = applyReverse(
      d,
      "clip",
      reverseSnapshotOf(d.elements.clip)!,
      result({ durationMs: 3010 }),
    );
    const reaching: TimelineDocument = {
      ...reversed,
      elements: {
        ...reversed.elements,
        clip: { ...video(reversed), trim: { startTime: 10, endTime: 3010 } },
      },
    };
    const back = video(unreverse(reaching, "clip"));
    expect(back.trim.startTime).toBeGreaterThanOrEqual(0);
    expect(back.trim.endTime).toBeLessThanOrEqual(3000);
    expect(hasValidTrim(back)).toBe(true);
  });

  it("declines by identity for a forward clip, an image and a missing id", () => {
    const d = doc();
    expect(unreverse(d, "clip")).toBe(d);
    expect(unreverse(d, "still")).toBe(d);
    expect(unreverse(d, "nope")).toBe(d);
    expect(unreverseMany(d, ["clip", "still"])).toBe(d);
  });
});
