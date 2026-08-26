import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRANSITION_MS,
  MIN_TRANSITION_MS,
  cutTimeOf,
  headHandleOf,
  isAdjacent,
  maxTransitionMs,
  resolveDuration,
  startTimeFor,
  tailHandleOf,
  windowOf,
} from "./transitionGeometry";
import {
  imageElement,
  textElement,
  videoElement,
} from "../renderer/testing";
import type { TransitionElementType } from "../../@types/timeline";

/**
 * A clip whose source is `sourceDuration` long, trimmed to `[in, out)`, placed
 * at `startTime`. The handles follow from the trim: `in` ms before, and
 * `sourceDuration - out` ms after.
 */
function clip(over: {
  startTime?: number;
  trimIn: number;
  trimOut: number;
  sourceDuration?: number;
  speed?: number;
}) {
  const {
    startTime = 0,
    trimIn,
    trimOut,
    sourceDuration = 10_000,
    speed = 1,
  } = over;
  return videoElement({
    startTime,
    duration: trimOut - trimIn,
    trim: { startTime: trimIn, endTime: trimOut },
    sourceDuration,
    speed,
  });
}

describe("tailHandleOf / headHandleOf", () => {
  it("measures the unused source on each side of the trim", () => {
    const c = clip({ trimIn: 2000, trimOut: 6000, sourceDuration: 10_000 });
    expect(headHandleOf(c)).toBe(2000);
    expect(tailHandleOf(c)).toBe(4000);
  });

  it("reports zero when the clip is trimmed to the very ends of its source", () => {
    const c = clip({ trimIn: 0, trimOut: 10_000, sourceDuration: 10_000 });
    expect(headHandleOf(c)).toBe(0);
    expect(tailHandleOf(c)).toBe(0);
  });

  it("converts source ms to timeline ms through speed", () => {
    // 4000ms of unused source played at 2x covers only 2000ms of timeline.
    const c = clip({
      trimIn: 2000,
      trimOut: 6000,
      sourceDuration: 10_000,
      speed: 2,
    });
    expect(headHandleOf(c)).toBe(1000);
    expect(tailHandleOf(c)).toBe(2000);
  });

  it("gives stills infinite handles — they have no source window to exhaust", () => {
    expect(tailHandleOf(imageElement())).toBe(Infinity);
    expect(headHandleOf(imageElement())).toBe(Infinity);
    expect(tailHandleOf(textElement())).toBe(Infinity);
  });

  it("never reports a negative handle when sourceDuration is stale", () => {
    // An element written before `sourceDuration` existed can have a trim that
    // runs past it. That is bad data, not a negative amount of film.
    const c = clip({ trimIn: 0, trimOut: 8000, sourceDuration: 5000 });
    expect(tailHandleOf(c)).toBe(0);
  });
});

describe("maxTransitionMs", () => {
  it("centre spends half from each side, bounded by the tighter one", () => {
    const from = clip({ trimIn: 0, trimOut: 4000, sourceDuration: 10_000 }); // tail 6000
    const to = clip({
      startTime: 4000,
      trimIn: 1000,
      trimOut: 5000,
      sourceDuration: 10_000,
    }); // head 1000

    // head is the binding constraint at 1000, so d/2 <= 1000.
    expect(maxTransitionMs(from, to, "center")).toBe(2000);
  });

  it("centre is also bounded by the clips' own lengths", () => {
    // Both have generous handles but the outgoing clip is only 500ms long, so
    // a centred window may not reach back past its start.
    const from = clip({
      trimIn: 3000,
      trimOut: 3500,
      sourceDuration: 10_000,
    });
    const to = clip({
      startTime: 500,
      trimIn: 3000,
      trimOut: 7000,
      sourceDuration: 10_000,
    });
    expect(maxTransitionMs(from, to, "center")).toBe(1000);
  });

  it("end-aligned needs only the incoming clip's head and the outgoing body", () => {
    // The outgoing clip has NO tail at all — trimmed to the last frame.
    const from = clip({ trimIn: 0, trimOut: 10_000, sourceDuration: 10_000 });
    const to = clip({
      startTime: 10_000,
      trimIn: 3000,
      trimOut: 7000,
      sourceDuration: 10_000,
    });

    // Centre is impossible, which is exactly why the alignment control exists.
    expect(maxTransitionMs(from, to, "center")).toBe(0);
    // End-aligned only needs `to`'s head (3000) and `from`'s length (10000).
    expect(maxTransitionMs(from, to, "end")).toBe(3000);
  });

  it("start-aligned needs only the outgoing clip's tail and the incoming body", () => {
    // The incoming clip starts at the first frame of its source: no head.
    const from = clip({ trimIn: 0, trimOut: 4000, sourceDuration: 10_000 });
    const to = clip({
      startTime: 4000,
      trimIn: 0,
      trimOut: 2000,
      sourceDuration: 10_000,
    });

    expect(maxTransitionMs(from, to, "center")).toBe(0);
    expect(maxTransitionMs(from, to, "end")).toBe(0);
    // `from` has 6000 of tail, `to` is 2000 long — the body binds.
    expect(maxTransitionMs(from, to, "start")).toBe(2000);
  });

  it("is bounded only by their lengths between two stills", () => {
    const from = imageElement({ startTime: 0, duration: 1000 });
    const to = imageElement({ startTime: 1000, duration: 1000 });
    // Handles are infinite, so the clips' own bodies are the only limit: a
    // centred window reaches 1000ms each way and consumes both of them exactly.
    expect(maxTransitionMs(from, to, "center")).toBe(2000);
    expect(maxTransitionMs(from, to, "end")).toBe(1000);
    expect(maxTransitionMs(from, to, "start")).toBe(1000);
  });

  it("never returns a negative length", () => {
    const from = clip({ trimIn: 0, trimOut: 10_000, sourceDuration: 8000 });
    const to = clip({ startTime: 10_000, trimIn: 0, trimOut: 100 });
    for (const alignment of ["center", "end", "start"] as const) {
      expect(maxTransitionMs(from, to, alignment)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("resolveDuration", () => {
  const roomy = {
    from: clip({ trimIn: 2000, trimOut: 6000, sourceDuration: 10_000 }),
    to: clip({
      startTime: 4000,
      trimIn: 2000,
      trimOut: 6000,
      sourceDuration: 10_000,
    }),
  };

  it("grants the request when the handles allow it", () => {
    expect(
      resolveDuration(roomy.from, roomy.to, DEFAULT_TRANSITION_MS, "center"),
    ).toBe(DEFAULT_TRANSITION_MS);
  });

  it("shrinks rather than refusing when the handles are short", () => {
    const from = clip({ trimIn: 0, trimOut: 4000, sourceDuration: 4400 }); // tail 400
    const to = clip({
      startTime: 4000,
      trimIn: 400,
      trimOut: 4400,
      sourceDuration: 10_000,
    }); // head 400

    // Asked for 2000, only 800 exists.
    expect(resolveDuration(from, to, 2000, "center")).toBe(800);
  });

  it("returns zero when the cut cannot support even the minimum", () => {
    const from = clip({ trimIn: 0, trimOut: 4000, sourceDuration: 4010 });
    const to = clip({
      startTime: 4000,
      trimIn: 10,
      trimOut: 4000,
      sourceDuration: 10_000,
    });
    // 2 * min(10, 10, ...) = 20, under MIN_TRANSITION_MS.
    expect(resolveDuration(from, to, 500, "center")).toBe(0);
  });

  it("raises a too-small request to the minimum when there is room", () => {
    expect(resolveDuration(roomy.from, roomy.to, 1, "center")).toBe(
      MIN_TRANSITION_MS,
    );
  });
});

describe("startTimeFor", () => {
  it("centres the window on the cut", () => {
    expect(startTimeFor(5000, 800, "center")).toBe(4600);
  });

  it("ends the window at the cut", () => {
    expect(startTimeFor(5000, 800, "end")).toBe(4200);
  });

  it("starts the window at the cut", () => {
    expect(startTimeFor(5000, 800, "start")).toBe(5000);
  });
});

describe("isAdjacent / cutTimeOf", () => {
  it("finds the cut at the outgoing clip's end", () => {
    const from = clip({ startTime: 1000, trimIn: 0, trimOut: 3000 });
    expect(cutTimeOf(from)).toBe(4000);
  });

  it("treats exactly abutting clips as adjacent", () => {
    const from = clip({ startTime: 0, trimIn: 0, trimOut: 2000 });
    const to = clip({ startTime: 2000, trimIn: 0, trimOut: 2000 });
    expect(isAdjacent(from, to)).toBe(true);
  });

  it("absorbs the float error a sped-up split leaves behind", () => {
    const from = clip({ startTime: 0, trimIn: 0, trimOut: 3000, speed: 1.5 });
    const to = clip({ startTime: 2000.0001, trimIn: 3000, trimOut: 6000 });
    expect(isAdjacent(from, to)).toBe(true);
  });

  it("rejects a real gap", () => {
    const from = clip({ startTime: 0, trimIn: 0, trimOut: 2000 });
    const to = clip({ startTime: 2100, trimIn: 0, trimOut: 2000 });
    expect(isAdjacent(from, to)).toBe(false);
  });
});

describe("windowOf", () => {
  it("reads the stretch straight off the element", () => {
    const transition = {
      startTime: 4600,
      duration: 800,
    } as TransitionElementType;
    expect(windowOf(transition)).toEqual({ start: 4600, end: 5400 });
  });
});
