import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { videoElement } from "../renderer/testing";
import { exportStore } from "../../states/exportStore";

/**
 * The singleton publishes into `exportStore`, so the suite reads it back from
 * there. Everything it decides — which phase it is in, when the timer runs,
 * what the two numbers say — is observable that way, and it is the wiring
 * rather than the arithmetic that this file is for. The arithmetic is covered
 * in `eta.test.ts` and `countdown.test.ts`.
 *
 * No `document` stub any more: this used to write into `#progress` and
 * `#remainingTime` inside a Bootstrap dialog, and that dialog is gone.
 */

// The renderer always has these; Node does not, and vitest's fake timers
// install onto `globalThis`, so forwarding is enough for the interval to be
// driven by `advanceTimersByTime`.
vi.stubGlobal("window", {
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (id: unknown) => clearInterval(id as never),
});

const { exportProgress } = await import("./exportProgress");

const TOTAL_FRAMES = 600;
const FPS = 30;
const timeline = { a: videoElement({ startTime: 0, duration: 20_000 }) };

const state = () => exportStore.getState();
/** Whole seconds left, or null while estimating or finalizing. */
const secondsLeft = () => {
  const ms = state().remainingMs;
  return ms == null ? null : Math.round(ms / 1000);
};

/** What `exportSession` does: reset the estimate, then set the phase running. */
function beginExport(frames = TOTAL_FRAMES, doc = timeline) {
  exportProgress.begin(doc, frames, FPS);
  exportStore.getState().begin("/tmp/out.mp4");
}

beforeEach(() => {
  // `performance` is not faked by default, and the singleton reads
  // `performance.now()` rather than `Date.now()` — deliberately, since it is
  // monotonic and an export can outlive a clock adjustment. Without it here the
  // fake clock advances while the code under test sees real time standing
  // still, and nothing ever clears the warm-up gate.
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"],
  });
  const initial = exportStore.getInitialState();
  exportStore.setState({
    phase: initial.phase,
    percent: initial.percent,
    remainingMs: initial.remainingMs,
    destination: initial.destination,
  });
});

afterEach(() => {
  exportProgress.stop();
  vi.useRealTimers();
});

describe("exportProgress", () => {
  it("resets without settling the phase the session just set", () => {
    // The trap this pins: `begin` used to call `stop()`, and `stop` now
    // dispatches `settled`. `exportSession` calls `exportProgress.begin` one
    // line *before* `exportStore.begin`, so a `settled` in here would knock the
    // phase back to idle and the title-bar button would sit as a pill for the
    // whole export.
    beginExport();

    expect(state().phase).toBe("running");
    expect(state().percent).toBe(0);
    expect(state().remainingMs).toBeNull();
  });

  it("clears the previous run's numbers on begin", () => {
    beginExport();
    for (let frame = 0; frame < 120; frame++) {
      vi.advanceTimersByTime(50);
      exportProgress.onFrame(frame, TOTAL_FRAMES);
    }
    exportProgress.stop();

    beginExport();

    expect(state().percent).toBe(0);
    // The stale value used to sit here until the next export's first sample.
    expect(state().remainingMs).toBeNull();
  });

  it("has no estimate until the warm-up gates clear", () => {
    beginExport();

    for (let frame = 0; frame < 6; frame++) {
      vi.advanceTimersByTime(50);
      exportProgress.onFrame(frame, TOTAL_FRAMES);
    }
    vi.advanceTimersByTime(300);
    expect(state().remainingMs).toBeNull();
  });

  it("counts down once the estimate is trustworthy", () => {
    beginExport();

    for (let frame = 0; frame < 120; frame++) {
      vi.advanceTimersByTime(50);
      exportProgress.onFrame(frame, TOTAL_FRAMES);
    }
    vi.advanceTimersByTime(300);

    // 480 frames left at 50ms each is 24s, plus the flush tail.
    const seconds = secondsLeft();
    expect(seconds).not.toBeNull();
    expect(seconds!).toBeGreaterThan(15);
    expect(seconds!).toBeLessThan(40);
  });

  it("keeps ticking while the frame loop is stalled", () => {
    beginExport();
    for (let frame = 0; frame < 120; frame++) {
      vi.advanceTimersByTime(50);
      exportProgress.onFrame(frame, TOTAL_FRAMES);
    }
    vi.advanceTimersByTime(300);
    const before = secondsLeft();

    // No frames at all for three seconds — the old estimator froze here.
    vi.advanceTimersByTime(3_000);
    expect(secondsLeft()).not.toBe(before);
  });

  it("never lets the countdown run backwards", () => {
    beginExport();
    const seen: number[] = [];

    for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
      // Deliberately erratic: a slow patch in the middle is exactly what made
      // the old estimate swing up and down.
      vi.advanceTimersByTime(frame > 200 && frame < 260 ? 200 : 40);
      exportProgress.onFrame(frame, TOTAL_FRAMES);
      const seconds = secondsLeft();
      if (seconds != null) {
        seen.push(seconds);
      }
    }

    expect(seen.length).toBeGreaterThan(10);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);
    }
  });

  it("reaches 100 and hands over to the flush phase", () => {
    beginExport();
    for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
      vi.advanceTimersByTime(40);
      exportProgress.onFrame(frame, TOTAL_FRAMES);
    }

    exportProgress.finalizing();

    expect(state().percent).toBe(100);
    expect(state().phase).toBe("finalizing");
    // `null` is what the button draws as "Finalizing…".
    expect(state().remainingMs).toBeNull();

    // And it stays there: FFmpeg is still muxing and nothing is animating, so
    // the ticker must be off rather than counting toward a number it does not
    // have.
    vi.advanceTimersByTime(5_000);
    expect(state().remainingMs).toBeNull();
    expect(state().percent).toBe(100);
  });

  it("settles the phase and writes nothing more once stopped", () => {
    beginExport();
    for (let frame = 0; frame < 120; frame++) {
      vi.advanceTimersByTime(50);
      exportProgress.onFrame(frame, TOTAL_FRAMES);
    }

    exportProgress.stop();
    expect(state().phase).toBe("idle");

    const listener = vi.fn();
    const unsubscribe = exportStore.subscribe(listener);

    // A late frame from a loop that has not noticed the abort yet, and a timer
    // that must no longer be scheduled.
    exportProgress.onFrame(200, TOTAL_FRAMES);
    vi.advanceTimersByTime(5_000);

    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });

  it("is idempotent on the paths that race each other", () => {
    beginExport();
    // `PROCESSING_FINISH` and the click handler's `finally` arrive in either
    // order, and Cancel fires before `render:v2:cancelled` comes back.
    expect(() => {
      exportProgress.finalizing();
      exportProgress.finish();
      exportProgress.finish();
      exportProgress.stop();
      exportProgress.stop();
      exportProgress.finalizing();
    }).not.toThrow();

    expect(state().phase).toBe("idle");
  });

  it("declines to start a flush phase when nothing is running", () => {
    exportProgress.finalizing();
    expect(state().phase).toBe("idle");
  });

  it("advances the bar by work done, not by frame count", () => {
    // The video covers the first half of a 20s project, so the first half of
    // the frames is worth more than half the work — a frame-counted bar would
    // read exactly 50% here.
    beginExport(TOTAL_FRAMES, {
      a: videoElement({ startTime: 0, duration: 10_000 }),
    });
    for (let frame = 0; frame < TOTAL_FRAMES / 2; frame++) {
      vi.advanceTimersByTime(40);
      exportProgress.onFrame(frame, TOTAL_FRAMES);
    }
    expect(state().percent).toBeGreaterThan(55);
  });

  it("keeps the percentage inside 0..100 for the whole run", () => {
    beginExport();
    const seen: number[] = [];
    for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
      vi.advanceTimersByTime(40);
      exportProgress.onFrame(frame, TOTAL_FRAMES);
      seen.push(state().percent);
    }
    exportProgress.finalizing();
    seen.push(state().percent);

    for (const percent of seen) {
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThanOrEqual(100);
    }
    expect(seen[seen.length - 1]).toBe(100);
  });
});
