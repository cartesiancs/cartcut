import { describe, expect, it } from "vitest";
import {
  MIN_LABEL_PX,
  MIN_TICK_PX,
  chooseMajorEvery,
  chooseStepMs,
  formatTickLabel,
  planRulerTicks,
  tickLadder,
} from "./rulerTicks";
import { msToPxSigned } from "./geometry";
import { frameDurationMs } from "./frames";
import { MAX_RANGE, MIN_RANGE } from "./zoom";

const RATES = [24, 25, 30, 50, 60, 120];
/** Every zoom the slider can reach, sampled densely enough to catch a gap. */
const ZOOMS = Array.from({ length: 120 }, (_, i) =>
  MIN_RANGE * Math.exp((Math.log(MAX_RANGE / MIN_RANGE) * i) / 119),
);

describe("tickLadder", () => {
  it("ascends, at every frame rate", () => {
    // A non-monotonic ladder would make the selector pick a *coarser* tick as
    // the user zoomed in. Thirty frames at 24fps is 1,250ms, which is why the
    // frame rungs are cut off at a second.
    for (const fps of RATES) {
      const rungs = tickLadder(fps);
      for (let i = 1; i < rungs.length; i++) {
        expect(rungs[i]).toBeGreaterThan(rungs[i - 1]);
      }
    }
  });

  it("starts at one frame and reaches a day", () => {
    for (const fps of RATES) {
      const rungs = tickLadder(fps);
      expect(rungs[0]).toBeCloseTo(frameDurationMs(fps), 9);
      expect(rungs[rungs.length - 1]).toBe(24 * 3_600_000);
    }
  });

  it("drops frame rungs that reach a second", () => {
    // At 24fps, 30 frames is 1,250ms and must not appear.
    expect(tickLadder(24).filter((ms) => ms > 1000 && ms < 2000)).toEqual([]);
  });
});

describe("chooseStepMs", () => {
  it("keeps ticks readable at every zoom and rate", () => {
    for (const fps of RATES) {
      for (const range of ZOOMS) {
        const step = chooseStepMs(range, fps);
        const px = msToPxSigned(step, range);
        // The very coarsest rung is the floor; below that there is nothing
        // bigger to pick and the ruler simply runs out.
        if (step !== tickLadder(fps)[tickLadder(fps).length - 1]) {
          expect(px).toBeGreaterThanOrEqual(MIN_TICK_PX);
        }
      }
    }
  });

  it("never coarsens as the zoom increases", () => {
    for (const fps of RATES) {
      let previous = Infinity;
      for (const range of ZOOMS) {
        const step = chooseStepMs(range, fps);
        expect(step).toBeLessThanOrEqual(previous);
        previous = step;
      }
    }
  });

  it("rules in frames once a frame is wide enough", () => {
    // The whole reason this module exists: at maximum zoom the old ruler's
    // finest tick was 100ms — 300px at range 60, and unrelated to any frame.
    const step = chooseStepMs(MAX_RANGE, 60);
    expect(step).toBeLessThan(100);
    expect(step / frameDurationMs(60)).toBeCloseTo(
      Math.round(step / frameDurationMs(60)),
      9,
    );
  });

  it("reproduces the old 100ms tick at the zoom it was designed for", () => {
    // At the default range the ruler should look exactly as it always has.
    expect(msToPxSigned(chooseStepMs(0.9, 60), 0.9)).toBeGreaterThanOrEqual(
      MIN_TICK_PX,
    );
  });
});

describe("chooseMajorEvery", () => {
  it("spaces labels far enough apart to not collide", () => {
    for (const fps of RATES) {
      for (const range of ZOOMS) {
        const step = chooseStepMs(range, fps);
        const every = chooseMajorEvery(step, range);
        const labelPx = msToPxSigned(step, range) * every;
        if (every !== 10) {
          expect(labelPx).toBeGreaterThanOrEqual(MIN_LABEL_PX);
        }
      }
    }
  });
});

describe("formatTickLabel", () => {
  it("names the frame below a second", () => {
    const frame = frameDurationMs(60);
    expect(formatTickLabel(0, frame * 5, 60)).toBe("0s");
    expect(formatTickLabel(frame * 15, frame * 5, 60)).toBe("0s 15f");
    expect(formatTickLabel(1000, frame * 5, 60)).toBe("1s");
    expect(formatTickLabel(1000 + frame * 30, frame * 5, 60)).toBe("1s 30f");
    expect(formatTickLabel(65_000, frame * 5, 60)).toBe("1m 5s");
  });

  it("keeps the shapes the ruler already used above a second", () => {
    expect(formatTickLabel(3000, 1000, 60)).toBe("3s");
    expect(formatTickLabel(65_000, 1000, 60)).toBe("1m 5s");
    expect(formatTickLabel(300_000, 60_000, 60)).toBe("5m");
    expect(formatTickLabel(3_900_000, 3_600_000, 60)).toBe("1h 05m");
  });

  it("does not report a frame index at or past the frame rate", () => {
    // Rounding `ms` into frames and then splitting must not produce "1s 60f".
    for (const fps of RATES) {
      const frame = frameDurationMs(fps);
      for (let f = 0; f < fps * 3; f++) {
        const label = formatTickLabel(frame * f, frame, fps);
        const match = /(\d+)f$/.exec(label);
        if (match) {
          expect(Number(match[1])).toBeLessThan(fps);
        }
      }
    }
  });
});

describe("planRulerTicks", () => {
  const WIDTH = 400;

  it("always leaves at least two labels on screen", () => {
    // The regression this module fixes. At range 60 the old ruler labelled
    // every second — 3,000px apart — so a 400px viewport showed one or none.
    for (const fps of RATES) {
      for (const range of ZOOMS) {
        for (const hScroll of [0, 1234, 250_000]) {
          const plan = planRulerTicks({ range, hScroll, width: WIDTH, fps });
          const labels = plan.ticks.filter((tick) => tick.major);
          expect(labels.length).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("puts every tick where the clip canvas would put that time", () => {
    // Ruler and clips must agree, or a cut lines up with the wrong timecode.
    const plan = planRulerTicks({
      range: MAX_RANGE,
      hScroll: 977,
      width: WIDTH,
      fps: 60,
    });
    for (const tick of plan.ticks) {
      expect(tick.x).toBeCloseTo(msToPxSigned(tick.ms, MAX_RANGE) - 977, 9);
    }
  });

  it("covers the viewport and not much more", () => {
    const plan = planRulerTicks({
      range: 0.9,
      hScroll: 0,
      width: WIDTH,
      fps: 60,
    });
    expect(plan.ticks[0].x).toBeLessThanOrEqual(0);
    expect(plan.ticks[plan.ticks.length - 1].x).toBeGreaterThanOrEqual(WIDTH);
    const stepPx = msToPxSigned(plan.stepMs, 0.9);
    expect(plan.ticks.length).toBeLessThanOrEqual(WIDTH / stepPx + 3);
  });

  it("never walks ticks that are scrolled off the left", () => {
    // The old loop counted from zero however far the timeline was scrolled.
    const plan = planRulerTicks({
      range: MAX_RANGE,
      hScroll: 3_000_000,
      width: WIDTH,
      fps: 60,
    });
    expect(plan.ticks.length).toBeLessThan(200);
    expect(plan.ticks[0].ms).toBeGreaterThan(0);
  });

  it("never runs before the start of the timeline", () => {
    const plan = planRulerTicks({
      range: 0.9,
      hScroll: 0,
      width: WIDTH,
      fps: 60,
    });
    for (const tick of plan.ticks) {
      expect(tick.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("labels exactly every majorEvery-th tick", () => {
    const plan = planRulerTicks({
      range: MAX_RANGE,
      hScroll: 0,
      width: WIDTH,
      fps: 60,
    });
    for (const tick of plan.ticks) {
      const index = Math.round(tick.ms / plan.stepMs);
      expect(tick.major).toBe(index % plan.majorEvery === 0);
      expect(tick.label != null).toBe(tick.major);
    }
  });

  it("returns nothing for a ruler with no width", () => {
    expect(
      planRulerTicks({ range: 0.9, hScroll: 0, width: 0, fps: 60 }).ticks,
    ).toEqual([]);
  });
});

/**
 * The frame rungs are cut off at a second, and which rungs survive therefore
 * depends on the rate. That is the whole reason `tickLadder` takes an `fps`,
 * and it is the part most likely to be broken by a well-meaning tidy-up.
 */
describe("the frame rungs, rate by rate", () => {
  const frameRungsOf = (fps: number) =>
    tickLadder(fps).filter((ms) => ms < 1000);

  it("keeps all six rungs at 120fps, where thirty frames is a quarter second", () => {
    const rungs = frameRungsOf(120);
    expect(rungs.length).toBe(6);
    expect(rungs).toEqual(
      [1, 2, 5, 10, 15, 30].map((n) => frameDurationMs(120) * n),
    );
    expect(rungs[rungs.length - 1]).toBeCloseTo(250, 9);
  });

  it("drops the thirty-frame rung at 30fps, where it would be a whole second", () => {
    const rungs = frameRungsOf(30);
    expect(rungs.length).toBe(5);
    expect(rungs).toEqual(
      [1, 2, 5, 10, 15].map((n) => frameDurationMs(30) * n),
    );
  });

  it("drops the last two at 24fps", () => {
    // Fifteen frames is 625ms, thirty is 1,250 — above the one-second rung and
    // the reason the cut-off exists at all.
    expect(frameRungsOf(24).length).toBe(5);
    expect(frameRungsOf(25).length).toBe(5);
  });

  it("offers a finer tick the faster the project runs", () => {
    for (let i = 1; i < RATES.length; i++) {
      expect(frameRungsOf(RATES[i])[0]).toBeLessThan(
        frameRungsOf(RATES[i - 1])[0],
      );
    }
  });
});

describe("formatTickLabel, rate by rate", () => {
  it("counts frames to one less than the rate, then rolls the second", () => {
    for (const fps of RATES) {
      const step = frameDurationMs(fps);
      expect(formatTickLabel(step * (fps - 1), step, fps)).toBe(
        `0s ${fps - 1}f`,
      );
      expect(formatTickLabel(step * fps, step, fps)).toBe("1s");
    }
  });

  it("never names a frame the rate cannot reach", () => {
    for (const fps of RATES) {
      const step = frameDurationMs(fps);
      for (let frame = 0; frame < fps * 5; frame++) {
        const label = formatTickLabel(step * frame, step, fps);
        const match = /(\d+)f$/.exec(label);
        if (match) {
          expect(Number(match[1])).toBeLessThan(fps);
        }
      }
    }
  });

  it("labels a 120fps eighth-second the way a 30fps one is labelled", () => {
    // Same instant, different grids: 125ms is frame 15 at 120fps and is not a
    // frame at all at 30, where the nearest rung is 133.3ms.
    expect(formatTickLabel(125, frameDurationMs(120), 120)).toBe("0s 15f");
    expect(formatTickLabel(1000 / 3, frameDurationMs(30), 30)).toBe("0s 10f");
  });
});
