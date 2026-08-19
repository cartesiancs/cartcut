/**
 * The other half of "the clip I just added is invisible until I scrub".
 *
 * The preview repaints when a batch reports that something new arrived. These
 * pin the two ways that report used to be lost: a rejecting load taking the
 * whole batch down with it, and a missing in-flight guard restarting a slow
 * decode on every repaint so the batch never settled.
 */

import { describe, it, expect, vi } from "vitest";
import { runAssetBatch, type AssetLoadTask } from "./assetBatch";

/** A load whose settling this test controls. */
function deferred() {
  let resolve!: (v?: unknown) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function task(
  key: string,
  inFlight: Set<string>,
  start: () => Promise<unknown>,
): AssetLoadTask {
  return { key, inFlight, start };
}

describe("runAssetBatch", () => {
  it("reports that something arrived so the caller repaints", async () => {
    const inFlight = new Set<string>();
    const ran = await runAssetBatch([
      task("a.png", inFlight, async () => "loaded"),
    ]);

    expect(ran).toBe(true);
  });

  it("reports nothing when there was nothing to do", async () => {
    expect(await runAssetBatch([])).toBe(false);
  });

  it("still repaints when one asset in the batch fails", async () => {
    // The regression: a bare Promise.all rejected here, so the good asset's
    // repaint was cancelled along with the bad one's.
    const inFlight = new Set<string>();
    const good = vi.fn(async () => "loaded");
    const bad = vi.fn(async () => {
      throw new Error("404");
    });

    const ran = await runAssetBatch([
      task("broken.png", inFlight, bad),
      task("fine.png", inFlight, good),
    ]);

    expect(ran).toBe(true);
    expect(good).toHaveBeenCalled();
    expect(bad).toHaveBeenCalled();
  });

  it("never rejects, whatever the assets do", async () => {
    const inFlight = new Set<string>();
    await expect(
      runAssetBatch([
        task("a", inFlight, async () => {
          throw new Error("boom");
        }),
        task("b", inFlight, () => Promise.reject(new Error("bang"))),
      ]),
    ).resolves.toBe(true);
  });

  it("does not restart a load that is already in flight", async () => {
    // The preview calls this un-awaited on every repaint, so a decode that
    // takes a few frames would otherwise be started again and again.
    const inFlight = new Set<string>();
    const pending = deferred();
    const start = vi.fn(() => pending.promise);

    const first = runAssetBatch([task("slow.png", inFlight, start)]);
    const second = await runAssetBatch([task("slow.png", inFlight, start)]);

    expect(start).toHaveBeenCalledTimes(1);
    // Nothing new was started, so this repaint has not earned itself.
    expect(second).toBe(false);

    pending.resolve();
    await expect(first).resolves.toBe(true);
  });

  it("releases the guard once a load settles, so a retry is possible", async () => {
    const inFlight = new Set<string>();
    const failing = vi.fn(async () => {
      throw new Error("transient");
    });

    await runAssetBatch([task("a.png", inFlight, failing)]);
    expect(inFlight.has("a.png")).toBe(false);

    await runAssetBatch([task("a.png", inFlight, failing)]);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("releases the guard after a success too", async () => {
    const inFlight = new Set<string>();
    await runAssetBatch([task("a.png", inFlight, async () => "ok")]);

    expect(inFlight.size).toBe(0);
  });

  it("keeps each kind's guard separate", async () => {
    // Video and audio key by element id while images key by path, so the sets
    // must stay independent or an id could mask a path.
    const images = new Set<string>();
    const videos = new Set<string>();
    const startImage = vi.fn(async () => "img");
    const startVideo = vi.fn(async () => "vid");

    await runAssetBatch([
      task("shared-key", images, startImage),
      task("shared-key", videos, startVideo),
    ]);

    expect(startImage).toHaveBeenCalledTimes(1);
    expect(startVideo).toHaveBeenCalledTimes(1);
  });

  it("waits for every started load before reporting", async () => {
    const inFlight = new Set<string>();
    const order: string[] = [];
    const slow = deferred();

    const batch = runAssetBatch([
      task("slow", inFlight, async () => {
        await slow.promise;
        order.push("slow");
      }),
      task("fast", inFlight, async () => {
        order.push("fast");
      }),
    ]);

    slow.resolve();
    await batch;

    expect(order).toEqual(["fast", "slow"]);
  });
});
