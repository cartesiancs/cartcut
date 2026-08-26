import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRANSITION_MS,
  MIN_TRANSITION_MS,
  cutTimeOf,
  headHandleOf,
  isAdjacent,
  freezeMs,
  maxTransitionMs,
  realFootageMs,
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

describe("maxTransitionMs — bounded by the clips, not by footage", () => {
  it("lets two freshly imported clips have a transition", () => {
    // The bug this replaced. A fresh import is trimmed to its whole source, so
    // it has zero handle on either side — and the old rule, which bounded the
    // length by the handles, refused the single most common edit there is:
    // drop two clips end to end and dissolve between them.
    const from = clip({ trimIn: 0, trimOut: 4000, sourceDuration: 4000 });
    const to = clip({
      startTime: 4000,
      trimIn: 0,
      trimOut: 4000,
      sourceDuration: 4000,
    });

    expect(tailHandleOf(from)).toBe(0);
    expect(headHandleOf(to)).toBe(0);
    expect(maxTransitionMs(from, to, "center")).toBe(8000);
    expect(maxTransitionMs(from, to, "end")).toBe(4000);
    expect(maxTransitionMs(from, to, "start")).toBe(4000);
  });

  it("centre may reach half its length into each clip", () => {
    const from = clip({ trimIn: 3000, trimOut: 3500, sourceDuration: 10_000 });
    const to = clip({
      startTime: 500,
      trimIn: 3000,
      trimOut: 7000,
      sourceDuration: 10_000,
    });
    // The outgoing clip is only 500ms, so a centred window reaches 500ms back.
    expect(maxTransitionMs(from, to, "center")).toBe(1000);
  });

  it("an aligned window sits inside one clip, so only that one bounds it", () => {
    const from = clip({ trimIn: 0, trimOut: 4000, sourceDuration: 10_000 });
    const to = clip({
      startTime: 4000,
      trimIn: 0,
      trimOut: 1000,
      sourceDuration: 10_000,
    });
    expect(maxTransitionMs(from, to, "end")).toBe(4000);
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

describe("realFootageMs — how much is not a held frame", () => {
  it("centre draws on both handles, bounded by the tighter one", () => {
    const from = clip({ trimIn: 0, trimOut: 4000, sourceDuration: 10_000 });
    const to = clip({
      startTime: 4000,
      trimIn: 1000,
      trimOut: 5000,
      sourceDuration: 10_000,
    });
    // head is the binding constraint at 1000, so d/2 <= 1000.
    expect(realFootageMs(from, to, "center")).toBe(2000);
  });

  it("end-aligned needs only the incoming clip's head", () => {
    // The outgoing clip has NO tail — trimmed to the last frame of its source.
    const from = clip({ trimIn: 0, trimOut: 10_000, sourceDuration: 10_000 });
    const to = clip({
      startTime: 10_000,
      trimIn: 3000,
      trimOut: 7000,
      sourceDuration: 10_000,
    });

    // Centred, every frame the outgoing clip contributes would be held...
    expect(realFootageMs(from, to, "center")).toBe(0);
    // ...but aligned to the cut it draws on `to`'s 3000ms head instead. This is
    // what makes the alignment control worth having.
    expect(realFootageMs(from, to, "end")).toBe(3000);
  });

  it("start-aligned needs only the outgoing clip's tail", () => {
    const from = clip({ trimIn: 0, trimOut: 4000, sourceDuration: 10_000 });
    const to = clip({
      startTime: 4000,
      trimIn: 0,
      trimOut: 2000,
      sourceDuration: 10_000,
    });

    expect(realFootageMs(from, to, "center")).toBe(0);
    expect(realFootageMs(from, to, "end")).toBe(0);
    expect(realFootageMs(from, to, "start")).toBe(2000);
  });

  it("is unbounded between two stills", () => {
    // A still has no source window to run out of, so nothing is ever held.
    const from = imageElement({ startTime: 0, duration: 1000 });
    const to = imageElement({ startTime: 1000, duration: 1000 });
    expect(realFootageMs(from, to, "center")).toBe(2000);
  });
});

describe("freezeMs", () => {
  it("is zero when the handles cover the whole transition", () => {
    const from = clip({ trimIn: 2000, trimOut: 6000, sourceDuration: 10_000 });
    const to = clip({
      startTime: 4000,
      trimIn: 2000,
      trimOut: 6000,
      sourceDuration: 10_000,
    });
    expect(freezeMs(from, to, "center", 800)).toBe(0);
  });

  it("reports the shortfall when they do not", () => {
    // 400ms of handle each side covers 800ms of a centred transition; the rest
    // holds a frame.
    const from = clip({ trimIn: 0, trimOut: 4000, sourceDuration: 4400 });
    const to = clip({
      startTime: 4000,
      trimIn: 400,
      trimOut: 4400,
      sourceDuration: 10_000,
    });
    expect(freezeMs(from, to, "center", 2000)).toBe(1200);
  });

  it("is the whole transition between two untrimmed imports", () => {
    const from = clip({ trimIn: 0, trimOut: 4000, sourceDuration: 4000 });
    const to = clip({
      startTime: 4000,
      trimIn: 0,
      trimOut: 4000,
      sourceDuration: 4000,
    });
    expect(freezeMs(from, to, "center", 1000)).toBe(1000);
  });

  it("is zero between two stills, whatever the length", () => {
    const from = imageElement({ startTime: 0, duration: 5000 });
    const to = imageElement({ startTime: 5000, duration: 5000 });
    expect(freezeMs(from, to, "center", 4000)).toBe(0);
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

  it("grants the request when the clips are long enough", () => {
    expect(
      resolveDuration(roomy.from, roomy.to, DEFAULT_TRANSITION_MS, "center"),
    ).toBe(DEFAULT_TRANSITION_MS);
  });

  it("grants it even when the handles do not cover it", () => {
    // The frames beyond the source are held rather than refused, so the length
    // the user asked for is the length they get.
    const from = clip({ trimIn: 0, trimOut: 4000, sourceDuration: 4000 });
    const to = clip({
      startTime: 4000,
      trimIn: 0,
      trimOut: 4000,
      sourceDuration: 4000,
    });
    expect(resolveDuration(from, to, 1000, "center")).toBe(1000);
  });

  it("shrinks to fit clips that are too short to hold the request", () => {
    const from = clip({ trimIn: 0, trimOut: 600, sourceDuration: 10_000 });
    const to = clip({
      startTime: 600,
      trimIn: 0,
      trimOut: 600,
      sourceDuration: 10_000,
    });
    // Centred, the window may reach 600ms each way.
    expect(resolveDuration(from, to, 5000, "center")).toBe(1200);
  });

  it("returns zero only when the clips cannot hold the minimum", () => {
    const from = clip({ trimIn: 0, trimOut: 10, sourceDuration: 10_000 });
    const to = clip({
      startTime: 10,
      trimIn: 0,
      trimOut: 10,
      sourceDuration: 10_000,
    });
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
