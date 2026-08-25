import { describe, it, expect } from "vitest";
import { canRotateClips, normalizeDegrees, rotateClips } from "./rotateOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { audioElement, videoElement } from "../renderer/testing";

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

const oneVideo = (over: Record<string, any> = {}) =>
  doc([["track-1", "video"]], {
    a: videoElement({ trackId: "track-1", ...over }),
  });

describe("normalizeDegrees", () => {
  it("folds a full turn back to zero", () => {
    expect(normalizeDegrees(360)).toBe(0);
    expect(normalizeDegrees(450)).toBe(90);
  });

  it("keeps a negative turn inside [0, 360)", () => {
    expect(normalizeDegrees(-90)).toBe(270);
  });
});

describe("rotateClips", () => {
  it("turns a clip a quarter of the way round", () => {
    const after = rotateClips(oneVideo(), ["a"], 90, 0);

    expect(after.elements.a.rotation).toBe(90);
  });

  it("returns to zero after four quarter turns, not 360", () => {
    let next = oneVideo();
    for (let i = 0; i < 4; i += 1) {
      next = rotateClips(next, ["a"], 90, 0);
    }

    expect(next.elements.a.rotation).toBe(0);
  });

  it("wraps across the boundary", () => {
    const after = rotateClips(oneVideo({ rotation: 350 }), ["a"], 90, 0);

    expect(after.elements.a.rotation).toBe(80);
  });

  it("turns counter-clockwise on a negative delta", () => {
    const after = rotateClips(oneVideo(), ["a"], -90, 0);

    expect(after.elements.a.rotation).toBe(270);
  });

  it("turns every rotatable clip in the selection", () => {
    const before = doc([["track-1", "video"]], {
      a: videoElement({ trackId: "track-1", rotation: 0 }),
      b: videoElement({ trackId: "track-1", startTime: 5000, rotation: 45 }),
    });

    const after = rotateClips(before, ["a", "b"], 90, 0);

    expect(after.elements.a.rotation).toBe(90);
    expect(after.elements.b.rotation).toBe(135);
  });

  it("declines by identity when nothing can be turned", () => {
    const before = doc([["track-1", "audio"]], {
      a: audioElement({ trackId: "track-1" }),
    });

    expect(canRotateClips(before, ["a"])).toBe(false);
    expect(rotateClips(before, ["a"], 90, 0)).toBe(before);
  });

  it("declines by identity for an empty or unknown selection", () => {
    const before = oneVideo();

    expect(rotateClips(before, [], 90, 0)).toBe(before);
    expect(rotateClips(before, ["ghost"], 90, 0)).toBe(before);
  });

  it("ignores the audio in a mixed selection rather than declining", () => {
    const before = doc([["track-1", "video"], ["track-2", "audio"]], {
      a: videoElement({ trackId: "track-1" }),
      b: audioElement({ trackId: "track-2" }),
    });

    const after = rotateClips(before, ["a", "b"], 90, 0);

    expect(after.elements.a.rotation).toBe(90);
    expect((after.elements.b as any).rotation).toBeUndefined();
  });
});

describe("rotateClips with an animated rotation track", () => {
  const animated = () => {
    const before = oneVideo({ startTime: 1000 });
    (before.elements.a as any).animation.rotation = {
      isActivate: true,
      x: [],
      ax: [],
    };
    return before;
  };

  it("plants a keyframe as well as writing the static value", () => {
    const after = rotateClips(animated(), ["a"], 90, 1500);

    const track = (after.elements.a as any).animation.rotation;
    expect(track.x).toHaveLength(1);
    expect(after.elements.a.rotation).toBe(90);
  });

  // Keyframe times are relative to the clip's own start everywhere else that
  // authors one, so a clip starting at 1000ms rotated at 1500ms lands at 500.
  // `p` is the [time, value] point of a `CubicKeyframeType`.
  it("times the keyframe relative to the clip's start", () => {
    const after = rotateClips(animated(), ["a"], 90, 1500);

    const track = (after.elements.a as any).animation.rotation;
    expect(track.x[0].p).toEqual([500, 90]);
  });
});
