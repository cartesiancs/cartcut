/**
 * The two decisions inside a thumbnail capture that can be wrong without
 * looking wrong.
 *
 * The DOM half is untestable here, as it is for `hoverPreviewOverlay`. What is
 * testable is where to seek and how big to draw, and both have a failure mode
 * that is silent: a seek target at or past the end waits for a `seeked` that
 * the spec never sends, and a canvas sized from the source keeps a 3600x2338
 * image to show at 55px.
 */

import { describe, it, expect } from "vitest";
import {
  seekTargetFor,
  thumbnailSize,
  THUMBNAIL_MAX_PX,
} from "./thumbnailCapture";

describe("seekTargetFor", () => {
  it("takes a frame a second in when there is room", () => {
    expect(seekTargetFor(10)).toBe(1);
    expect(seekTargetFor(3600)).toBe(1);
  });

  it("stays inside a clip too short for a second", () => {
    // The case the code this replaces hung on: it seeked to a flat 1s, the
    // `seeked` never arrived, and the promise never settled.
    expect(seekTargetFor(0.4)).toBeCloseTo(0.35, 10);
  });

  it("takes the first frame when there is no room to seek at all", () => {
    expect(seekTargetFor(0.03)).toBe(0);
  });

  it("takes the first frame when the container states no usable length", () => {
    // `Infinity` is what a `MediaRecorder` capture reports until something
    // forces a duration revision, and forcing one here would demux to the last
    // cluster of a multi-gigabyte file for a picture of its first second.
    expect(seekTargetFor(Infinity)).toBe(0);
    expect(seekTargetFor(NaN)).toBe(0);
    expect(seekTargetFor(0)).toBe(0);
    expect(seekTargetFor(-5)).toBe(0);
  });

  it("never lands at or past the end, for any duration", () => {
    // The invariant the two cases above are instances of. A target that is not
    // strictly inside the file is a wait that never completes.
    for (const duration of [0.01, 0.06, 0.1, 0.5, 1, 1.05, 2, 60, 7200]) {
      const target = seekTargetFor(duration);

      expect(target).toBeGreaterThanOrEqual(0);
      expect(target).toBeLessThan(duration);
    }
  });
});

describe("thumbnailSize", () => {
  it("fits the long edge to the cap and keeps the aspect", () => {
    const box = thumbnailSize(3600, 2338);

    expect(box).not.toBeNull();
    expect(Math.max(box!.w, box!.h)).toBe(THUMBNAIL_MAX_PX);
    expect(box!.w / box!.h).toBeCloseTo(3600 / 2338, 2);
  });

  it("measures orientation rather than just area", () => {
    // The harness check: a function that ignored its arguments and answered a
    // square would pass the case above.
    const landscape = thumbnailSize(3600, 2338);
    const portrait = thumbnailSize(2338, 3600);

    expect(landscape).not.toEqual(portrait);
    expect(landscape!.w).toBeGreaterThan(landscape!.h);
    expect(portrait!.h).toBeGreaterThan(portrait!.w);
  });

  it("is a large reduction on the footage this exists for", () => {
    const box = thumbnailSize(3600, 2338)!;
    const source = 3600 * 2338;

    expect((box.w * box.h) / source).toBeLessThan(0.01);
  });

  it("never upscales", () => {
    expect(thumbnailSize(32, 32)).toEqual({ w: 32, h: 32 });
    expect(thumbnailSize(120, 80)).toEqual({ w: 120, h: 80 });
  });

  it("declines a source that reported no size", () => {
    // A zero here means the decoder never produced a frame. Clamping instead
    // of refusing would cache a blank tile under that file's URL forever.
    expect(thumbnailSize(0, 0)).toBeNull();
    expect(thumbnailSize(1920, 0)).toBeNull();
    expect(thumbnailSize(NaN, 1080)).toBeNull();
    expect(thumbnailSize(Infinity, 1080)).toBeNull();
    expect(thumbnailSize(-1920, -1080)).toBeNull();
  });

  it("never rounds an edge away to nothing", () => {
    const box = thumbnailSize(4000, 3, 160);

    expect(box!.h).toBeGreaterThanOrEqual(1);
  });
});
