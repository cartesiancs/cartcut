import { describe, expect, it } from "vitest";

import { publishEditorEvents, type EventSources } from "./events";
import type { FrameScheduler } from "../caption/previewLoop";

function fakeScheduler() {
  const queue: Array<() => void> = [];
  const scheduler: FrameScheduler = {
    request: (callback) => {
      queue.push(callback);
      return queue.length;
    },
    cancel: () => undefined,
  };
  return { scheduler, frame: () => queue.splice(0).forEach((callback) => callback()) };
}

function harness() {
  const sent: Array<{ event: string; params: unknown }> = [];
  const listeners = {
    document: [] as Array<(elements: unknown, tracks: unknown) => void>,
    cursor: [] as Array<(ms: number) => void>,
    selection: [] as Array<(ids: string[]) => void>,
    playback: [] as Array<(isPlay: boolean) => void>,
    lock: [] as Array<(reason: string | null) => void>,
  };
  let unsubscribed = 0;
  const clock = fakeScheduler();

  const sources: EventSources = {
    subscribeDocument: (listener) => {
      listeners.document.push(listener);
      return () => {
        unsubscribed += 1;
      };
    },
    subscribeCursor: (listener) => {
      listeners.cursor.push(listener);
      return () => {
        unsubscribed += 1;
      };
    },
    subscribeSelection: (listener) => {
      listeners.selection.push(listener);
      return () => {
        unsubscribed += 1;
      };
    },
    subscribePlayback: (listener) => {
      listeners.playback.push(listener);
      return () => {
        unsubscribed += 1;
      };
    },
    subscribeLock: (listener) => {
      listeners.lock.push(listener);
      return () => {
        unsubscribed += 1;
      };
    },
    scheduler: clock.scheduler,
  };

  const publisher = publishEditorEvents((event, params) => sent.push({ event, params }), sources);
  return { sent, listeners, publisher, frame: clock.frame, unsubscribed: () => unsubscribed };
}

describe("publishEditorEvents", () => {
  it("sends one playhead event per frame, with the latest value", () => {
    // The playhead moves at the display rate. Sending each value would pay a
    // structured clone per frame on the thread compositing the preview.
    const h = harness();
    for (const ms of [10, 20, 30, 40]) {
      h.listeners.cursor.forEach((listener) => listener(ms));
    }
    expect(h.sent).toHaveLength(0);

    h.frame();
    expect(h.sent).toEqual([{ event: "playhead.changed", params: { ms: 40 } }]);
  });

  it("sends nothing for a frame where the playhead did not move", () => {
    const h = harness();
    h.listeners.cursor.forEach((listener) => listener(100));
    h.frame();
    h.listeners.cursor.forEach((listener) => listener(100));
    h.frame();
    expect(h.sent).toHaveLength(1);
  });

  it("counts document changes so a listener can tell them apart", () => {
    const h = harness();
    h.listeners.document.forEach((listener) => listener({ a: 1 }, [{ id: "t" }]));
    h.listeners.document.forEach((listener) => listener({ a: 1, b: 2 }, [{ id: "t" }]));
    expect(h.sent.map((entry) => (entry.params as { version: number }).version)).toEqual([1, 2]);
    expect(h.publisher.documentVersion()).toBe(2);
  });

  it("never sends the document itself", () => {
    // `serialize.ts` is the only thing allowed to decide what an element looks
    // like on the wire, and a baked animation lane is 36,000 samples.
    const h = harness();
    h.listeners.document.forEach((listener) => listener({ a: { huge: true } }, []));
    expect(JSON.stringify(h.sent)).not.toContain("huge");
  });

  it("passes selection, playback and lock straight through", () => {
    const h = harness();
    h.listeners.selection.forEach((listener) => listener(["a", "b"]));
    h.listeners.playback.forEach((listener) => listener(true));
    h.listeners.lock.forEach((listener) => listener("captionSession"));
    expect(h.sent.map((entry) => entry.event)).toEqual([
      "selection.changed",
      "playback.changed",
      "lock.changed",
    ]);
  });

  it("drops a frame that lands after it was stopped", () => {
    const h = harness();
    h.listeners.cursor.forEach((listener) => listener(50));
    h.publisher.stop();
    h.frame();
    expect(h.sent).toHaveLength(0);
  });

  it("unsubscribes everything on stop", () => {
    // A host restarts on every save of an unpacked extension, and listeners
    // that outlived their sink would accumulate one set per restart.
    const h = harness();
    h.publisher.stop();
    expect(h.unsubscribed()).toBe(5);
  });
});
