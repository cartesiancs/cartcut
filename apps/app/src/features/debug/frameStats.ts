/**
 * A counter for "how many times did that happen in the last second".
 *
 * This exists to settle one question with a number rather than an argument:
 * during playback, how many times per second does each redraw path actually
 * run? The answer should be the project's frame rate. If it is the display's
 * refresh rate instead, something upstream is waking every subscriber on a
 * cursor tick that changed nothing.
 *
 * Off by default and free when off: `count` is a boolean test and a return.
 * Nothing here is imported for its side effects — the reporter only starts once
 * something enables it.
 *
 * Toggle it from the console (or over CDP on port 9222, which is how you look
 * at a running editor without restarting it and losing the project):
 *
 *     __cartcutPerf.on()      // start reporting, and remember the choice
 *     __cartcutPerf.off()
 *     __cartcutPerf.snapshot() // the current second, without waiting for it
 *
 * `localStorage` carries the choice across a reload; a private window, a
 * cleared profile or a context that throws on access just leaves it off.
 */

const STORAGE_KEY = "cartcut.perfStats";

/** Read once at load. A throwing accessor means "off", never a crash. */
function storedPreference(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // A profile that refuses storage still gets the live toggle.
  }
}

/**
 * The hot-path guard.
 *
 * Deliberately a module-level `let` rather than a getter: `count` is called
 * from inside draw loops, and this has to compile down to a load and a branch.
 */
let enabled = storedPreference();

/** Occurrences this second, by name. */
let counts = new Map<string, number>();

/** Gaps between consecutive `mark`s this second, by name, in milliseconds. */
let intervals = new Map<string, number[]>();

/**
 * Latest value of a named quantity, rather than a count of events.
 *
 * "How many decoders are alive" is a level, not a rate: summing it over a
 * second says nothing, and the number at the end of the window is the answer.
 */
let gauges = new Map<string, number>();

/** When each named series was last marked, so the next mark has a gap. */
const lastMark = new Map<string, number>();

let reporter: ReturnType<typeof setInterval> | null = null;
let windowStart = 0;

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * Record one occurrence of `name`.
 *
 * The one function that goes in a draw path. Everything else here is setup.
 */
export function count(name: string): void {
  if (!enabled) {
    return;
  }
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

/** Record the current value of a level. The last one in a window wins. */
export function gauge(name: string, value: number): void {
  if (!enabled) {
    return;
  }
  gauges.set(name, value);
}

/**
 * Record one occurrence of `name` *and* the gap since the last one.
 *
 * For the playback loop, where the distribution of frame intervals says more
 * than their number: a loop running at 30Hz on average but alternating 8ms and
 * 58ms is not running at 30Hz in any sense the eye cares about.
 */
export function mark(name: string): void {
  if (!enabled) {
    return;
  }
  counts.set(name, (counts.get(name) ?? 0) + 1);

  const t = now();
  const previous = lastMark.get(name);
  lastMark.set(name, t);
  if (previous == null) {
    return;
  }

  const series = intervals.get(name);
  if (series == null) {
    intervals.set(name, [t - previous]);
  } else {
    series.push(t - previous);
  }
}

/** Nearest-rank percentile of an already-sorted copy. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

export type FrameStatsReport = {
  /** Length of the window actually measured, in ms — not assumed to be 1000. */
  elapsedMs: number;
  counts: Record<string, number>;
  /** Levels rather than rates — see `gauge`. */
  gauges: Record<string, number>;
  /** p50/p95/max of the gaps, for names recorded with `mark`. */
  intervals: Record<string, { p50: number; p95: number; max: number }>;
};

/** The current window's numbers, without clearing them. */
export function snapshot(): FrameStatsReport {
  const report: FrameStatsReport = {
    elapsedMs: Math.round(now() - windowStart),
    counts: Object.fromEntries(counts),
    gauges: Object.fromEntries(gauges),
    intervals: {},
  };

  for (const [name, series] of intervals) {
    const sorted = [...series].sort((a, b) => a - b);
    report.intervals[name] = {
      p50: Math.round(percentile(sorted, 50) * 10) / 10,
      p95: Math.round(percentile(sorted, 95) * 10) / 10,
      max: Math.round(sorted[sorted.length - 1] * 10) / 10,
    };
  }

  return report;
}

function resetWindow(): void {
  counts = new Map();
  intervals = new Map();
  // Gauges are deliberately *not* cleared: a level that nothing re-reported
  // this second is still the level.
  lastMark.clear();
  windowStart = now();
}

function report(): void {
  const snap = snapshot();
  resetWindow();

  // A window in which nothing happened is the idle case, and printing it once a
  // second forever would bury the windows that matter.
  if (Object.keys(snap.counts).length === 0) {
    return;
  }

  // Grouped so the counts and the interval distribution read as one table
  // rather than two objects.
  console.groupCollapsed(
    `[perf] ${snap.elapsedMs}ms — ${Object.entries(snap.counts)
      .map(([name, n]) => `${name}:${n}`)
      .join("  ")}`,
  );
  console.table(snap.counts);
  if (Object.keys(snap.gauges).length > 0) {
    console.table(snap.gauges);
  }
  if (Object.keys(snap.intervals).length > 0) {
    console.table(snap.intervals);
  }
  console.groupEnd();
}

export function enable(): void {
  if (enabled && reporter != null) {
    return;
  }
  enabled = true;
  remember(true);
  resetWindow();
  reporter = setInterval(report, 1000);
  console.info("[perf] frame stats on");
}

export function disable(): void {
  enabled = false;
  remember(false);
  if (reporter != null) {
    clearInterval(reporter);
    reporter = null;
  }
  resetWindow();
  console.info("[perf] frame stats off");
}

export function isEnabled(): boolean {
  return enabled;
}

/**
 * Install the console handle, and start reporting if the last session asked for
 * it.
 *
 * Called once from `index.ts`. Separate from module load so importing this from
 * a store does not start a timer inside a node test.
 */
export function installFrameStats(): void {
  (globalThis as Record<string, unknown>).__cartcutPerf = {
    on: enable,
    off: disable,
    snapshot,
    isEnabled,
  };

  if (enabled) {
    // `enabled` came from storage, so the reporter has not been started yet.
    enabled = false;
    enable();
  }
}
