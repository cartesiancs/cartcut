import { describe, expect, it } from "vitest";
import { seekAndWait } from "./seekWait";

/** An element that only moves when told, like a paused <video>. */
class FakeVideo extends EventTarget {
  private time = 0;
  throwOnSeek = false;
  get currentTime(): number {
    return this.time;
  }
  set currentTime(value: number) {
    if (this.throwOnSeek) throw new Error("no source");
    this.time = value;
  }
  listening(type: string): number {
    return (this as any)[`count_${type}`] ?? 0;
  }
}

const manualTimer = () => {
  let fire: (() => void) | null = null;
  return {
    setTimer: (fn: () => void) => ((fire = fn), 1),
    clearTimer: () => (fire = null),
    fire: () => fire?.(),
    pending: () => fire != null,
  };
};

describe("seekAndWait", () => {
  it("lands on seeked", async () => {
    const video = new FakeVideo();
    const waiting = seekAndWait(video, 2);
    video.dispatchEvent(new Event("seeked"));
    expect(await waiting).toBe("seeked");
    expect(video.currentTime).toBe(2);
  });

  it("does not wait when the handle is already there", async () => {
    const video = new FakeVideo();
    expect(await seekAndWait(video, 0)).toBe("already");
  });

  it("ends when the handle is let go mid-seek, which fires no seeked at all", async () => {
    const video = new FakeVideo();
    const timer = manualTimer();
    const waiting = seekAndWait(video, 3, timer);
    // What `releaseHandle` does: src removed, load(), which empties the element.
    video.dispatchEvent(new Event("emptied"));
    expect(await waiting).toBe("released");
    expect(timer.pending()).toBe(false);
  });

  it("ends on an error or an abort", async () => {
    for (const type of ["error", "abort"]) {
      const video = new FakeVideo();
      const waiting = seekAndWait(video, 1, manualTimer());
      video.dispatchEvent(new Event(type));
      expect(await waiting).toBe("released");
    }
  });

  it("ends at the deadline when nothing ever comes", async () => {
    const video = new FakeVideo();
    const timer = manualTimer();
    const waiting = seekAndWait(video, 4, timer);
    timer.fire();
    expect(await waiting).toBe("timeout");
  });

  it("ends at once when the element refuses the position", async () => {
    const video = new FakeVideo();
    video.throwOnSeek = true;
    expect(await seekAndWait(video, 5, manualTimer())).toBe("released");
  });

  it("stops listening once it has an answer", async () => {
    const video = new FakeVideo();
    const waiting = seekAndWait(video, 2, manualTimer());
    video.dispatchEvent(new Event("seeked"));
    await waiting;
    let later = 0;
    // A second seeked must not resolve anything or throw.
    video.addEventListener("seeked", () => (later += 1));
    video.dispatchEvent(new Event("seeked"));
    expect(later).toBe(1);
  });
});
