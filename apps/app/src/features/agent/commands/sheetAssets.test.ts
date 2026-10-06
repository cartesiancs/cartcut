import { describe, expect, it } from "vitest";

import { sheetAssets } from "./sheetAssets";
import { imageElement, textElement, videoElement } from "../../renderer/testing";
import { addTransition } from "../../timeline/transitionOps";
import { SCHEMA_VERSION, createTrack, normalizeDocument } from "../../timeline/tracks";
import type { Timeline } from "../../../@types/timeline";

function clip(startTime: number, trimIn: number, trimOut: number) {
  return videoElement({
    trackId: "v0",
    startTime,
    duration: trimOut - trimIn,
    trim: { startTime: trimIn, endTime: trimOut },
    sourceDuration: 10_000,
  });
}

describe("sheetAssets", () => {
  it("decodes only the videos an instant of the sheet shows", () => {
    const assets: Timeline = {
      early: clip(0, 0, 2000),
      middle: clip(2000, 0, 2000),
      late: clip(8000, 0, 2000),
    };
    const { assets: kept, videos } = sheetAssets(assets, [500, 2500]);
    expect(Object.keys(kept).sort()).toEqual(["early", "middle"]);
    expect(videos).toBe(2);
  });

  it("keeps everything that is not a video, whenever it shows", () => {
    const assets: Timeline = {
      photo: imageElement({ startTime: 9000, duration: 500 }),
      title: textElement({ startTime: 9000, duration: 500 }),
      clip: clip(9000, 0, 500),
    };
    const { assets: kept, videos } = sheetAssets(assets, [100]);
    expect(Object.keys(kept).sort()).toEqual(["photo", "title"]);
    expect(videos).toBe(0);
  });

  it("decodes a clip a transition holds on screen past its out-point", () => {
    const doc = addTransition(
      normalizeDocument({
        schemaVersion: SCHEMA_VERSION,
        tracks: [createTrack("v0", "video", 0)],
        elements: { a: clip(0, 2000, 6000), b: clip(4000, 2000, 6000) },
      }),
      "t1",
      "a",
      "b",
      "cross",
      800,
      "center",
    );
    // `a` ends at 4000 and the transition runs to 4400.
    const { assets: kept } = sheetAssets(doc.elements, [4200]);
    expect(Object.keys(kept)).toContain("a");
    expect(Object.keys(kept)).toContain("b");
    expect(Object.keys(sheetAssets(doc.elements, [5000]).assets)).not.toContain("a");
  });

  it("decodes nothing for a sheet of instants no video covers", () => {
    const { videos } = sheetAssets({ clip: clip(0, 0, 1000) }, [1000, 5000]);
    expect(videos).toBe(0);
  });
});
