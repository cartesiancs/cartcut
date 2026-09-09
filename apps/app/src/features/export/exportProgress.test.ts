import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { videoElement } from "../../features/renderer/testing";

/**
 * The singleton writes straight into the progress dialog, so the suite hands it
 * two elements and reads them back. Everything it decides — which phase it is
 * in, when the timer runs, what the two elements say — is observable that way,
 * and it is the wiring rather than the arithmetic that this file is for. The
 * arithmetic is covered in `features/export/eta.test.ts` and
 * `countdown.test.ts`.
 */
const bar = { style: { width: "" }, textContent: "", attributes: {} as Record<string, string> };
const line = { textContent: "" };

vi.stubGlobal("document", {
  querySelector: (selector: string) => {
    if (selector === "#progress") {
      return {
        style: bar.style,
        get textContent() {
          return bar.textContent;
        },
        set textContent(value: string) {
          bar.textContent = value;
        },
        setAttribute: (name: string, value: string) => {
          bar.attributes[name] = value;
        },
      };
    }
    if (selector === "#remainingTime") return line;
    return null;
  },
});

// The renderer always has these; Node does not, and vitest's fake timers
// install onto `globalThis`, so forwarding is enough for the interval to be
// driven by `advanceTimersByTime`.
vi.stubGlobal("window", {
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (id: unknown) => clearInterval(id as never),
});

const { renderProgress } = await import("./renderProgress");

const TOTAL_FRAMES = 600;
const FPS = 30;
const timeline = { a: videoElement({ startTime: 0, duration: 20_000 }) };

beforeEach(() => {
  // `performance` is not faked by default, and the singleton reads
  // `performance.now()` rather than `Date.now()` — deliberately, since it is
  // monotonic and an export can outlive a clock adjustment. Without it here the
  // fake clock advances while the code under test sees real time standing
  // still, and nothing ever clears the warm-up gate.
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"],
  });
  bar.style.width = "";
  bar.textContent = "";
  bar.attributes = {};
  line.textContent = "";
});

afterEach(() => {
  renderProgress.stop();
  vi.useRealTimers();
});

describe("renderProgress", () => {
  it("clears the previous run's numbers on begin", () => {
    bar.style.width = "73%";
    bar.textContent = "73%";
    line.textContent = "4m 12s left";

    renderProgress.begin(timeline, TOTAL_FRAMES, FPS);

    expect(bar.style.width).toBe("0%");
    expect(bar.textContent).toBe("0%");
    expect(bar.attributes["aria-valuenow"]).toBe("0");
    // The stale value used to sit here until the next export's first sample.
    expect(line.textContent).toBe("Estimating…");
  });

  it("holds the estimating label until the warm-up gates clear", () => {
    renderProgress.begin(timeline, TOTAL_FRAMES, FPS);

    for (let frame = 0; frame < 6; frame++) {
      vi.advanceTimersByTime(50);
      renderProgress.onFrame(frame, TOTAL_FRAMES);
    }
    vi.advanceTimersByTime(300);
    expect(line.textContent).toBe("Estimating…");
  });

  it("counts down once the estimate is trustworthy", () => {
    renderProgress.begin(timeline, TOTAL_FRAMES, FPS);

    for (let frame = 0; frame < 120; frame++) {
      vi.advanceTimersByTime(50);
      renderProgress.onFrame(frame, TOTAL_FRAMES);
    }
    vi.advanceTimersByTime(300);

    // 480 frames left at 50ms each is 24s, plus the flush tail.
    expect(line.textContent).toMatch(/^\d+s left$|^\d+m \d\ds left$/);
    const seconds = Number(/(\d+)s left/.exec(line.textContent)![1]);
    expect(seconds).toBeGreaterThan(15);
    expect(seconds).toBeLessThan(40);
  });

  it("keeps ticking while the frame loop is stalled", () => {
    renderProgress.begin(timeline, TOTAL_FRAMES, FPS);
    for (let frame = 0; frame < 120; frame++) {
      vi.advanceTimersByTime(50);
      renderProgress.onFrame(frame, TOTAL_FRAMES);
    }
    vi.advanceTimersByTime(300);
    const before = line.textContent;

    // No frames at all for three seconds — the old estimator froze here.
    vi.advanceTimersByTime(3_000);
    expect(line.textContent).not.toBe(before);
  });

  it("never lets the countdown run backwards", () => {
    renderProgress.begin(timeline, TOTAL_FRAMES, FPS);
    const seen: number[] = [];

    for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
      // Deliberately erratic: a slow patch in the middle is exactly what made
      // the old estimate swing up and down.
      vi.advanceTimersByTime(frame > 200 && frame < 260 ? 200 : 40);
      renderProgress.onFrame(frame, TOTAL_FRAMES);
      const match = /(?:(\d+)m )?(\d+)s left/.exec(line.textContent);
      if (match != null) {
        seen.push(Number(match[1] ?? 0) * 60 + Number(match[2]));
      }
    }

    expect(seen.length).toBeGreaterThan(10);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);
    }
  });

  it("shows the flush phase instead of reaching zero", () => {
    renderProgress.begin(timeline, TOTAL_FRAMES, FPS);
    for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
      vi.advanceTimersByTime(40);
      renderProgress.onFrame(frame, TOTAL_FRAMES);
    }

    renderProgress.finalizing();

    expect(bar.textContent).toBe("100%");
    expect(bar.style.width).toBe("100%");
    expect(bar.attributes["aria-valuenow"]).toBe("100");
    expect(line.textContent).toBe("Finalizing…");

    // And it stays there: FFmpeg is still muxing and nothing is animating, so
    // the ticker must be off rather than counting toward a number it does not
    // have.
    vi.advanceTimersByTime(5_000);
    expect(line.textContent).toBe("Finalizing…");
  });

  it("writes nothing more once stopped, from any phase", () => {
    renderProgress.begin(timeline, TOTAL_FRAMES, FPS);
    for (let frame = 0; frame < 120; frame++) {
      vi.advanceTimersByTime(50);
      renderProgress.onFrame(frame, TOTAL_FRAMES);
    }

    renderProgress.stop();
    line.textContent = "sentinel";
    bar.textContent = "sentinel";

    // A late frame from a loop that has not noticed the abort yet, and a timer
    // that must no longer be scheduled.
    renderProgress.onFrame(200, TOTAL_FRAMES);
    vi.advanceTimersByTime(5_000);

    expect(line.textContent).toBe("sentinel");
    expect(bar.textContent).toBe("sentinel");
  });

  it("is idempotent on the paths that race each other", () => {
    renderProgress.begin(timeline, TOTAL_FRAMES, FPS);
    // `PROCESSING_FINISH` and the click handler's `finally` arrive in either
    // order, and Cancel fires before `render:v2:cancelled` comes back.
    expect(() => {
      renderProgress.finalizing();
      renderProgress.finish();
      renderProgress.finish();
      renderProgress.stop();
      renderProgress.stop();
      renderProgress.finalizing();
    }).not.toThrow();
  });

  it("advances the bar by work done, not by frame count", () => {
    // The video covers the first half of a 20s project, so the first half of
    // the frames is worth more than half the work — a frame-counted bar would
    // read exactly 50% here.
    renderProgress.begin(
      { a: videoElement({ startTime: 0, duration: 10_000 }) },
      TOTAL_FRAMES,
      FPS,
    );
    for (let frame = 0; frame < TOTAL_FRAMES / 2; frame++) {
      vi.advanceTimersByTime(40);
      renderProgress.onFrame(frame, TOTAL_FRAMES);
    }
    expect(Number(bar.textContent.replace("%", ""))).toBeGreaterThan(55);
  });

  it("only ever puts a bare percentage in the bar", () => {
    // The e2e stall detector parses this element as a number and does not reset
    // its timer when the parse fails, so a label here would read as a hang.
    renderProgress.begin(timeline, TOTAL_FRAMES, FPS);
    const texts: string[] = [];
    for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
      vi.advanceTimersByTime(40);
      renderProgress.onFrame(frame, TOTAL_FRAMES);
      texts.push(bar.textContent);
    }
    renderProgress.finalizing();
    texts.push(bar.textContent);

    for (const text of texts) {
      expect(text).toMatch(/^\d+%$/);
    }
  });
});
