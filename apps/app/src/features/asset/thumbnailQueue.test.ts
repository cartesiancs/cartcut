/**
 * The bound on how many asset thumbnails decode at once.
 *
 * The thing this feature exists for, so the suite has to be able to fail. The
 * first case runs the same table at two different limits and requires the
 * observed peaks to disagree: a queue that simply never started anything would
 * satisfy "never exceeds the limit" at both.
 */

import { describe, it, expect } from "vitest";
import { createThumbnailQueue, MAX_ATTEMPTS } from "./thumbnailQueue";

type Deferred = {
  resolve: (value: string) => void;
  reject: () => void;
};

/**
 * A capture nothing settles on its own, plus the bookkeeping the assertions
 * read: what was started, in what order, and how many ran at once.
 */
function harness() {
  const pending = new Map<string, Deferred>();
  const started: string[] = [];
  let live = 0;
  let peak = 0;
  const loaded: string[] = [];

  const capture = (key: string) =>
    new Promise<string>((resolve, reject) => {
      started.push(key);
      live += 1;
      peak = Math.max(peak, live);
      pending.set(key, {
        resolve: (value) => {
          live -= 1;
          pending.delete(key);
          resolve(value);
        },
        reject: () => {
          live -= 1;
          pending.delete(key);
          reject(new Error(`failed: ${key}`));
        },
      });
    });

  const failed: string[] = [];

  return {
    capture: capture,
    started: started,
    loaded: loaded,
    failed: failed,
    onLoaded: (key: string) => loaded.push(key),
    onFailed: (key: string) => failed.push(key),
    peak: () => peak,
    settle: (key: string) => pending.get(key)?.resolve(`thumb:${key}`),
    fail: (key: string) => pending.get(key)?.reject(),
    /** Let the promise callbacks that a settle queued actually run. */
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

function queueOf(h: ReturnType<typeof harness>, concurrency: number) {
  return createThumbnailQueue<string>({
    concurrency: concurrency,
    capture: h.capture,
    onLoaded: h.onLoaded,
    onFailed: h.onFailed,
  });
}

const KEYS = ["a", "b", "c", "d", "e"];

describe("createThumbnailQueue", () => {
  it("never runs more than the limit at once", () => {
    const h = harness();
    const queue = queueOf(h, 2);

    for (const key of KEYS) {
      queue.request(key);
    }

    expect(queue.running()).toBe(2);
    expect(h.peak()).toBe(2);
    expect(h.started).toHaveLength(2);
  });

  it("actually observes the limit it was given", () => {
    // The harness check. Same requests, different bound, and the two have to
    // disagree — otherwise the case above would pass against a queue that
    // starts nothing at all.
    const one = harness();
    const narrow = queueOf(one, 1);
    for (const key of KEYS) {
      narrow.request(key);
    }

    const three = harness();
    const wide = queueOf(three, 3);
    for (const key of KEYS) {
      wide.request(key);
    }

    expect(one.peak()).toBe(1);
    expect(three.peak()).toBe(3);
    expect(one.peak()).not.toBe(three.peak());
  });

  it("starts the newest request first, because that is what is on screen", () => {
    const h = harness();
    const queue = queueOf(h, 1);

    queue.request("a");
    queue.request("b");
    queue.request("c");

    // "a" took the only slot; "b" and "c" waited, and "c" arrived last.
    expect(h.started).toEqual(["a"]);

    h.settle("a");
    return h.flush().then(() => {
      expect(h.started).toEqual(["a", "c"]);
    });
  });

  it("does not start a second capture for a key already running", () => {
    const h = harness();
    const queue = queueOf(h, 2);

    queue.request("a");
    queue.request("a");
    queue.request("a");

    expect(h.started).toEqual(["a"]);
    expect(queue.running()).toBe(1);
  });

  it("promotes a waiting key rather than queueing it twice", () => {
    const h = harness();
    const queue = queueOf(h, 1);

    queue.request("a");
    queue.request("b");
    queue.request("c");
    // "b" is now the newest waiting request, so it should go before "c".
    queue.request("b");

    expect(queue.waiting()).toBe(2);

    h.settle("a");
    return h.flush().then(() => {
      expect(h.started).toEqual(["a", "b"]);
    });
  });

  it("reports a finished capture to the caller", async () => {
    const h = harness();
    const queue = queueOf(h, 2);

    queue.request("a");
    h.settle("a");
    await h.flush();

    expect(h.loaded).toEqual(["a"]);
    expect(queue.running()).toBe(0);
  });

  it("cancels a waiting request without touching a running one", async () => {
    const h = harness();
    const queue = queueOf(h, 1);

    queue.request("a");
    queue.request("b");

    queue.cancel("b");
    expect(queue.waiting()).toBe(0);

    // Cancelling the running one gives its slot back to nothing: it is most of
    // the way through the seek that cost the time.
    queue.cancel("a");
    expect(queue.running()).toBe(1);

    h.settle("a");
    await h.flush();
    expect(h.started).toEqual(["a"]);
  });

  it("does not let a failing capture stall the queue", async () => {
    const h = harness();
    const queue = queueOf(h, 1);

    queue.request("a");
    queue.request("b");

    h.fail("a");
    await h.flush();

    expect(h.started).toEqual(["a", "b"]);
    expect(h.loaded).toEqual([]);
  });

  it("reports a failure, so nothing waits on it forever", async () => {
    // `thumbnails.ts` holds a set of waiters per key. Without this signal a
    // capture that fails is indistinguishable from one still queued, and the
    // tile's record of an outstanding request would never be released.
    const h = harness();
    const queue = queueOf(h, 1);

    queue.request("a");
    h.fail("a");
    await h.flush();

    expect(h.failed).toEqual(["a"]);
    expect(h.loaded).toEqual([]);
  });

  it("does not report a failure for a capture that worked", async () => {
    const h = harness();
    const queue = queueOf(h, 1);

    queue.request("a");
    h.settle("a");
    await h.flush();

    expect(h.failed).toEqual([]);
    expect(h.loaded).toEqual(["a"]);
  });

  it("stops offering a file that keeps failing", async () => {
    const h = harness();
    const queue = queueOf(h, 1);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      queue.request("a");
      h.fail("a");
      await h.flush();
    }

    expect(h.started).toHaveLength(MAX_ATTEMPTS);

    // Every scroll back to the tile would otherwise occupy a slot for the full
    // capture timeout.
    queue.request("a");
    expect(h.started).toHaveLength(MAX_ATTEMPTS);
    expect(queue.running()).toBe(0);
  });

  it("forgets the failures of a file that eventually works", async () => {
    const h = harness();
    const queue = queueOf(h, 1);

    queue.request("a");
    h.fail("a");
    await h.flush();

    queue.request("a");
    h.settle("a");
    await h.flush();

    queue.request("a");
    expect(h.started).toEqual(["a", "a", "a"]);
  });
});
