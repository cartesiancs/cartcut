import { describe, expect, it, vi } from "vitest";
import { canCaptionHere, createCaptionLaunch } from "./captionLaunch";

describe("createCaptionLaunch", () => {
  it("holds a request until the panel takes it, then forgets it", () => {
    const launch = createCaptionLaunch();
    expect(launch.take()).toBeNull();

    launch.request(["a", "b"]);
    expect(launch.take()).toEqual(["a", "b"]);
    // A second read starting a second run is the failure this prevents.
    expect(launch.take()).toBeNull();
  });

  it("keeps only the latest request", () => {
    const launch = createCaptionLaunch();
    launch.request(["a"]);
    launch.request(["b"]);
    expect(launch.take()).toEqual(["b"]);
  });

  it("copies the keys, so a caller mutating its array changes nothing", () => {
    const launch = createCaptionLaunch();
    const keys = ["a"];
    launch.request(keys);
    keys.push("b");
    expect(launch.take()).toEqual(["a"]);
  });

  it("tells a mounted panel at once, and stops after unsubscribing", () => {
    const launch = createCaptionLaunch();
    const listener = vi.fn();
    const unsubscribe = launch.subscribe(listener);

    launch.request(["a"]);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    launch.request(["b"]);
    expect(listener).toHaveBeenCalledTimes(1);
    // Still pending for whichever panel mounts next.
    expect(launch.take()).toEqual(["b"]);
  });
});

describe("canCaptionHere", () => {
  it("is false with no transcription bridge, as in the web build", () => {
    expect(canCaptionHere()).toBe(false);
  });

  // The negative control: the same call has to be able to say yes.
  it("is true once the bridge exists", () => {
    vi.stubGlobal("window", { electronAPI: { req: { transcribe: {} } } });
    try {
      expect(canCaptionHere()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
