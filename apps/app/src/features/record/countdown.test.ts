import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startCountdown } from "./countdown";

describe("startCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts 3, 2, 1 a second apart and finishes a second after the 1", async () => {
    const steps: [number, number][] = [];
    const began = Date.now();
    const countdown = startCountdown({
      from: 3,
      stepMs: 1000,
      onStep: (remaining) => steps.push([remaining, Date.now() - began]),
    });

    let finished: boolean | null = null;
    void countdown.done.then((value) => {
      finished = value;
    });

    // The first number is on screen with the click, not a second after it.
    expect(steps).toEqual([[3, 0]]);

    await vi.advanceTimersByTimeAsync(2999);
    expect(steps).toEqual([
      [3, 0],
      [2, 1000],
      [1, 2000],
    ]);
    expect(finished).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(finished).toBe(true);
  });

  it("stops counting when cancelled and reports that it did not finish", async () => {
    const steps: number[] = [];
    const countdown = startCountdown({
      from: 3,
      stepMs: 1000,
      onStep: (remaining) => steps.push(remaining),
    });

    await vi.advanceTimersByTimeAsync(1500);
    countdown.cancel();

    await expect(countdown.done).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(steps).toEqual([3, 2]);
  });

  it("ignores a cancel that arrives after it has finished", async () => {
    const countdown = startCountdown({ from: 1, stepMs: 1000, onStep: () => {} });

    await vi.advanceTimersByTimeAsync(1000);
    countdown.cancel();
    countdown.cancel();

    await expect(countdown.done).resolves.toBe(true);
  });

  it("finishes at once, showing nothing, when there is nothing to count", async () => {
    const onStep = vi.fn();
    const countdown = startCountdown({ from: 0, stepMs: 1000, onStep });

    await expect(countdown.done).resolves.toBe(true);
    expect(onStep).not.toHaveBeenCalled();
  });
});
