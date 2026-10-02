import { describe, expect, it } from "vitest";
import { joinRun, keptBy, positionAt } from "./trackPath";
import type { TrackSample } from "./tracker";

/** A track moving 10px right per 100ms, from (100, 50) at 1000ms. */
function track(count: number, fromMs = 1000): TrackSample[] {
  return Array.from({ length: count }, (_, i) => ({
    sourceMs: fromMs + i * 100,
    x: 100 + i * 10,
    y: 50,
    confidence: 0.9,
  }));
}

describe("positionAt", () => {
  it("answers a sample's own position at its instant", () => {
    expect(positionAt(track(5), 1200)).toEqual({ x: 120, y: 50 });
  });

  it("interpolates between two samples", () => {
    expect(positionAt(track(5), 1250)).toEqual({ x: 125, y: 50 });
  });

  it("answers nothing outside the span, or for no track", () => {
    expect(positionAt(track(5), 999)).toBeNull();
    expect(positionAt(track(5), 1401)).toBeNull();
    expect(positionAt([], 1000)).toBeNull();
  });
});

describe("keptBy", () => {
  const NEAR = 20;

  it("keeps what came before the frame for a click on the track", () => {
    const path = track(10);

    const kept = keptBy(path, 1500, { x: 152, y: 47 }, NEAR);

    expect(kept.map((s) => s.sourceMs)).toEqual([1000, 1100, 1200, 1300, 1400]);
  });

  it("judges the click against where the track was at that frame", () => {
    // 68px from the end of the track and 2px from where it was at 1200ms.
    const path = track(10);

    expect(keptBy(path, 1200, { x: 122, y: 50 }, NEAR)).toHaveLength(2);
  });

  it("drops the whole track for a click far from it", () => {
    expect(keptBy(track(10), 1500, { x: 400, y: 300 }, NEAR)).toEqual([]);
  });

  it("treats the near distance as inclusive", () => {
    const path = track(10);

    expect(keptBy(path, 1500, { x: 150, y: 50 + NEAR }, NEAR)).toHaveLength(5);
    expect(keptBy(path, 1500, { x: 150, y: 50 + NEAR + 0.01 }, NEAR)).toEqual(
      [],
    );
  });

  it("keeps all of it, by identity, for a run after its end near where it ended", () => {
    // The track ends at (190, 50) at 1900ms.
    const path = track(10);

    expect(keptBy(path, 2000, { x: 195, y: 55 }, NEAR)).toBe(path);
  });

  it("drops it for a click after its end on something else", () => {
    // The case the reach exists for: a short track of one thing, then a click
    // on another later in the clip, which must not join the two into one path.
    expect(keptBy(track(10), 2000, { x: 600, y: 400 }, NEAR)).toEqual([]);
  });

  it("reaches further the longer it has been since the last sample", () => {
    const path = track(10);
    // 100ms on: NEAR + 25 = 45px.
    expect(keptBy(path, 2000, { x: 190 + 44, y: 50 }, NEAR)).toBe(path);
    expect(keptBy(path, 2000, { x: 190 + 46, y: 50 }, NEAR)).toEqual([]);
    // 300ms on: NEAR + 75 = 95px, past the ceiling of 4 * NEAR = 80px.
    expect(keptBy(path, 2200, { x: 190 + 79, y: 50 }, NEAR)).toBe(path);
    expect(keptBy(path, 2200, { x: 190 + 81, y: 50 }, NEAR)).toEqual([]);
  });

  it("keeps nothing for a run seeded at or before its start", () => {
    expect(keptBy(track(10), 1000, { x: 100, y: 50 }, NEAR)).toEqual([]);
    expect(keptBy(track(10), 400, { x: 100, y: 50 }, NEAR)).toEqual([]);
  });

  it("replaces the sample at the seed frame rather than keeping both", () => {
    // The run's own first sample sits at the seed instant, so keeping the old
    // one there too would put two keyframes on one frame.
    const kept = keptBy(track(10), 1300, { x: 130, y: 50 }, NEAR);

    expect(kept[kept.length - 1].sourceMs).toBe(1200);
  });

  it("answers an empty track by identity", () => {
    const empty: TrackSample[] = [];

    expect(keptBy(empty, 1000, { x: 0, y: 0 }, NEAR)).toBe(empty);
  });
});

describe("joinRun", () => {
  it("puts the run after what was kept", () => {
    const kept = track(3);
    const run = track(2, 1300);

    const joined = joinRun(kept, run);

    expect(joined.map((s) => s.sourceMs)).toEqual([1000, 1100, 1200, 1300, 1400]);
  });

  it("answers the kept samples by identity for an empty run", () => {
    const kept = track(3);

    expect(joinRun(kept, [])).toBe(kept);
  });

  it("answers the run itself when nothing was kept", () => {
    const run = track(2);

    expect(joinRun([], run)).toBe(run);
  });
});
