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

  const LATE: PathSample[] = [
    { tMs: 5000, x: 100, y: 200 },
    { tMs: 6000, x: 400, y: 260 },
  ];

  it("seats the null on the tracked span, not at 0", () => {
    const { element } = run(LATE, { endMs: 6016 });

    expect(element.startTime).toBe(5000);
    expect(element.duration).toBe(1016);
  });

  it("stores the keyframes relative to the null's start", () => {
    // Keyframe times are clip-local. Left absolute, the curve would start a
    // whole `startTime` late and the bar would show the wrong frames.
    const { element } = run(LATE, { endMs: 6016 });
    const { x } = element.animation.position;

    expect(x[0].p[0]).toBe(0);
    expect(x[x.length - 1].p[0]).toBe(1000);
  });

  it("answers what a null at 0 would, before, inside and after its bar", () => {
    // Before its `startTime` the null reads its static `location`, and past its
    // end nothing gates it. Both have to give what the path says, or a child
    // parented to the null jumps on the frame the bar begins or ends.
    const { element } = run(LATE, { endMs: 6016 });
    const half = NULL_PIVOT_SIZE / 2;

    for (const [cursor, x, y] of [
      [0, 100, 200],
      [4999, 100, 200],
      [5000, 100, 200],
      [5500, 250, 230],
      [6000, 400, 260],
      [6016, 400, 260],
      [20_000, 400, 260],
    ] as const) {
      const local = localSampleAt(element, cursor);
      expect(local.x + half).toBeCloseTo(x, 0);
      expect(local.y + half).toBeCloseTo(y, 0);
    }
  });

  it("starts on the earliest sample whatever order they arrive in", () => {
    const { element } = run([LATE[1], LATE[0]], { endMs: 6016 });

    expect(element.startTime).toBe(5000);
    expect(element.location).toEqual({
      x: 100 - NULL_PIVOT_SIZE / 2,
      y: 200 - NULL_PIVOT_SIZE / 2,
    });
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

  it("ends the bar where it is told", () => {
    const { element } = run(PATH, { endMs: 1033 });

    expect(element.duration).toBe(1033);
  });

  it("never ends the bar before the last keyframe", () => {
    // An end short of the path, or none at all, would leave keyframes past the
    // bar, which is the clipped null this op exists to stop making.
    expect(run(PATH, { endMs: 400 }).element.duration).toBe(1000);
    expect(run(PATH).element.duration).toBe(1000);
    expect(run(PATH, { endMs: NaN }).element.duration).toBe(1000);
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
