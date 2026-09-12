import { describe, expect, it, vi } from "vitest";
import { once, seekMedia, whenReady, type SeekableMedia } from "./seek";

/**
 * A media element with a decoder we drive by hand.
 *
 * Node has no `HTMLMediaElement`, and the behaviours worth pinning here are
 * about *when* events arrive, which a real element would not let us control.
 */
function fakeMedia(readyState = 4) {
  const listeners = new Map<string, Set<() => void>>();
  const media = {
    readyState,
    currentTime: 0,
    addEventListener(event: string, handler: () => void) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(handler);
    },
    removeEventListener(event: string, handler: () => void) {
      listeners.get(event)?.delete(handler);
    },
  };
  return {
    media: media as unknown as SeekableMedia & { currentTime: number; readyState: number },
    fire(event: string) {
      for (const handler of [...(listeners.get(event) ?? [])]) {
        handler();
      }
    },
    count(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
    total() {
      return [...listeners.values()].reduce((n, set) => n + set.size, 0);
    },
  };
}

describe("whenReady", () => {
  it("resolves at once when a frame is already decoded", async () => {
    const { media, total } = fakeMedia(2);
    await expect(whenReady(media)).resolves.toBeUndefined();
    expect(total()).toBe(0);
  });

  it("waits for loadeddata when nothing has decoded yet", async () => {
    const { media, fire } = fakeMedia(0);
    let settled = false;
    const pending = whenReady(media).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    fire("loadeddata");
    await pending;
    expect(settled).toBe(true);
  });

  it("removes every listener once it settles", async () => {
    const { media, fire, total } = fakeMedia(0);
    const pending = whenReady(media);
    expect(total()).toBeGreaterThan(0);

    fire("loadeddata");
    await pending;
    expect(total()).toBe(0);
  });

  it("rejects on error rather than hanging", async () => {
    const { media, fire } = fakeMedia(0);
    const pending = whenReady(media);
    fire("error");
    await expect(pending).rejects.toThrow(/could not be read/);
  });

  it("polls readyState as a backstop for a missed loadeddata", async () => {
    // `loadeddata` can fire between the readyState check and the listener being
    // attached, and it does not fire twice — so the poll is the only thing that
    // gets us out of that race.
    vi.useFakeTimers();
    try {
      const { media } = fakeMedia(0);
      let settled = false;
      const pending = whenReady(media).then(() => {
        settled = true;
      });

      media.readyState = 4;
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("once", () => {
  it("resolves on the event and drops both listeners", async () => {
    const { media, fire, total } = fakeMedia();
    const pending = once(media, "seeked");
    fire("seeked");
    await pending;
    expect(total()).toBe(0);
  });

  it("rejects on the error event and drops both listeners", async () => {
    const { media, fire, total } = fakeMedia();
    const pending = once(media, "seeked");
    fire("error");
    await expect(pending).rejects.toThrow(/could not be read/);
    expect(total()).toBe(0);
  });
});

describe("seekMedia", () => {
  it("seeks and waits for the frame", async () => {
    const { media, fire } = fakeMedia();
    let settled = false;
    const pending = seekMedia(media, 2.5).then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(media.currentTime).toBe(2.5);
    // Not done yet: the picture has been requested, not decoded.
    expect(settled).toBe(false);

    fire("seeked");
    await pending;
    expect(settled).toBe(true);
  });

  it("returns without waiting when it is already there", async () => {
    // The hang this guard exists for: resetting a paused clip to 0 when it is
    // already at 0 performs no seek, so `seeked` never arrives. Nothing fires
    // `seeked` in this test, and it still has to resolve.
    const { media, total } = fakeMedia();
    media.currentTime = 0;

    await expect(seekMedia(media, 0)).resolves.toBeUndefined();
    expect(total()).toBe(0);
  });

  it("checks readiness before trusting currentTime", async () => {
    // `currentTime` reads 0 before anything has loaded — not because the
    // decoder is at 0, but because there is no decoder. Returning early on that
    // would paint an undecoded element.
    const { media, fire } = fakeMedia(0);
    let settled = false;
    const pending = seekMedia(media, 0).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    fire("loadeddata");
    await pending;
    expect(settled).toBe(true);
  });

  it("clamps a negative or non-finite time", async () => {
    const { media, fire } = fakeMedia();
    media.currentTime = 5;

    const pending = seekMedia(media, -3);
    await Promise.resolve();
    await Promise.resolve();
    expect(media.currentTime).toBe(0);
    fire("seeked");
    await pending;

    media.currentTime = 5;
    const nan = seekMedia(media, Number.NaN);
    await Promise.resolve();
    await Promise.resolve();
    expect(media.currentTime).toBe(0);
    fire("seeked");
    await nan;
  });
});
