import { describe, expect, it } from "vitest";
import { sampleBaked } from "../animation/keyframes";
import { laneKeyframes, positionTrackFrom } from "./keyframeTrack";
import type { PathSample } from "./simplify";

const BAKE_HZ = 60;

describe("laneKeyframes", () => {
  it("collapses both handles when there is only one keyframe", () => {
    const [only] = laneKeyframes([{ tMs: 100, x: 5, y: 9 }], "x");

    expect(only.p).toEqual([100, 5]);
    expect(only.cs).toEqual([100, 5]);
    expect(only.ce).toEqual([100, 5]);
  });

  it("puts the handles a third of the way along the chord", () => {
    // A cubic whose controls are evenly spaced along the straight line between
    // its anchors *is* that line. That is what makes the interpolation between
    // two measurements linear instead of eased.
    const [a, b] = laneKeyframes(
      [
        { tMs: 0, x: 0, y: 0 },
        { tMs: 300, x: 90, y: 0 },
      ],
      "x",
    );

    expect(a.ce).toEqual([100, 30]);
    expect(b.cs).toEqual([200, 60]);
    expect(a.cs).toEqual([0, 0]);
    expect(b.ce).toEqual([300, 90]);
  });
});

describe("positionTrackFrom", () => {
  it("bakes a straight move to a straight ramp", () => {
    const samples: PathSample[] = [
      { tMs: 0, x: 0, y: 100 },
      { tMs: 1000, x: 300, y: 100 },
    ];

    const track = positionTrackFrom(samples, BAKE_HZ);

    expect(track).not.toBeNull();
    // If the handles were flat, the midpoint would ease and read well under
    // 150 — an ease-in-out is at 150 only by symmetry, but the quarter point
    // would be far off. Check both.
    expect(sampleBaked(track!.ax, 500, 0)).toBeCloseTo(150, 0);
    expect(sampleBaked(track!.ax, 250, 0)).toBeCloseTo(75, 0);
    expect(sampleBaked(track!.ay, 500, 0)).toBeCloseTo(100, 0);
  });

  it("switches the track on", () => {
    const track = positionTrackFrom([{ tMs: 0, x: 1, y: 2 }], BAKE_HZ);

    expect(track?.isActivate).toBe(true);
  });

  it("declines on no samples", () => {
    expect(positionTrackFrom([], BAKE_HZ)).toBeNull();
  });

  it("drops samples that are not finite", () => {
    const track = positionTrackFrom(
      [
        { tMs: 0, x: 0, y: 0 },
        { tMs: NaN, x: 10, y: 10 },
        { tMs: 100, x: Infinity, y: 10 },
        { tMs: 200, x: 20, y: 20 },
      ],
      BAKE_HZ,
    );

    expect(track?.x.map((keyframe) => keyframe.p[0])).toEqual([0, 200]);
  });

  it("sorts, and lets the later sample win a tie", () => {
    // `requestVideoFrameCallback` reports presentation time, and a repeated or
    // out-of-order mediaTime at a seek boundary is a thing that happens.
    // `bakeTrack` takes a strictly increasing list as a precondition.
    const track = positionTrackFrom(
      [
        { tMs: 200, x: 20, y: 0 },
        { tMs: 0, x: 0, y: 0 },
        { tMs: 200, x: 25, y: 0 },
        { tMs: 100, x: 10, y: 0 },
      ],
      BAKE_HZ,
    );

    expect(track?.x.map((keyframe) => keyframe.p)).toEqual([
      [0, 0],
      [100, 10],
      [200, 25],
    ]);
  });

  it("keeps both lanes on the same keyframe times", () => {
    const track = positionTrackFrom(
      [
        { tMs: 0, x: 0, y: 5 },
        { tMs: 50, x: 3, y: 9 },
        { tMs: 90, x: 7, y: 1 },
      ],
      BAKE_HZ,
    );

    expect(track?.x.map((keyframe) => keyframe.p[0])).toEqual(
      track?.y.map((keyframe) => keyframe.p[0]),
    );
  });
});
