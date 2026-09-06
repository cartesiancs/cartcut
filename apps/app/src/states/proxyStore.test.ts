import { describe, it, expect, beforeEach, vi } from "vitest";
import { playbackPathFor, proxyStore } from "./proxyStore";

const SOURCE = "file:///Users/me/Screen Recording.mov";
const PROXY = "/Users/me/Library/Application Support/cartcut-app/proxies/ab.mp4";

function entry() {
  return {
    [SOURCE]: {
      source: SOURCE,
      proxy: PROXY,
      width: 960,
      height: 624,
      fps: 60,
    },
  };
}

describe("playbackPathFor", () => {
  beforeEach(() => {
    proxyStore.setState({ mode: "prefer", bySource: {}, progress: null });
  });

  it("returns the source unchanged when nothing is known about it", () => {
    expect(playbackPathFor(SOURCE)).toBe(SOURCE);
  });

  it("substitutes the proxy when one exists and the mode allows it", () => {
    proxyStore.getState().setEntries(entry());
    expect(playbackPathFor(SOURCE)).toBe(PROXY);
  });

  it("returns the source when the mode is off, proxy or no proxy", () => {
    proxyStore.getState().setEntries(entry());
    proxyStore.getState().setMode("off");
    expect(playbackPathFor(SOURCE)).toBe(SOURCE);
  });

  // The contract that makes the feature impossible to half-apply: an unknown
  // source falls through silently, exactly as a missing LUT grades nothing.
  it("falls through for a source with no entry, even with others present", () => {
    proxyStore.getState().setEntries(entry());
    expect(playbackPathFor("file:///Users/me/other.mp4")).toBe(
      "file:///Users/me/other.mp4",
    );
  });
});

describe("proxyStore writers", () => {
  beforeEach(() => {
    proxyStore.setState({ mode: "prefer", bySource: {}, progress: null });
  });

  // Same rule the timeline store had to learn: a `set` that changes nothing
  // still wakes every subscriber, and every subscriber here repaints.
  it("setMode does not notify when the mode is already in force", () => {
    const listener = vi.fn();
    const unsubscribe = proxyStore.subscribe(listener);
    proxyStore.getState().setMode("prefer");
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });

  it("setMode notifies on a real change", () => {
    const listener = vi.fn();
    const unsubscribe = proxyStore.subscribe(listener);
    proxyStore.getState().setMode("off");
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setProgress does not notify when the same progress is reported twice", () => {
    const p = { source: SOURCE, fraction: 0.5, index: 0, total: 1 };
    proxyStore.getState().setProgress(p);

    const listener = vi.fn();
    const unsubscribe = proxyStore.subscribe(listener);
    proxyStore.getState().setProgress({ ...p });
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});
