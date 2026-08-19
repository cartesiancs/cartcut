import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { GESTURE_IDLE_MS, GestureCommit } from "./gestureCommit";
import { useTimelineStore, HISTORY_LIMIT } from "../../states/timelineStore";
import { addKeyframe } from "../animation/keyframeOps";
import { createTrack } from "../timeline/tracks";
import { imageElement, keys, points } from "../renderer/testing";
import { setIn } from "../../utils/immutable";

/**
 * `window` in vitest's node environment.
 *
 * `GestureCommit` reaches for `addEventListener` and `setTimeout` on it, which
 * is what lets a real scrub end on mouseup; a stub is enough to drive both.
 */
function installWindow() {
  const listeners = new Map<string, Set<() => void>>();
  (globalThis as any).window = {
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: any) => clearTimeout(id),
  };
  return {
    fire(type: string) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

const store = () => useTimelineStore.getState();
const opacityOf = () => (store().timeline.a as any).animation.opacity;

function reset() {
  const base = imageElement();
  useTimelineStore.setState({
    timeline: {
      a: imageElement({
        trackId: "v1",
        animation: {
          ...(base.animation as any),
          opacity: {
            isActivate: true,
            x: keys([0, 0], [1000, 100]),
            ax: points([0, 0], [1000, 100]),
          },
        } as any,
      }),
    },
    tracks: [createTrack("v1", "video", 0)],
    history: { timelineHistory: [], historyNow: -1 },
  });
  store().checkPointTimeline();
}

describe("GestureCommit", () => {
  let win: ReturnType<typeof installWindow>;

  beforeEach(() => {
    vi.useFakeTimers();
    win = installWindow();
    reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).window;
  });

  const bump = (gesture: GestureCommit, value: number) =>
    gesture.apply((doc) =>
      setIn(
        { ...doc, elements: { ...doc.elements } },
        ["elements", "a", "opacity"],
        value,
      ) as any,
    );

  it("shows each change immediately without recording history", () => {
    const gesture = new GestureCommit();
    const before = store().history.timelineHistory.length;

    for (let i = 0; i < 50; i++) {
      bump(gesture, i);
    }

    expect((store().timeline.a as any).opacity).toBe(49);
    expect(store().history.timelineHistory.length).toBe(before);
  });

  /**
   * The regression this class exists for.
   *
   * `number-input` dispatches `onChange` on every mousemove of a scrub, so
   * committing per event pushed hundreds of entries and evicted the whole
   * 50-deep undo stack — one drag of the opacity spinner and every earlier edit
   * was gone.
   */
  it("records one entry for a whole scrub, not one per event", () => {
    const gesture = new GestureCommit();
    const before = store().history.timelineHistory.length;

    for (let i = 0; i < 300; i++) {
      bump(gesture, i);
    }
    win.fire("mouseup");

    expect(store().history.timelineHistory.length).toBe(before + 1);
    expect((store().timeline.a as any).opacity).toBe(299);
  });

  it("leaves the undo stack intact after several scrubs", () => {
    for (let scrub = 0; scrub < 5; scrub++) {
      const gesture = new GestureCommit();
      for (let i = 0; i < 200; i++) {
        bump(gesture, scrub * 1000 + i);
      }
      win.fire("mouseup");
    }
    // Five scrubs, five entries, plus the baseline — nowhere near the cap.
    expect(store().history.timelineHistory.length).toBe(6);
    expect(store().history.timelineHistory.length).toBeLessThan(HISTORY_LIMIT);
  });

  it("undoes a whole scrub in one step", () => {
    const gesture = new GestureCommit();
    for (let i = 1; i <= 100; i++) {
      bump(gesture, i);
    }
    win.fire("mouseup");
    expect((store().timeline.a as any).opacity).toBe(100);

    store().rollbackTimelineFromCheckPoint(-1);
    expect((store().timeline.a as any).opacity).toBe(imageElement().opacity);
  });

  it("commits after an idle, for input typed rather than dragged", () => {
    const gesture = new GestureCommit();
    const before = store().history.timelineHistory.length;

    bump(gesture, 42);
    expect(store().history.timelineHistory.length).toBe(before);

    vi.advanceTimersByTime(GESTURE_IDLE_MS + 10);
    expect(store().history.timelineHistory.length).toBe(before + 1);
    expect((store().timeline.a as any).opacity).toBe(42);
  });

  it("records nothing when the gesture changed nothing", () => {
    // The pure ops decline by identity, and `withCheckpoint` cannot detect that
    // on its own — it rebuilds the document it compares against on every call.
    const gesture = new GestureCommit();
    const before = store().history.timelineHistory.length;

    gesture.apply((doc) => addKeyframe(doc, "nope", "opacity", "x", 0, 0));
    win.fire("mouseup");

    expect(store().history.timelineHistory.length).toBe(before);
  });

  it("folds repeated edits of one field into a single keyframe", () => {
    const gesture = new GestureCommit();
    const before = opacityOf().x.length;

    for (let i = 0; i < 40; i++) {
      gesture.apply((doc) => addKeyframe(doc, "a", "opacity", "x", 500, i));
    }
    win.fire("mouseup");

    // Each step folded into the previous one, so the scrub left one keyframe.
    expect(opacityOf().x).toHaveLength(before + 1);
    expect(opacityOf().x.find((k: any) => k.p[0] === 500).p[1]).toBe(39);
  });

  it("restores the pre-gesture state when cancelled", () => {
    const gesture = new GestureCommit();
    const before = store().history.timelineHistory.length;

    bump(gesture, 7);
    expect((store().timeline.a as any).opacity).toBe(7);

    gesture.cancel();
    expect((store().timeline.a as any).opacity).toBe(imageElement().opacity);
    expect(store().history.timelineHistory.length).toBe(before);
  });

  it("keeps an edit that lands mid-gesture", () => {
    // A clip drag committing, or an async asset add finishing, during the
    // 350ms idle window. Rewinding to the gesture's opening snapshot used to
    // erase it — and record the erasure as the new undo head.
    const gesture = new GestureCommit();
    bump(gesture, 10);

    // Something else edits a different part of the document.
    const live = store().getDocument();
    store().previewDocument({
      ...live,
      elements: {
        ...live.elements,
        b: imageElement({ trackId: "v1", startTime: 9000, duration: 1000 }),
      },
    });

    bump(gesture, 20);
    win.fire("mouseup");

    expect(store().timeline.b).toBeDefined();
    expect((store().timeline.a as any).opacity).toBe(20);
    // And the committed history head carries it too, so an undo of the next
    // edit does not resurrect a document without it.
    expect(
      store().history.timelineHistory.at(-1)!.elements.b,
    ).toBeDefined();
  });

  it("releases its listener and timer once flushed", () => {
    const gesture = new GestureCommit();
    bump(gesture, 1);
    expect(win.count("mouseup")).toBe(1);

    win.fire("mouseup");
    expect(win.count("mouseup")).toBe(0);

    // A second flush is harmless.
    expect(() => gesture.flush()).not.toThrow();
  });

  it("starts a fresh gesture after a flush", () => {
    const gesture = new GestureCommit();
    const before = store().history.timelineHistory.length;

    bump(gesture, 1);
    win.fire("mouseup");
    bump(gesture, 2);
    win.fire("mouseup");

    expect(store().history.timelineHistory.length).toBe(before + 2);
    expect((store().timeline.a as any).opacity).toBe(2);
  });
});
