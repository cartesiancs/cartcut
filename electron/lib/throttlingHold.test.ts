import { describe, expect, it } from "vitest";

import { createThrottlingHold, type ThrottlingTarget } from "./throttlingHold";

function fakeWindow(throttling: boolean): ThrottlingTarget & { calls: boolean[] } {
  const calls: boolean[] = [];
  return {
    calls,
    getBackgroundThrottling: () => throttling,
    setBackgroundThrottling(allowed) {
      throttling = allowed;
      calls.push(allowed);
    },
  };
}

describe("createThrottlingHold", () => {
  it("turns throttling off for the hold and back on for a window that had it on", () => {
    const hold = createThrottlingHold();
    const window = fakeWindow(true);
    hold(window, false);
    expect(window.getBackgroundThrottling()).toBe(false);
    hold(window, true);
    expect(window.getBackgroundThrottling()).toBe(true);
  });

  it("leaves throttling off after the hold for a window that had it off", () => {
    const hold = createThrottlingHold();
    const window = fakeWindow(false);
    hold(window, false);
    hold(window, true);
    expect(window.getBackgroundThrottling()).toBe(false);
  });

  it("restores what was there before the first of two overlapping starts", () => {
    const hold = createThrottlingHold();
    const window = fakeWindow(true);
    hold(window, false);
    hold(window, false);
    hold(window, true);
    expect(window.getBackgroundThrottling()).toBe(true);
  });

  it("keeps each window's own setting", () => {
    const hold = createThrottlingHold();
    const on = fakeWindow(true);
    const off = fakeWindow(false);
    hold(on, false);
    hold(off, false);
    hold(off, true);
    hold(on, true);
    expect(on.getBackgroundThrottling()).toBe(true);
    expect(off.getBackgroundThrottling()).toBe(false);
  });

  it("switches throttling on for a release with no hold behind it, as it always did", () => {
    const hold = createThrottlingHold();
    const window = fakeWindow(false);
    hold(window, true);
    expect(window.calls).toEqual([true]);
  });

  it("reads the setting afresh for each new hold", () => {
    const hold = createThrottlingHold();
    const window = fakeWindow(true);
    hold(window, false);
    hold(window, true);
    window.setBackgroundThrottling(false);
    hold(window, false);
    hold(window, true);
    expect(window.getBackgroundThrottling()).toBe(false);
  });
});
