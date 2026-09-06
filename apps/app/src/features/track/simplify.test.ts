import { describe, expect, it } from "vitest";
import { DEFAULT_TOLERANCE_PX, simplifyPath, type PathSample } from "./simplify";

function line(count: number, dx: number, dy: number): PathSample[] {
  return Array.from({ length: count }, (_, i) => ({
    tMs: i * 16,
    x: i * dx,
    y: i * dy,
  }));
}

describe("simplifyPath", () => {
  it("reduces a straight run to its endpoints", () => {
    expect(simplifyPath(line(60, 2, 1))).toEqual([
      { tMs: 0, x: 0, y: 0 },
      { tMs: 59 * 16, x: 118, y: 59 },
    ]);
  });

  it("keeps the frame the path turns on", () => {
    const samples: PathSample[] = [
      { tMs: 0, x: 0, y: 0 },
      { tMs: 16, x: 10, y: 0 },
      { tMs: 32, x: 20, y: 0 },
      { tMs: 48, x: 20, y: 10 },
      { tMs: 64, x: 20, y: 20 },
    ];

    const out = simplifyPath(samples);

    expect(out.map((sample) => sample.tMs)).toEqual([0, 32, 64]);
  });

  it("keeps both lanes on the same instants", () => {
    // `position` is a paired track: `lanesOf` gives it x and y, and every op in
    // keyframeOps writes them together. Thinning per lane would give the two
    // different keyframe times and interpolate x straight through a corner that
    // only shows in y.
    const samples: PathSample[] = [
      { tMs: 0, x: 0, y: 0 },
      { tMs: 16, x: 10, y: 0 },
      { tMs: 32, x: 20, y: 40 },
      { tMs: 48, x: 30, y: 0 },
      { tMs: 64, x: 40, y: 0 },
    ];

    const out = simplifyPath(samples);

    // The corner is a y-only feature, and it survives with its x alongside it.
    expect(out).toContainEqual({ tMs: 32, x: 20, y: 40 });
  });

  it("respects the tolerance", () => {
    const samples: PathSample[] = [
      { tMs: 0, x: 0, y: 0 },
      { tMs: 16, x: 10, y: 2 },
      { tMs: 32, x: 20, y: 0 },
    ];

    // The middle sample is 2px off the chord.
    expect(simplifyPath(samples, 1)).toHaveLength(3);
    expect(simplifyPath(samples, 5)).toHaveLength(2);
  });

  it("keeps every sample when the tolerance is zero", () => {
    const samples = line(20, 1, 1);

    expect(simplifyPath(samples, 0)).toEqual(samples);
  });

  it("copies rather than aliasing its input on the short paths", () => {
    const samples = line(2, 1, 1);

    const out = simplifyPath(samples);

    expect(out).toEqual(samples);
    expect(out).not.toBe(samples);
  });

  it("does not overflow on a track long enough to need thinning", () => {
    // Recursive RDP blows the stack on a monotone path of this length, which is
    // exactly the input that most needs simplifying.
    const samples: PathSample[] = Array.from({ length: 36_000 }, (_, i) => ({
      tMs: i * 8,
      x: i,
      y: Math.sin(i / 500) * 40,
    }));

    const out = simplifyPath(samples, DEFAULT_TOLERANCE_PX);

    expect(out.length).toBeGreaterThan(2);
    expect(out.length).toBeLessThan(samples.length);
  });

  it("does not collapse a pause into the move that follows it", () => {
    const samples: PathSample[] = [
      { tMs: 0, x: 10, y: 10 },
      { tMs: 16, x: 10, y: 10 },
      { tMs: 32, x: 10, y: 10 },
      { tMs: 48, x: 50, y: 10 },
    ];

    const out = simplifyPath(samples);

    expect(out.map((sample) => sample.tMs)).toContain(32);
  });
});
