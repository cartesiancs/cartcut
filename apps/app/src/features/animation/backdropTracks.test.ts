import { describe, expect, it } from "vitest";
import { animatableProperties } from "../../@types/timeline";
import { shapeElement } from "../renderer/testing";
import { setClipBackdropFx } from "../timeline/shapeOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";
import { addKeyframe, setTrackActive, toggleKeyframe } from "./keyframeOps";
import { carriesTrack, normalizeAnimation } from "./keyframes";

/**
 * A shape's backdrop animates under an effect's own track names.
 *
 * `intensity` and `fx:<key>` ride on the shape's `animation`, and are carried
 * exactly while the backdrop has something for them to drive: a plain shape
 * offers neither, and taking the backdrop away collects both.
 */

const PIXELATE = {
  presetId: "com.cartcut.pixelate",
  params: { size: 16, average: true },
  intensity: 80,
};

function doc(withBackdrop = true): TimelineDocument {
  const base = normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      face: shapeElement({ trackId: "v0", startTime: 1000, duration: 2000 }),
    },
  });
  return withBackdrop ? setClipBackdropFx(base, "face", PIXELATE) : base;
}

describe("a shape backdrop's tracks", () => {
  it("are offered only while the shape has a backdrop", () => {
    const plain = animatableProperties(doc(false).elements.face);
    expect(plain).not.toContain("intensity");
    expect(plain.some((p) => p.startsWith("fx:"))).toBe(false);

    const withFx = animatableProperties(doc().elements.face);
    expect(withFx).toContain("intensity");
    // Numbers only: a boolean parameter has nothing to interpolate.
    expect(withFx).toContain("fx:size");
    expect(withFx).not.toContain("fx:average");
  });

  it("key the backdrop's strength, seeded from what it is set to", () => {
    let next = setTrackActive(doc(), "face", "intensity", true, { atMs: 1000 });
    const seeded = (next.elements.face as any).animation.intensity;
    expect(seeded.isActivate).toBe(true);
    expect(seeded.x[0].p[1]).toBe(80);

    next = addKeyframe(next, "face", "intensity", "x", 1500, 20);
    expect((next.elements.face as any).animation.intensity.x).toHaveLength(2);
  });

  it("key a parameter, seeded from the backdrop's own value", () => {
    const next = setTrackActive(doc(), "face", "fx:size", true, { atMs: 1000 });
    expect((next.elements.face as any).animation["fx:size"].x[0].p[1]).toBe(16);
  });

  it("write the static value back into the backdrop when the last keyframe goes", () => {
    // The diamond: arm at the playhead, move the key to 40, then press the
    // diamond again to remove it. The backdrop is left holding the 40 the user
    // was looking at, not the 16 it held before the track was armed. The
    // shape starts at 1000, so the playhead is at 1500 inside it.
    let next = toggleKeyframe(doc(), "face", "fx:size", 1500, 30);
    next = addKeyframe(next, "face", "fx:size", "x", 500, 40);
    expect((next.elements.face as any).animation["fx:size"].x).toHaveLength(1);
    next = toggleKeyframe(next, "face", "fx:size", 1500, 30);
    expect((next.elements.face as any).animation["fx:size"]).toBeUndefined();
    expect((next.elements.face as any).backdropFx.params).toEqual({
      size: 40,
      average: true,
    });
  });

  it("are carried while the backdrop is there, and collected with it", () => {
    let next = setTrackActive(doc(), "face", "intensity", true);
    next = setTrackActive(next, "face", "fx:size", true);
    const shape = next.elements.face;
    expect(carriesTrack(shape, "intensity")).toBe(true);
    expect(carriesTrack(shape, "fx:size")).toBe(true);
    // Survives a load.
    expect((normalizeAnimation(shape) as any).animation["fx:size"]).toBeDefined();

    const cleared = setClipBackdropFx(next, "face", null).elements.face as any;
    expect(cleared.animation.intensity).toBeUndefined();
    expect(cleared.animation["fx:size"]).toBeUndefined();

    // A hand-edited file that left them behind has them collected on load.
    const orphaned = { ...cleared, animation: (shape as any).animation };
    expect(carriesTrack(orphaned, "intensity")).toBe(false);
    expect(carriesTrack(orphaned, "fx:size")).toBe(false);
    expect((normalizeAnimation(orphaned) as any).animation["fx:size"]).toBeUndefined();
  });

  it("decline on a shape with no backdrop", () => {
    const plain = doc(false);
    expect(setTrackActive(plain, "face", "intensity", true)).toBe(plain);
    expect(addKeyframe(plain, "face", "fx:size", "x", 0, 4)).toBe(plain);
  });
});
