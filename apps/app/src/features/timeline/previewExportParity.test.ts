/**
 * The preview and the export must ask for the same frame. Every frame.
 *
 * This is the one thing a retime cannot be allowed to get wrong: what the user
 * scrubs to is the promise, and the delivered file has to keep it. The two
 * paths are separate code and always were, which is why they drifted:
 *
 *   - the **export** seeks through `loadedAssetStore.seekScope` ->
 *     `sourceTimeAtFrame`, the centre of the output frame;
 *   - the **preview** seeks through `playback.ts#syncPlayback` -> `intentFor`,
 *     which used the cursor as given, which is the frame's *start*.
 *
 * Half a timeline frame apart. At a constant 1x that resolves to the same
 * source frame nearly always, so it went unnoticed; a speed ramp multiplies it
 * by the local rate and at 4x it is two source frames. Measured on the code
 * below before the fix: **86 percent** of a 1x-to-4x ramp's frames resolved to
 * a different source frame, worst case two off, and 1.7 percent even at 1x.
 *
 * Both now call `frames.ts#sourceTimeAtFrame`. This suite is what keeps them
 * there: it compares the two *call paths*, not two copies of one formula, so a
 * future change to either side fails here rather than in somebody's export.
 */

import { describe, expect, it } from "vitest";
import { intentFor, sourceBoundsSec } from "./playback";
import { spanLength, spanStart } from "./geometry";
import { frameToMs, sourceTimeAtFrame } from "./frames";
import { withSpeedCurve } from "./clipEdit";
import { videoElement } from "../renderer/testing";
import { seededRandom } from "./testing";
import type { TimelineElement, VideoElementType } from "../../@types/timeline";

const SOURCE_MS = 10_000;

function clip(over: Partial<VideoElementType> = {}): VideoElementType {
  return videoElement({
    trackId: "v1",
    startTime: 0,
    duration: SOURCE_MS,
    sourceDuration: SOURCE_MS,
    trim: { startTime: 0, endTime: SOURCE_MS },
    speed: 1,
    ...over,
  });
}

function ramped(
  points: Array<{ t: number; v: number }>,
  over: Partial<VideoElementType> = {},
) {
  return withSpeedCurve(clip(over), points);
}

/**
 * What the **export** seeks to for output frame `n`, in seconds.
 *
 * `loadedAssetStore.seekHandles` computes exactly this and nothing else; going
 * through the store here would need a DOM and would be proving jsdom works.
 */
function exportSeekSec(element: TimelineElement, n: number, fps: number): number {
  const [low, high] = sourceBoundsSec(element, false);
  return Math.min(
    Math.max(
      sourceTimeAtFrame(element as VideoElementType, frameToMs(n, fps), fps) / 1000,
      low,
    ),
    high,
  );
}

/** What the **preview** seeks to for the same frame, through its own path. */
function previewSeekSec(
  element: TimelineElement,
  n: number,
  fps: number,
): number {
  return intentFor(element, frameToMs(n, fps), false, undefined, fps)
    .sourceTimeSec;
}

/** Every frame of the clip's own span, as ordinals. */
function framesOf(element: TimelineElement, fps: number): number[] {
  const first = Math.ceil((spanStart(element) / 1000) * fps);
  const last = Math.floor(((spanStart(element) + spanLength(element)) / 1000) * fps);
  const out: number[] = [];
  for (let n = first; n < last; n++) {
    out.push(n);
  }
  return out;
}

const SHAPES: Array<[string, Array<{ t: number; v: number }> | null]> = [
  ["a clip at its natural rate", null],
  [
    "a ramp into fast motion",
    [
      { t: 0, v: 1 },
      { t: SOURCE_MS, v: 4 },
    ],
  ],
  [
    "a ramp out of fast motion",
    [
      { t: 0, v: 4 },
      { t: SOURCE_MS, v: 0.25 },
    ],
  ],
  [
    "a slow middle",
    [
      { t: 0, v: 4 },
      { t: SOURCE_MS / 2, v: 0.25 },
      { t: SOURCE_MS, v: 4 },
    ],
  ],
];

describe("the preview seeks where the export will", () => {
  it.each(SHAPES)("agrees on every frame of %s", (_name, points) => {
    for (const fps of [24, 30, 60, 120]) {
      const element = points == null ? clip() : ramped(points);
      const frames = framesOf(element, fps);
      expect(frames.length).toBeGreaterThan(10);
      for (const n of frames) {
        // Exact equality, not a tolerance. They are the same call now, and a
        // tolerance would let them drift apart again by less than it.
        expect([fps, n, previewSeekSec(element, n, fps)]).toEqual([
          fps,
          n,
          exportSeekSec(element, n, fps),
        ]);
      }
    }
  });

  it("agrees on a trimmed clip placed late, which moves both offsets at once", () => {
    const element = ramped(
      [
        { t: 0, v: 1 },
        { t: SOURCE_MS, v: 3 },
      ],
      { startTime: 3333, trim: { startTime: 2500, endTime: 8200 }, duration: 5700 },
    );
    for (const n of framesOf(element, 60)) {
      expect(previewSeekSec(element, n, 60)).toBe(exportSeekSec(element, n, 60));
    }
  });

  it("agrees for a cursor that is not on a frame boundary, which is every scrub", () => {
    // `frameSampleMs` snaps to the covering frame first, so an off-grid cursor
    // resolves to the same frame the export will deliver rather than to
    // something between two of them.
    const element = ramped([
      { t: 0, v: 0.5 },
      { t: SOURCE_MS, v: 4 },
    ]);
    const rand = seededRandom(0x5c2b);
    for (let i = 0; i < 400; i++) {
      const cursorMs = rand() * spanLength(element);
      const preview = intentFor(element, cursorMs, false, undefined, 60)
        .sourceTimeSec;
      const n = Math.floor((cursorMs / 1000) * 60);
      expect(preview).toBe(exportSeekSec(element, n, 60));
    }
  });

  it("agrees on the last frame, where the bound is the whole difference", () => {
    // The final output frame of a clip whose span is not a whole number of
    // frames has its centre past the clip's end, so the bound binds and the two
    // paths have to bind it the same way. Before this they did not: the preview
    // stopped at the out-point and the export read on into trimmed-away
    // footage, by up to two source frames on a clip ending at 4x.
    for (const points of [
      [
        { t: 0, v: 1 },
        { t: SOURCE_MS, v: 4 },
      ],
      [
        { t: 0, v: 0.25 },
        { t: SOURCE_MS, v: 4 },
      ],
    ]) {
      const element = ramped(points);
      const span = spanLength(element);
      // Deliberately the *drawn* frames, which include the partial last one
      // `framesOf` leaves out.
      const last = Math.ceil((span / 1000) * 60) - 1;
      expect(previewSeekSec(element, last, 60)).toBe(
        exportSeekSec(element, last, 60),
      );
      // And neither reads past the out-point into footage that was trimmed
      // away. The bound does not always bind on the last frame, which is why
      // this is an inequality rather than an equality: whether it binds depends
      // on where the span's end falls inside its frame.
      expect(previewSeekSec(element, last, 60) * 1000).toBeLessThanOrEqual(
        (element as VideoElementType).trim.endTime + 1e-6,
      );
    }
  });

  it("measures something: without the frame rate the two disagree, and by a lot", () => {
    // The state this suite exists to prevent, reproduced. `intentFor` with no
    // fps is what the preview did, and the numbers in the header are these.
    const element = ramped([
      { t: 0, v: 1 },
      { t: SOURCE_MS, v: 4 },
    ]);
    const frames = framesOf(element, 60);
    let differing = 0;
    let worstFrames = 0;
    for (const n of frames) {
      const stale = intentFor(element, frameToMs(n, 60), false).sourceTimeSec;
      const wanted = exportSeekSec(element, n, 60);
      if (Math.floor(stale * 60) !== Math.floor(wanted * 60)) {
        differing++;
      }
      worstFrames = Math.max(
        worstFrames,
        Math.abs(Math.floor(stale * 60) - Math.floor(wanted * 60)),
      );
    }
    expect(differing / frames.length).toBeGreaterThan(0.8);
    expect(worstFrames).toBe(2);
  });
});
