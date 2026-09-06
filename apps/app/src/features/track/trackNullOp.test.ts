import { describe, expect, it } from "vitest";
import { NULL_PIVOT_SIZE } from "../element/nullElement";
import { sampleBaked } from "../animation/keyframes";
import { localSampleAt } from "../timeline/transform";
import {
  createTrack,
  normalizeDocument,
  SCHEMA_VERSION,
  type TimelineDocument,
} from "../timeline/tracks";
import type { PathSample } from "./simplify";
import { createTrackNull } from "./trackNullOp";

function emptyDoc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements: {},
  });
}

const PATH: PathSample[] = [
  { tMs: 0, x: 100, y: 200 },
  { tMs: 1000, x: 400, y: 200 },
];

function run(
  samples: readonly PathSample[] = PATH,
  over: Partial<Parameters<typeof createTrackNull>[1]> = {},
) {
  const doc = emptyDoc();
  const next = createTrackNull(doc, {
    samples,
    nullId: "null-1",
    newTrackId: "g1",
    bakeHz: 60,
    ...over,
  });
  return { doc, next, element: next.elements["null-1"] as any };
}

describe("createTrackNull", () => {
  it("creates a group named Track with its position track switched on", () => {
    const { element } = run();

    expect(element.filetype).toBe("group");
    expect(element.name).toBe("Track");
    expect(element.animation.position.isActivate).toBe(true);
  });

  it("seats the null at 0, so its keyframes are read to the left of the clip", () => {
    // `localSampleAt` falls back to the static value for a cursor before an
    // element's `startTime`. A null seated at the clip would have its curve
    // ignored everywhere before it, silently.
    const { element } = run(PATH, {
      samples: [
        { tMs: 5000, x: 100, y: 200 },
        { tMs: 6000, x: 400, y: 200 },
      ],
    });

    expect(element.startTime).toBe(0);
  });

  it("writes the pivot's top-left, not the tracked point", () => {
    // `localMatrixOf` rotates and scales about `w/2, h/2`, so the box has to be
    // backed off by half of itself for the *feature* to be where the null is.
    const { element } = run();
    const half = NULL_PIVOT_SIZE / 2;

    expect(sampleBaked(element.animation.position.ax, 0, 0)).toBeCloseTo(
      100 - half,
      4,
    );
    expect(sampleBaked(element.animation.position.ay, 0, 0)).toBeCloseTo(
      200 - half,
      4,
    );
  });

  it("puts the sampled transform on the tracked point at every instant", () => {
    // The claim the whole feature rests on: at any cursor, the centre of the
    // null's pivot box is where the tracker said the feature was.
    const { element } = run();
    const half = NULL_PIVOT_SIZE / 2;

    for (const [cursor, expected] of [
      [0, 100],
      [500, 250],
      [1000, 400],
    ] as const) {
      const local = localSampleAt(element, cursor);
      expect(local.x + half).toBeCloseTo(expected, 0);
      expect(local.y + half).toBeCloseTo(200, 0);
    }
  });

  it("seats the static location on the first sample too", () => {
    // So that switching the stopwatch off does not teleport whatever is
    // parented to the null.
    const { element } = run();
    const half = NULL_PIVOT_SIZE / 2;

    expect(element.location).toEqual({ x: 100 - half, y: 200 - half });
  });

  it("honours a pivot size the caller chooses", () => {
    const { element } = run(PATH, { size: 40 });

    expect(element.width).toBe(40);
    expect(sampleBaked(element.animation.position.ax, 0, 0)).toBeCloseTo(80, 4);
  });

  it("gives the bar the length it is told, not the path's", () => {
    // A group's span gates nothing, so this is only how much bar there is to
    // aim at when adding a keyframe by hand later.
    const { element } = run(PATH, { durationMs: 30_000 });

    expect(element.duration).toBe(30_000);
  });

  it("lands on a group track rather than the video one", () => {
    const { next, element } = run();
    const track = next.tracks.find((row) => row.id === element.trackId);

    expect(track?.kind).toBe("group");
  });

  it("declines by identity when there is nothing to write", () => {
    const doc = emptyDoc();

    expect(
      createTrackNull(doc, {
        samples: [],
        nullId: "null-1",
        newTrackId: "g1",
        bakeHz: 60,
      }),
    ).toBe(doc);
  });

  it("declines by identity when every sample is unusable", () => {
    const doc = emptyDoc();

    expect(
      createTrackNull(doc, {
        samples: [{ tMs: NaN, x: 1, y: 2 }],
        nullId: "null-1",
        newTrackId: "g1",
        bakeHz: 60,
      }),
    ).toBe(doc);
  });
});
