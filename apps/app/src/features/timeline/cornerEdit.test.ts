import { describe, it, expect } from "vitest";
import { editCornerRadius } from "./cornerEdit";
import { cornerRadiusAt } from "./cornerOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { setTrackActive } from "../animation/keyframeOps";
import { imageElement, shapeElement } from "../renderer/testing";

const BAKE_HZ = 60;

function doc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      image: imageElement({ trackId: "v0", startTime: 1000, duration: 2000 }),
      shape: shapeElement({ trackId: "v0", startTime: 3000, duration: 1000 }),
    },
  });
}

describe("editCornerRadius", () => {
  it("writes the static field when the track is not armed", () => {
    const d = editCornerRadius(doc(), "image", 24, 1500, BAKE_HZ);
    expect(d.elements.image).toMatchObject({ cornerRadius: 24 });
    // No track is minted by an edit: arming is the stopwatch's job.
    expect((d.elements.image as any).animation.cornerRadius).toBeUndefined();
  });

  it("keys the playhead and the field together when the track is armed", () => {
    let d = setTrackActive(doc(), "image", "cornerRadius", true, { atMs: 0 });
    d = editCornerRadius(d, "image", 40, 2000, BAKE_HZ);

    const track = (d.elements.image as any).animation.cornerRadius;
    // Clip-local: the playhead at 2000 is 1000 into a clip starting at 1000.
    expect(track.x.map((k: any) => k.p)).toEqual([
      [0, 0],
      [1000, 40],
    ]);
    expect(cornerRadiusAt(d.elements.image, 2000)).toBe(40);
    expect(d.elements.image).toMatchObject({ cornerRadius: 40 });
  });

  it("declines by identity on a clip that cannot be rounded", () => {
    const d = doc();
    expect(editCornerRadius(d, "shape", 24, 3500, BAKE_HZ)).toBe(d);
    expect(editCornerRadius(d, "nope", 24, 0, BAKE_HZ)).toBe(d);
  });

  it("declines by identity for the radius the clip already shows", () => {
    const rounded = editCornerRadius(doc(), "image", 24, 1500, BAKE_HZ);
    expect(editCornerRadius(rounded, "image", 24, 1500, BAKE_HZ)).toBe(rounded);
  });

  it("declines by identity for a value that is not a number", () => {
    const d = doc();
    expect(editCornerRadius(d, "image", Number.NaN, 1500, BAKE_HZ)).toBe(d);
  });
});
