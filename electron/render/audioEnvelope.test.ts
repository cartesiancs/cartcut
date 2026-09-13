import { describe, expect, it } from "vitest";
import {
  ENVELOPE_TOLERANCE_DB,
  MAX_ENVELOPE_SEGMENTS,
  bakedLevelLane,
  envelopeFor,
  gainFromDb,
  simplifyEnvelope,
  volumeExprOf,
  type EnvelopePoint,
} from "./audioEnvelope";
// Reaching across the rootDir boundary is safe in a test file and nowhere else,
// for the reason stated at the top of `exportSettings.test.ts`.
import { gainFromDb as rendererGainFromDb } from "../../apps/app/src/features/timeline/audio";

/** An element carrying a live level track with the given baked samples. */
function withLane(ax: number[][], isActivate = true): any {
  return { filetype: "audio", startTime: 0, animation: { volumeDb: { isActivate, x: [], ax } } };
}

/** A baked ramp from `fromDb` to `toDb` across `ms`, at 60Hz. */
function ramp(fromDb: number, toDb: number, ms: number): number[][] {
  const step = 1000 / 60;
  const out: number[][] = [];
  for (let t = 0; t <= ms + 1e-9; t += step) {
    out.push([t, fromDb + ((toDb - fromDb) * t) / ms]);
  }
  return out;
}

describe("gainFromDb", () => {
  it("agrees with the renderer's twin exactly", () => {
    // The same hand-copy hazard `gainOf` has, and the same failure mode: a
    // divergence means the preview and the delivered file play a curve at
    // different levels, and nothing says so until someone listens.
    for (const db of [-200, -60, -59.9, -30, -6, -0.5, 0, 0.5, 6, 12, 40, NaN]) {
      expect(gainFromDb(db)).toBe(rendererGainFromDb(db));
    }
  });

  it("is exactly 1 at 0 dB and above it only by boosting", () => {
    expect(gainFromDb(0)).toBe(1);
    expect(gainFromDb(-60)).toBe(0);
    expect(gainFromDb(6)).toBeGreaterThan(1.99);
  });
});

describe("bakedLevelLane", () => {
  it("reads a live track", () => {
    expect(bakedLevelLane(withLane([[0, 0]]))).toEqual([[0, 0]]);
  });

  it("answers null for a track that is switched off", () => {
    // The gate that is easy to miss. A disarmed track still holds its curve,
    // and playing it would make the fader appear to do nothing.
    expect(bakedLevelLane(withLane([[0, -20]], false))).toBeNull();
  });

  it("answers null for no block, no track and no samples alike", () => {
    expect(bakedLevelLane({ filetype: "audio" })).toBeNull();
    expect(bakedLevelLane({ filetype: "audio", animation: {} })).toBeNull();
    expect(bakedLevelLane(withLane([]))).toBeNull();
    expect(bakedLevelLane(null)).toBeNull();
  });
});

describe("simplifyEnvelope", () => {
  const points = (lane: number[][]): EnvelopePoint[] =>
    lane.map(([tMs, db]) => ({ tMs, db }));

  it("collapses a straight dB ramp to its two ends", () => {
    // The whole reason the tolerance is measured in dB: a fade the user drew
    // as one straight line is one straight line, and emitting its sixty baked
    // samples would spend sixty expression terms saying so.
    const simplified = simplifyEnvelope(points(ramp(0, -40, 1000)), ENVELOPE_TOLERANCE_DB);
    expect(simplified).toHaveLength(2);
    expect(simplified[0].tMs).toBe(0);
    expect(simplified.at(-1)!.tMs).toBeCloseTo(1000, 0);
  });

  it("keeps the corner of a hold-then-fall", () => {
    const lane = [...ramp(0, 0, 500), ...ramp(0, -60, 500).map(([t, db]) => [t + 500, db])];
    const simplified = simplifyEnvelope(points(lane), ENVELOPE_TOLERANCE_DB);
    expect(simplified.length).toBeGreaterThanOrEqual(3);
    expect(simplified.length).toBeLessThan(8);
    // The corner survives, within the tolerance.
    const corner = simplified.find((p) => Math.abs(p.tMs - 500) < 20);
    expect(corner).toBeDefined();
  });

  it("stays within the tolerance everywhere it simplifies", () => {
    const lane: number[][] = [];
    for (let t = 0; t <= 4000; t += 1000 / 60) {
      lane.push([t, -30 + 30 * Math.sin(t / 250)]);
    }
    const all = points(lane);
    const simplified = simplifyEnvelope(all, ENVELOPE_TOLERANCE_DB);
    expect(simplified.length).toBeLessThan(all.length);

    for (const point of all) {
      let i = 0;
      while (i + 2 < simplified.length && simplified[i + 1].tMs < point.tMs) {
        i++;
      }
      const a = simplified[i];
      const b = simplified[i + 1] ?? a;
      const span = b.tMs - a.tMs;
      const on =
        span === 0 ? a.db : a.db + ((b.db - a.db) * (point.tMs - a.tMs)) / span;
      expect(Math.abs(point.db - on)).toBeLessThanOrEqual(
        ENVELOPE_TOLERANCE_DB + 1e-6,
      );
    }
  });

  it("returns short inputs untouched", () => {
    expect(simplifyEnvelope([], 0.1)).toEqual([]);
    const one = [{ tMs: 0, db: 0 }];
    expect(simplifyEnvelope(one, 0.1)).toEqual(one);
  });
});

describe("envelopeFor", () => {
  it("answers null for a clip with no envelope", () => {
    expect(envelopeFor({ filetype: "audio" })).toBeNull();
    expect(envelopeFor(withLane([[0, -6]], false))).toBeNull();
  });

  it("meets the segment cap by loosening the fit, never by truncating", () => {
    // Truncating would play the first 96 segments and then jump to whatever
    // the last one held, which is a different edit from the one the user made.
    // A coarser fit is the same edit, slightly rounded.
    const lane: number[][] = [];
    for (let t = 0; t <= 60_000; t += 1000 / 60) {
      // Deliberately pathological: nothing about this is a straight line.
      lane.push([t, -30 + 29 * Math.sin(t / 37) * Math.cos(t / 113)]);
    }
    const simplified = envelopeFor(withLane(lane))!;
    expect(simplified.length - 1).toBeLessThanOrEqual(MAX_ENVELOPE_SEGMENTS);
    // Still spans the whole clip: the tail was not cut off.
    expect(simplified[0].tMs).toBeCloseTo(0, 0);
    expect(simplified.at(-1)!.tMs).toBeGreaterThan(59_000);
  });
});

describe("volumeExprOf", () => {
  it("is balanced rather than a flat sum", () => {
    // The measured cliff: against the bundled ffmpeg 9.0 a flat `a+b+c+…`
    // evaluates at 96 terms and fails at 100, because the parser recurses once
    // per term. A balanced tree is log2(n) deep and was measured good to 2048.
    // Depth is the thing under test, so it is measured rather than assumed.
    const lane: number[][] = [];
    for (let i = 0; i <= 200; i++) {
      lane.push([i * 10, -40 + 40 * (i % 2)]);
    }
    const expr = volumeExprOf(envelopeFor(withLane(lane))!);

    let depth = 0;
    let worst = 0;
    for (const ch of expr) {
      if (ch === "(") {
        depth++;
        worst = Math.max(worst, depth);
      } else if (ch === ")") {
        depth--;
      }
    }
    expect(depth).toBe(0);
    // A flat fold of ~100 terms would nest ~100 deep. log2 keeps it small.
    expect(worst).toBeLessThan(24);
  });

  it("holds the first and last levels outside the curve", () => {
    const expr = volumeExprOf([
      { tMs: 1000, db: -6 },
      { tMs: 2000, db: 0 },
    ]);
    expect(expr).toContain(`lt(t,1)*${gainFromDb(-6)}`);
    expect(expr).toContain("gt(t,2)*1");
  });

  it("interpolates in dB, not in gain", () => {
    // The defect the parity test caught. A straight 0 to -40 dB fade is a
    // curve in gain, so a `pow` belongs in every segment; emitting
    // `(g0+k*(t-a))` instead played the quarter point 3.9 dB loud.
    const expr = volumeExprOf([
      { tMs: 0, db: 0 },
      { tMs: 4000, db: -40 },
    ]);
    expect(expr).toContain("pow(10,");
    expect(expr).toContain("/20)");
  });

  it("emits nothing for a stretch that is at or below the floor", () => {
    // -60 dB is a hard zero on both sides, not `10 ** (-60/20)` = 0.001, which
    // is plainly audible on a loud source. An omitted term sums to zero, so
    // narrowing the range is how the floor is applied.
    const expr = volumeExprOf([
      { tMs: 0, db: -60 },
      { tMs: 1000, db: -60 },
      { tMs: 2000, db: 0 },
    ]);
    // One segment survives: the rise out of silence, starting at its crossing.
    expect(expr.match(/between\(/g) ?? []).toHaveLength(1);
  });

  it("degenerates safely", () => {
    expect(volumeExprOf([])).toBe("1");
    expect(volumeExprOf([{ tMs: 0, db: -12 }])).toBe(`${gainFromDb(-12)}`);
  });
});
