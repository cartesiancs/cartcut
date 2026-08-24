/**
 * Per-stage timing for the export frame loop.
 *
 * The loop is four serial stages and their costs differ by two orders of
 * magnitude, so "export is slow" is not actionable on its own. This measures
 * each one separately and prints percentiles, which is what tells you whether
 * the next change should touch decoding, compositing, or the pipe.
 *
 * Off unless `globalThis.__CARTCUT_PROFILE_EXPORT` is truthy — set it from the
 * devtools console before starting an export.
 */

/**
 * `pipe` is the *stall*: how long the loop waited for the oldest outstanding
 * frame before it was allowed to render another. It is not the cost of moving
 * one frame, which overlaps the next frame's work and so costs no wall clock.
 */
export type FrameStage = "seek" | "composite" | "capture" | "pipe";

const STAGES: FrameStage[] = ["seek", "composite", "capture", "pipe"];

export function isProfilingEnabled(): boolean {
  return Boolean(
    (globalThis as { __CARTCUT_PROFILE_EXPORT?: unknown })
      .__CARTCUT_PROFILE_EXPORT,
  );
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export interface FrameProfiler {
  /** Time `fn` and attribute it to `stage`. */
  measure<T>(stage: FrameStage, fn: () => T): T;
  /** Time an awaited `fn` and attribute it to `stage`. */
  measureAsync<T>(stage: FrameStage, fn: () => Promise<T>): Promise<T>;
  /** Close out a frame; prints a table every `reportEvery` frames. */
  endFrame(): void;
  /** Print whatever has accumulated. Called at the end of an export. */
  report(): void;
}

/** A profiler that costs nothing when disabled. */
const NOOP: FrameProfiler = {
  measure: (_stage, fn) => fn(),
  measureAsync: (_stage, fn) => fn(),
  endFrame: () => {},
  report: () => {},
};

export function createFrameProfiler(
  label = "export",
  reportEvery = 100,
): FrameProfiler {
  if (!isProfilingEnabled()) {
    return NOOP;
  }

  const samples: Record<FrameStage, number[]> = {
    seek: [],
    composite: [],
    capture: [],
    pipe: [],
  };
  let frames = 0;
  const startedAt = performance.now();

  const record = (stage: FrameStage, ms: number) => {
    samples[stage].push(ms);
  };

  const print = () => {
    const elapsedSec = (performance.now() - startedAt) / 1000;
    const rows: Record<string, Record<string, number>> = {};
    for (const stage of STAGES) {
      const sorted = [...samples[stage]].sort((a, b) => a - b);
      const total = sorted.reduce((sum, v) => sum + v, 0);
      rows[stage] = {
        "p50 ms": Number(percentile(sorted, 50).toFixed(2)),
        "p95 ms": Number(percentile(sorted, 95).toFixed(2)),
        "total s": Number((total / 1000).toFixed(2)),
        "share %": Number(((total / 1000 / elapsedSec) * 100).toFixed(1)),
      };
    }
    console.log(
      `[${label}] ${frames} frames in ${elapsedSec.toFixed(1)}s ` +
        `(${(frames / elapsedSec).toFixed(1)} fps)`,
    );
    console.table(rows);
  };

  return {
    measure(stage, fn) {
      const t0 = performance.now();
      try {
        return fn();
      } finally {
        record(stage, performance.now() - t0);
      }
    },
    async measureAsync(stage, fn) {
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        record(stage, performance.now() - t0);
      }
    },
    endFrame() {
      frames += 1;
      if (frames % reportEvery === 0) {
        print();
      }
    },
    report() {
      if (frames > 0) {
        print();
      }
    },
  };
}
