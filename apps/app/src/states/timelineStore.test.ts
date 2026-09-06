import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTimelineStore } from "./timelineStore";

describe("timelineStore.updateTimeline", () => {
  beforeEach(() => {
    useTimelineStore.getState().patchTimeline({
      v1: {
        filetype: "video",
        priority: 1,
        trim: { startTime: 0, endTime: 1000 },
        location: { x: 10, y: 20 },
      },
    });
  });

  it("updates a nested leaf immutably", () => {
    const before = useTimelineStore.getState().timeline;
    useTimelineStore.getState().updateTimeline("v1", ["trim", "endTime"], 500);
    const after = useTimelineStore.getState().timeline;

    expect(after.v1.trim.endTime).toBe(500);
    // new references along the changed path
    expect(after).not.toBe(before);
    expect(after.v1).not.toBe(before.v1);
    expect(after.v1.trim).not.toBe(before.v1.trim);
  });

  it("preserves sibling references not on the changed path", () => {
    const before = useTimelineStore.getState().timeline;
    const locationRef = before.v1.location;
    useTimelineStore.getState().updateTimeline("v1", ["trim", "endTime"], 500);
    const after = useTimelineStore.getState().timeline;

    // untouched nested object keeps identity — the old reducer broke this
    expect(after.v1.location).toBe(locationRef);
  });

  it("does not mutate the previous snapshot (safe undo history)", () => {
    const before = useTimelineStore.getState().timeline;
    useTimelineStore.getState().updateTimeline("v1", ["trim", "endTime"], 500);
    // the captured prior snapshot is unchanged
    expect(before.v1.trim.endTime).toBe(1000);
  });
});

/**
 * A write that changes nothing must wake nobody.
 *
 * Every `useTimelineStore` subscriber is unfiltered — the preview canvas, the
 * timeline canvas, the ruler, the keyframe editor and about thirty option
 * panels all run their whole body on any write of any field — so "did the
 * listener fire" is the same question as "did the app repaint".
 *
 * This is not a theoretical guard. All three writers below used to return `{}`
 * from their updater to mean "nothing happened", and zustand does not read it
 * that way: it skips its listeners only when the updater's result is `Object.is`
 * the current state, and `{}` is a fresh object. So the frame-rate quantizer in
 * `playbackClock.ts` was buying nothing, and a 30fps project on a 120Hz display
 * repainted the entire app 120 times a second. Returning `state` itself — or
 * guarding before `set` — is what actually suppresses the notification.
 */
describe("timelineStore: writes that change nothing notify nobody", () => {
  beforeEach(() => {
    useTimelineStore.getState().patchTimeline({});
    useTimelineStore.getState().setCursor(0);
  });

  it("setCursor with the value already held does not notify", () => {
    useTimelineStore.getState().setCursor(1234);

    const listener = vi.fn();
    const unsubscribe = useTimelineStore.subscribe(listener);
    useTimelineStore.getState().setCursor(1234);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
    expect(useTimelineStore.getState().cursor).toBe(1234);
  });

  it("setCursor with a new value notifies exactly once", () => {
    useTimelineStore.getState().setCursor(1234);

    const listener = vi.fn();
    const unsubscribe = useTimelineStore.subscribe(listener);
    useTimelineStore.getState().setCursor(5678);
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useTimelineStore.getState().cursor).toBe(5678);
  });

  // The frame-grid case the quantizer exists for: a display faster than the
  // project asks for the same instant several times in a row.
  it("repeated setCursor at one frame notifies once, not once per call", () => {
    const listener = vi.fn();
    const unsubscribe = useTimelineStore.subscribe(listener);
    for (let i = 0; i < 4; i++) {
      useTimelineStore.getState().setCursor(3000);
    }
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("withCheckpoint does not notify when the op declines by identity", () => {
    const listener = vi.fn();
    const unsubscribe = useTimelineStore.subscribe(listener);
    // The decline contract: a pure op that refuses returns its input, by
    // identity. `clipOps` does this for a split off the end of a clip, a drag
    // into an occupied slot, and so on.
    useTimelineStore.getState().withCheckpoint((doc) => doc);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
  });

  it("withCheckpoint still notifies when the op returns a new document", () => {
    const listener = vi.fn();
    const unsubscribe = useTimelineStore.subscribe(listener);
    useTimelineStore.getState().withCheckpoint((doc) => ({ ...doc }));
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  // Found by measuring the running app: with `setCursor` fixed, the subscribers
  // were still being woken twice per frame. The second wake was
  // `elementTimelineCanvas.render()` reporting the same canvas width on every
  // Lit update.
  it("setCanvasWidth with the value already held does not notify", () => {
    useTimelineStore.getState().setCanvasWidth(1280);

    const listener = vi.fn();
    const unsubscribe = useTimelineStore.subscribe(listener);
    useTimelineStore.getState().setCanvasWidth(1280);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
    expect(useTimelineStore.getState().canvasWidth).toBe(1280);
  });

  it("setScroll with the value already held does not notify", () => {
    useTimelineStore.getState().setScroll(42);

    const listener = vi.fn();
    const unsubscribe = useTimelineStore.subscribe(listener);
    useTimelineStore.getState().setScroll(42);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
    expect(useTimelineStore.getState().scroll).toBe(42);
  });

  it.each([
    ["setCanvasWidth", 1280, 1600, () => useTimelineStore.getState().canvasWidth],
    ["setScroll", 42, 84, () => useTimelineStore.getState().scroll],
  ])("%s still notifies on a real change", (name, first, second, read) => {
    const call = (v: number) => (useTimelineStore.getState() as any)[name](v);
    call(first as number);

    const listener = vi.fn();
    const unsubscribe = useTimelineStore.subscribe(listener);
    call(second as number);
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(read()).toBe(second);
  });

  it("an undo past the start of history does not notify", () => {
    // `historyNow` is -1 with nothing recorded, so any step is out of range.
    const listener = vi.fn();
    const unsubscribe = useTimelineStore.subscribe(listener);
    useTimelineStore.getState().rollbackTimelineFromCheckPoint(-1);
    useTimelineStore.getState().rollbackTimelineFromCheckPoint(-1);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
  });
});
