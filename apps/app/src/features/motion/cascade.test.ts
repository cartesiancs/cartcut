import { describe, expect, it } from "vitest";
import {
  cascade,
  cascadeDelay,
  type CascadeAnimation,
  type CascadeStep,
  type CascadeTarget,
} from "./cascade";

const VIEW = { top: 100, bottom: 500 };

describe("cascadeDelay", () => {
  it("starts the top of the view first and the bottom last", () => {
    expect(cascadeDelay({ top: 100, bottom: 160 }, VIEW, 200, "down")).toBe(0);
    expect(cascadeDelay({ top: 300, bottom: 360 }, VIEW, 200, "down")).toBe(100);
    expect(cascadeDelay({ top: 499, bottom: 560 }, VIEW, 200, "down")).toBe(200);
  });

  it("gives a grid's row one delay, and the rows different ones", () => {
    const row1 = [0, 1, 2].map(() => cascadeDelay({ top: 180, bottom: 260 }, VIEW, 240, "down"));
    const row2 = cascadeDelay({ top: 262, bottom: 342 }, VIEW, 240, "down");

    expect(new Set(row1).size).toBe(1);
    expect(row2).toBeGreaterThan(row1[0]!);
  });

  it("reverses for a list leaving: the bottom goes first", () => {
    const top = cascadeDelay({ top: 100, bottom: 160 }, VIEW, 120, "up");
    const bottom = cascadeDelay({ top: 440, bottom: 500 }, VIEW, 120, "up");

    expect(top).toBe(120);
    expect(bottom).toBeLessThan(top!);
  });

  it("counts a block cut by the top of the view as at the top", () => {
    expect(cascadeDelay({ top: 60, bottom: 140 }, VIEW, 200, "down")).toBe(0);
  });

  it("leaves out what is not on screen", () => {
    // Above, below, touching an edge from outside, and `display: none`.
    expect(cascadeDelay({ top: 0, bottom: 100 }, VIEW, 200, "down")).toBeNull();
    expect(cascadeDelay({ top: 500, bottom: 560 }, VIEW, 200, "down")).toBeNull();
    expect(cascadeDelay({ top: 900, bottom: 960 }, VIEW, 200, "down")).toBeNull();
    expect(cascadeDelay({ top: 0, bottom: 0 }, VIEW, 200, "down")).toBeNull();
  });

  it("answers nothing for a view with no height, rather than dividing by it", () => {
    expect(cascadeDelay({ top: 0, bottom: 10 }, { top: 0, bottom: 0 }, 200, "down")).toBeNull();
  });
});

type Call = { keyframes: Keyframe[]; options: KeyframeAnimationOptions };

/** A block at `top`, recording every call in `log` and settling when told. */
function block(top: number, log: string[], name: string, height = 60) {
  const calls: Call[] = [];
  const animations: Array<CascadeAnimation & { settle(): void; fail(): void; reversed: number; cancelled: number }> = [];
  const target: CascadeTarget = {
    getBoundingClientRect() {
      log.push(`measure ${name}`);
      return { top, bottom: top + height };
    },
    animate(keyframes, options) {
      log.push(`animate ${name}`);
      calls.push({ keyframes, options });
      let settle!: () => void;
      let fail!: () => void;
      const finished = new Promise<void>((resolve, reject) => {
        settle = resolve;
        fail = () => reject(new Error("AbortError"));
      });
      const animation = {
        finished,
        settle,
        fail,
        reversed: 0,
        cancelled: 0,
        reverse() {
          this.reversed++;
        },
        cancel() {
          this.cancelled++;
        },
      };
      animations.push(animation);
      return animation;
    },
  };
  return { target, calls, animations };
}

const STEP: CascadeStep = {
  order: "down",
  keyframes: [{ opacity: 0 }, { opacity: 1 }],
  durationMs: 300,
  spreadMs: 200,
  leadMs: 50,
  easing: "ease-out",
  fill: "backwards",
};

describe("cascade", () => {
  it("animates only what is on screen, each after the lead and its own delay", () => {
    const log: string[] = [];
    const top = block(100, log, "top");
    const middle = block(300, log, "middle");
    const below = block(800, log, "below");

    const run = cascade([top.target, middle.target, below.target], VIEW, STEP);

    expect(top.calls[0].options).toMatchObject({ delay: 50, duration: 300, fill: "backwards" });
    expect(middle.calls[0].options.delay).toBe(150);
    expect(below.calls).toHaveLength(0);
    // What the GIF section fades the pictures of: the two on screen, not the one below.
    expect(run.animated).toEqual([top.target, middle.target]);
  });

  it("measures every block before animating any", () => {
    const log: string[] = [];
    const a = block(100, log, "a");
    const b = block(200, log, "b");

    cascade([a.target, b.target], VIEW, STEP);

    expect(log).toEqual(["measure a", "measure b", "animate a", "animate b"]);
  });

  it("never waits a negative lead: a start already past is now", () => {
    const log: string[] = [];
    const a = block(100, log, "a");

    cascade([a.target], VIEW, { ...STEP, leadMs: -400 });

    expect(a.calls[0].options.delay).toBe(0);
  });

  it("settles once every block has, and also when one was cancelled", async () => {
    const log: string[] = [];
    const a = block(100, log, "a");
    const b = block(200, log, "b");
    const run = cascade([a.target, b.target], VIEW, STEP);

    let settled = false;
    void run.finished.then(() => (settled = true));

    a.animations[0].settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    b.animations[0].fail();
    await run.finished;
    expect(settled).toBe(true);
  });

  it("settles at once when nothing is on screen", async () => {
    const run = cascade([], VIEW, STEP);
    await expect(run.finished).resolves.toBeUndefined();
  });

  it("reverses and cancels every block it started, and none it skipped", () => {
    const log: string[] = [];
    const a = block(100, log, "a");
    const b = block(200, log, "b");
    const run = cascade([a.target, b.target, block(900, log, "c").target], VIEW, STEP);

    run.reverse();
    run.cancel();

    for (const each of [a, b]) {
      expect(each.animations[0].reversed).toBe(1);
      expect(each.animations[0].cancelled).toBe(1);
    }
  });
});
