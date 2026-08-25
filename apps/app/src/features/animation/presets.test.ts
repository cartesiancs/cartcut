import { describe, it, expect } from "vitest";
import { applyPreset, presetNames, presetProperty } from "./presets";
import {
  createTrack,
  normalizeDocument,
  SCHEMA_VERSION,
} from "../timeline/tracks";
import {
  videoElement,
  gifElement,
  shapeElement,
  audioElement,
} from "../renderer/testing";

function doc(elements: Record<string, any>, tracks = [["v1", "video"]] as any) {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: tracks.map(([id, kind]: any, index: number) =>
      createTrack(id, kind, index),
    ),
    elements,
  });
}

function clip(over: any = {}) {
  return videoElement({
    trackId: "v1",
    startTime: 0,
    duration: 4_000,
    sourceDuration: 4_000,
    trim: { startTime: 0, endTime: 4_000 },
    speed: 1,
    ...over,
  });
}

/** The authored keyframes on a lane, as `[timeMs, value]` pairs. */
function laneOf(document: any, id: string, property: string) {
  const list = document.elements[id]?.animation?.[property]?.x ?? [];
  return list.map((keyframe: any) => [keyframe.p[0], keyframe.p[1]]);
}

describe("applyPreset", () => {
  it("fade_in activates opacity and writes exactly two keyframes", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "fade_in", 250);

    expect(after.elements.a.animation.opacity.isActivate).toBe(true);
    expect(laneOf(after, "a", "opacity")).toEqual([
      [0, 0],
      [250, 100],
    ]);
  });

  it("fade_out is anchored to the clip's end", () => {
    // A 4000ms clip, a 250ms fade: 3750 -> 4000.
    const after = applyPreset(doc({ a: clip() }), "a", "fade_out", 250);

    expect(laneOf(after, "a", "opacity")).toEqual([
      [3_750, 100],
      [4_000, 0],
    ]);
  });

  it("zoom_in works in the tenths the scale track stores", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "zoom_in", 250);

    // 10 is unscaled, 12 is 120% — `transform.ts` divides by 10.
    expect(laneOf(after, "a", "scale")).toEqual([
      [0, 10],
      [250, 12],
    ]);
  });

  it("zoom_out runs the other way", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "zoom_out", 250);
    expect(laneOf(after, "a", "scale")).toEqual([
      [0, 12],
      [250, 10],
    ]);
  });

  it("clamps a preset longer than the clip rather than refusing it", () => {
    const short = doc({ a: clip({ duration: 200, sourceDuration: 200, trim: { startTime: 0, endTime: 200 } }) });
    const after = applyPreset(short, "a", "fade_in", 250);

    expect(laneOf(after, "a", "opacity")).toEqual([
      [0, 0],
      [200, 100],
    ]);
  });

  it("accounts for speed, since the span is what the viewer sees", () => {
    const fast = doc({ a: clip({ speed: 2 }) }); // 4000ms source, 2000ms span
    const after = applyPreset(fast, "a", "fade_out", 250);

    expect(laneOf(after, "a", "opacity")).toEqual([
      [1_750, 100],
      [2_000, 0],
    ]);
  });

  // ------------------------------------------------------- decline by identity

  it("returns the input by identity for a missing element", () => {
    const before = doc({ a: clip() });
    expect(applyPreset(before, "nope", "fade_in", 250)).toBe(before);
  });

  it("returns the input by identity for an unknown preset", () => {
    const before = doc({ a: clip() });
    expect(applyPreset(before, "a", "spin" as any, 250)).toBe(before);
  });

  it("returns the input by identity for a gif, which has no animation block", () => {
    const before = doc({ a: gifElement({ trackId: "v1" }) });
    expect(applyPreset(before, "a", "fade_in", 250)).toBe(before);
  });

  it("returns the input by identity for audio", () => {
    const before = doc({ a: audioElement({ trackId: "a1" }) }, [["a1", "audio"]]);
    expect(applyPreset(before, "a", "fade_in", 250)).toBe(before);
  });

  it("returns the input by identity for a scale preset on a shape", () => {
    // A shape animates opacity and nothing else.
    const before = doc({ a: shapeElement({ trackId: "v1" }) });
    expect(applyPreset(before, "a", "zoom_in", 250)).toBe(before);
  });

  it("still fades a shape, which does animate opacity", () => {
    const before = doc({ a: shapeElement({ trackId: "v1" }) });
    const after = applyPreset(before, "a", "fade_in", 250);
    expect(after).not.toBe(before);
    expect(after.elements.a.animation.opacity.isActivate).toBe(true);
  });
});

describe("the preset table", () => {
  it("names a property for every preset it offers", () => {
    for (const name of presetNames()) {
      expect(presetProperty(name)).not.toBeNull();
    }
  });
});
