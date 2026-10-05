/**
 * Seeking a graphic's animations back and forth, against animations that
 * behave as Chromium's do: `getAnimations()` lists one only while it is
 * relevant, which an animation with no fill stops being once it has finished.
 */

import { describe, expect, it } from "vitest";
import { seekAnimations, type SeekableAnimation } from "./seekAnimations";

/** An animation shown during [delay, delay + duration), like `.wd { opacity: 0; animation: vis .6s linear .2s }`. */
class FakeAnimation implements SeekableAnimation {
  playState = "paused";
  currentTime: number | null = 0;
  constructor(
    readonly delay: number,
    readonly duration: number,
    readonly fill: "none" | "forwards" | "both" = "none",
  ) {}
  pause(): void {
    if (this.playState !== "idle") this.playState = "paused";
  }
  /** What Chromium's relevance rule answers: current, or in effect through a fill. */
  get relevant(): boolean {
    const t = this.currentTime ?? 0;
    const after = t >= this.delay + this.duration;
    return !after || this.fill === "forwards" || this.fill === "both";
  }
  /** Whether the element it drives is shown. */
  get showing(): boolean {
    const t = this.currentTime ?? 0;
    const active = t >= this.delay && t < this.delay + this.duration;
    return active || (this.fill !== "none" && t >= this.delay + this.duration);
  }
}

const live = (all: FakeAnimation[]) => all.filter((a) => a.playState !== "idle" && a.relevant);

describe("seekAnimations", () => {
  it("seeks back an animation that finished with no fill and left the live list", () => {
    const word = new FakeAnimation(0, 600);
    const kept = new Set<FakeAnimation>();
    seekAnimations(kept, live([word]), 250);
    expect(word.showing).toBe(true);
    seekAnimations(kept, live([word]), 900);
    expect(word.showing).toBe(false);
    expect(live([word])).toEqual([]);
    seekAnimations(kept, live([word]), 250);
    expect(word.currentTime).toBe(250);
    expect(word.showing).toBe(true);
  });

  it("is what the live list alone could not do", () => {
    // The seek the host used to make, for contrast: the same three moves leave the word hidden.
    const word = new FakeAnimation(0, 600);
    const seekLiveOnly = (t: number) => {
      for (const a of live([word])) {
        a.pause();
        a.currentTime = t;
      }
    };
    seekLiveOnly(250);
    seekLiveOnly(900);
    seekLiveOnly(250);
    expect(word.currentTime).toBe(900);
    expect(word.showing).toBe(false);
  });

  it("adds animations that appear later, as a rebuilt tree or a refit makes them", () => {
    const kept = new Set<FakeAnimation>();
    const first = new FakeAnimation(0, 600);
    seekAnimations(kept, live([first]), 100);
    const later = new FakeAnimation(200, 400);
    seekAnimations(kept, live([first, later]), 300);
    expect(kept.size).toBe(2);
    expect(later.currentTime).toBe(300);
  });

  it("drops a cancelled animation instead of bringing it back", () => {
    const kept = new Set<FakeAnimation>();
    const old = new FakeAnimation(0, 600);
    seekAnimations(kept, live([old]), 100);
    old.playState = "idle";
    old.currentTime = null;
    seekAnimations(kept, live([old]), 400);
    expect(kept.has(old)).toBe(false);
    expect(old.playState).toBe("idle");
    expect(old.currentTime).toBeNull();
  });

  it("leaves filled animations as they were, reachable either way", () => {
    const kept = new Set<FakeAnimation>();
    const pop = new FakeAnimation(0, 300, "both");
    seekAnimations(kept, live([pop]), 900);
    expect(live([pop])).toEqual([pop]);
    seekAnimations(kept, live([pop]), 100);
    expect(pop.currentTime).toBe(100);
  });
});
