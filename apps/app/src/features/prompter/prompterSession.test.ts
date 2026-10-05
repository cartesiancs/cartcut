/**
 * The prompter's frame loop, driven by hand.
 *
 * The scheduler is a queue the test drains one frame at a time and the clock
 * is a number the test moves, so every offset below is the exact value the
 * panel would have painted on that frame.
 */

import { describe, expect, it } from "vitest";

import type { FrameScheduler } from "../caption/previewLoop";
import { BASE_LINES_PER_SECOND, MAX_FRAME_MS } from "./prompterScroll";
import {
  PrompterSession,
  type PrompterMeasure,
  type PrompterState,
} from "./prompterSession";

const LINE = 40;

function harness(initial: Partial<PrompterMeasure> = {}) {
  let nextId = 1;
  const queue = new Map<number, () => void>();
  const scheduler: FrameScheduler = {
    request: (callback) => {
      const id = nextId++;
      queue.set(id, callback);
      return id;
    },
    cancel: (id) => {
      queue.delete(id);
    },
  };

  const clock = { now: 0 };
  const ruler: PrompterMeasure = {
    content: 2_400,
    viewport: 400,
    line: LINE,
    ...initial,
  };
  const applied: number[] = [];
  const states: PrompterState[] = [];

  const session = new PrompterSession({
    scheduler,
    now: () => clock.now,
    measure: () => ({ ...ruler }),
    apply: (offset) => applied.push(offset),
    onState: (state) => states.push(state),
  });

  /** Advance the clock by `ms` and run the one frame that is pending. */
  const frame = (ms: number) => {
    clock.now += ms;
    const pending = [...queue.entries()];
    queue.clear();
    for (const [, callback] of pending) {
      callback();
    }
  };

  return { session, ruler, applied, states, frame, pending: () => queue.size };
}

/** Pixels per millisecond at `speed`. */
const rate = (speed: number) => (speed * BASE_LINES_PER_SECOND * LINE) / 1000;

describe("PrompterSession", () => {
  it("starts at the top and moves at once", () => {
    const h = harness();
    h.session.start(1);
    expect(h.applied).toEqual([0]);
    expect(h.session.current).toMatchObject({ running: true, paused: false });
    expect(h.pending()).toBe(1);

    // The first frame only sets the clock; the next one moves.
    h.frame(16);
    expect(h.session.position).toBe(0);
    h.frame(50);
    expect(h.session.position).toBeCloseTo(50 * rate(1), 9);
  });

  it("moves exactly twice as far at 2.0x over the same frames", () => {
    const one = harness();
    const two = harness();
    one.session.start(1);
    two.session.start(2);
    for (const ms of [16, 16, 17, 16, 33, 16]) {
      one.frame(ms);
      two.frame(ms);
    }
    expect(one.session.position).toBeGreaterThan(0);
    expect(two.session.position).toBeCloseTo(one.session.position * 2, 9);
  });

  it("counts no more than MAX_FRAME_MS of a stalled frame", () => {
    const h = harness();
    h.session.start(1);
    h.frame(16);
    h.frame(5_000);
    expect(h.session.position).toBeCloseTo(MAX_FRAME_MS * rate(1), 9);
  });

  it("holds still while its tab is hidden and does not count the time away", () => {
    const h = harness();
    h.session.start(1);
    h.frame(16);
    h.frame(50);
    const before = h.session.position;

    h.ruler.viewport = 0;
    h.ruler.content = 0;
    h.frame(16);
    h.frame(16);
    expect(h.session.position).toBe(before);
    // Still waiting for the tab to come back rather than given up.
    expect(h.pending()).toBe(1);

    h.ruler.viewport = 400;
    h.ruler.content = 2_400;
    h.frame(60_000);
    // The first frame back only sets the clock again.
    expect(h.session.position).toBe(before);
    h.frame(20);
    expect(h.session.position).toBeCloseTo(before + 20 * rate(1), 9);
  });

  it("keeps the reader's place as a fraction when the stage is resized", () => {
    const h = harness();
    h.session.start(1);
    h.frame(16);
    h.session.nudge(500); // max is 2000, so a quarter of the way
    h.ruler.content = 1_200; // narrower window, smaller type: max is 800
    h.frame(0);
    expect(h.session.position).toBeCloseTo(200, 9);
  });

  it("keeps the place on a resize while paused, with no frame running", () => {
    const h = harness();
    h.session.start(1);
    h.frame(16);
    h.session.nudge(1_000); // half of max 2000
    h.session.togglePause();
    expect(h.pending()).toBe(0);

    h.ruler.content = 1_400; // max is 1000
    h.session.relayout();
    expect(h.session.position).toBe(500);
    expect(h.applied.at(-1)).toBe(500);
    expect(h.pending()).toBe(0);

    // Resuming does not rescale a second time.
    h.session.togglePause();
    h.frame(0);
    expect(h.session.position).toBe(500);
  });

  it("stays at the end when the stage is resized after finishing", () => {
    const h = harness({ content: 410, viewport: 400 });
    h.session.start(3);
    h.frame(16);
    h.session.nudge(1_000);
    h.frame(16);
    expect(h.session.current.finished).toBe(true);

    h.ruler.content = 460;
    h.session.relayout();
    expect(h.session.position).toBe(60);
  });

  it("ignores a resize while hidden or stopped", () => {
    const h = harness();
    h.session.relayout();
    expect(h.applied).toEqual([]);

    h.session.start(1);
    h.frame(16);
    h.session.nudge(400);
    const applied = h.applied.length;
    h.ruler.viewport = 0;
    h.ruler.content = 0;
    h.session.relayout();
    expect(h.applied.length).toBe(applied);
    expect(h.session.position).toBe(400);
  });

  it("stops scheduling while paused and resumes without a jump", () => {
    const h = harness();
    h.session.start(1);
    h.frame(16);
    h.frame(50);
    const at = h.session.position;

    h.session.togglePause();
    expect(h.session.current.paused).toBe(true);
    expect(h.pending()).toBe(0);

    h.frame(10_000); // nothing pending, nothing moves
    expect(h.session.position).toBe(at);

    h.session.togglePause();
    expect(h.session.current.paused).toBe(false);
    h.frame(9_999); // re-arms the clock only
    expect(h.session.position).toBe(at);
    h.frame(10);
    expect(h.session.position).toBeCloseTo(at + 10 * rate(1), 9);
  });

  it("finishes at the end, stops scheduling, and a click starts over", () => {
    const h = harness({ content: 410, viewport: 400 });
    h.session.start(3);
    h.frame(16);
    for (let i = 0; i < 20 && !h.session.current.finished; i += 1) {
      h.frame(100);
    }
    expect(h.session.current.finished).toBe(true);
    expect(h.session.position).toBe(10);
    expect(h.pending()).toBe(0);

    h.session.togglePause();
    expect(h.session.current.finished).toBe(false);
    expect(h.session.position).toBe(0);
    expect(h.applied.at(-1)).toBe(0);
    expect(h.pending()).toBe(1);
  });

  it("reads on when the wheel scrolls back up from the end", () => {
    const h = harness({ content: 410, viewport: 400 });
    h.session.start(3);
    h.frame(16);
    h.session.nudge(1_000);
    h.frame(16);
    expect(h.session.current.finished).toBe(true);

    h.session.nudge(-6);
    expect(h.session.position).toBe(4);
    expect(h.session.current.finished).toBe(false);
    expect(h.pending()).toBe(1);
  });

  it("lets the wheel move a paused script without resuming it", () => {
    const h = harness();
    h.session.start(1);
    h.session.togglePause();
    h.session.nudge(120);
    expect(h.session.position).toBe(120);
    expect(h.session.current.paused).toBe(true);
    expect(h.pending()).toBe(0);
  });

  it("declines a nudge that goes nowhere", () => {
    const h = harness();
    h.session.start(1);
    const applied = h.applied.length;
    h.session.nudge(-50); // already at the top
    expect(h.applied.length).toBe(applied);
  });

  it("applies a new speed from the next frame", () => {
    const h = harness();
    h.session.start(1);
    h.frame(16);
    h.frame(20);
    const at = h.session.position;
    h.session.setSpeed(2.5);
    h.frame(20);
    expect(h.session.position).toBeCloseTo(at + 20 * rate(2.5), 9);
  });

  it("reports a state only when it changes", () => {
    const h = harness();
    h.session.start(1);
    const count = h.states.length;
    h.session.setSpeed(1);
    h.frame(16);
    h.frame(16);
    expect(h.states.length).toBe(count);
  });

  it("stop leaves no frame pending and ignores input afterwards", () => {
    const h = harness();
    h.session.start(1);
    h.frame(16);
    h.session.stop();
    expect(h.pending()).toBe(0);
    expect(h.session.current.running).toBe(false);

    const applied = h.applied.length;
    h.session.togglePause();
    h.session.nudge(100);
    expect(h.applied.length).toBe(applied);
    expect(h.pending()).toBe(0);
  });

  it("keeps the speed across a stop, for the next start", () => {
    const h = harness();
    h.session.start(1);
    h.session.setSpeed(1.8);
    h.session.stop();
    expect(h.session.current.speed).toBe(1.8);
  });
});
