import { afterEach, describe, expect, it } from "vitest";
import { useTimelineStore } from "../../states/timelineStore";
import { imageElement } from "../renderer/testing";
import { SCHEMA_VERSION, createTrack, normalizeDocument } from "../timeline/tracks";
import { redo, undo } from "./actions";
import { CANCEL_GESTURES_EVENT, cancelActiveGestures } from "./gestureCancel";

/**
 * A gesture holding its own document has to be told to drop it while the
 * timeline it belongs to is still the live one, so the event has to arrive
 * before whatever changes the timeline, not after.
 */

afterEach(() => {
  delete (globalThis as any).window;
});

function installWindow() {
  const target = new EventTarget();
  (globalThis as any).window = target;
  return target;
}

describe("cancelActiveGestures", () => {
  it("is a no-op with no window", () => {
    expect(() => cancelActiveGestures()).not.toThrow();
  });

  it("dispatches the event every gesture listens for", () => {
    const win = installWindow();
    let heard = 0;
    win.addEventListener(CANCEL_GESTURES_EVENT, () => {
      heard += 1;
    });
    cancelActiveGestures();
    expect(heard).toBe(1);
  });
});

describe("undo and redo", () => {
  it("end every gesture before the document changes under it", () => {
    const store = useTimelineStore.getState();
    store.clearTimeline();
    store.patchDocument(
      normalizeDocument({
        schemaVersion: SCHEMA_VERSION,
        tracks: [createTrack("v", "video", 0)],
        elements: { a: imageElement({ trackId: "v" }) },
      }),
    );
    store.checkPointTimeline();
    store.withCheckpoint((doc) => ({
      ...doc,
      elements: { ...doc.elements, b: imageElement({ trackId: "v", startTime: 5000 }) },
    }));

    const win = installWindow();
    const seenAt: string[][] = [];
    win.addEventListener(CANCEL_GESTURES_EVENT, () => {
      seenAt.push(Object.keys(useTimelineStore.getState().timeline).sort());
    });

    undo();
    redo();
    // Each heard the document as it stood before its own change.
    expect(seenAt).toEqual([["a", "b"], ["a"]]);
  });
});
