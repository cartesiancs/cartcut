import { describe, it, expect, vi } from "vitest";
import { SCRUB_THRESHOLD_PX, type ScrubOptions } from "./numberScrub";
import { isScrubStart, startScrub, type ScrubEnd, type ScrubHost } from "./scrubSession";

/**
 * A stand-in for `window` plus the pointer lock, in the shape
 * `gestureCommit.test.ts` uses: a map of listeners and a `fire` that calls them.
 * Nothing here needs a DOM, which is the whole reason the host is injected.
 */
function installHost() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const key = (type: string, capture?: boolean) =>
    capture === true ? `${type}:capture` : type;

  let locked = false;
  let lockRefused = false;

  const host: ScrubHost = {
    addListener: (type, fn, capture) => {
      const k = key(type, capture);
      if (!listeners.has(k)) listeners.set(k, new Set());
      listeners.get(k)!.add(fn);
    },
    removeListener: (type, fn, capture) => {
      listeners.get(key(type, capture))?.delete(fn);
    },
    requestLock: vi.fn(() => {
      if (!lockRefused) locked = true;
    }),
    exitLock: vi.fn(() => {
      locked = false;
    }),
    isLocked: () => locked,
    setScrubbing: vi.fn(),
  };

  return {
    host,
    refuseLock() {
      lockRefused = true;
    },
    /** The user pressed Escape while the lock was held. */
    releaseLockExternally() {
      locked = false;
      this.fire("pointerlockchange", {});
    },
    fire(type: string, event: any = {}, capture?: boolean) {
      for (const fn of [...(listeners.get(key(type, capture)) ?? [])]) fn(event);
    },
    count() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

const options: ScrubOptions = { sensitivity: 1, step: 1 };

/** A mousemove with a button still held. */
const move = (movementX: number, over: any = {}) => ({
  movementX,
  buttons: 1,
  ...over,
});

function run(over: Partial<ScrubOptions> = {}) {
  const win = installHost();
  const values: number[] = [];
  const ends: ScrubEnd[] = [];
  const onDragStart = vi.fn();
  const session = startScrub(
    50,
    { ...options, ...over },
    { onDragStart, onValue: (v) => values.push(v), onEnd: (e) => ends.push(e) },
    win.host,
  );
  return { win, values, ends, onDragStart, session };
}

describe("isScrubStart", () => {
  it("admits the left button only", () => {
    expect(isScrubStart({ button: 0 })).toBe(true);
    expect(isScrubStart({})).toBe(true);
    expect(isScrubStart({ button: 2 })).toBe(false);
  });
});

describe("startScrub — engagement", () => {
  it("treats a press with no travel as a click: no value, no drag", () => {
    const { win, values, ends, onDragStart } = run();
    win.fire("mouseup", {});
    expect(values).toEqual([]);
    expect(onDragStart).not.toHaveBeenCalled();
    expect(ends).toEqual([{ dragged: false, cancelled: false }]);
  });

  it("asks for the lock on the press, before anything has moved", () => {
    // Not when the drag is recognised. A request issued from a mousemove is
    // refused as the first request of the process's life, and the refusal
    // sticks for every later request — so "later" means "never".
    const { win } = run();
    expect(win.host.requestLock).toHaveBeenCalledTimes(1);
    expect(win.host.setScrubbing).toHaveBeenCalledWith(true);
  });

  it("announces the drag once, and does not ask for the lock again", () => {
    const { win, onDragStart } = run();
    win.fire("mousemove", move(SCRUB_THRESHOLD_PX));
    win.fire("mousemove", move(10));
    win.fire("mousemove", move(10));
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(win.host.requestLock).toHaveBeenCalledTimes(1);
  });

  it("releases the lock again when the press was only a click", () => {
    const { win } = run();
    win.fire("mouseup", {});
    expect(win.host.exitLock).toHaveBeenCalledTimes(1);
    expect(win.host.setScrubbing).toHaveBeenLastCalledWith(false);
  });

  it("emits nothing for a move that leaves the quantized value alone", () => {
    // 0.1 units a pixel against a step of 1: ten pixels to move the number.
    const { win, values } = run({ sensitivity: 0.1, step: 1 });
    win.fire("mousemove", move(SCRUB_THRESHOLD_PX));
    win.fire("mousemove", move(1));
    win.fire("mousemove", move(1));
    expect(values).toEqual([]);
    for (let i = 0; i < 8; i += 1) win.fire("mousemove", move(1));
    expect(values).toEqual([51]);
  });

  it("scrubs identically when the lock is refused", () => {
    const win = installHost();
    win.refuseLock();
    const values: number[] = [];
    startScrub(50, options, { onValue: (v) => values.push(v) }, win.host);
    win.fire("mousemove", move(SCRUB_THRESHOLD_PX + 10));
    expect(values).toEqual([60]);
  });
});

describe("startScrub — ending", () => {
  it("tears every listener down on mouseup and releases the lock", () => {
    const { win, ends } = run();
    expect(win.count()).toBeGreaterThan(0);
    win.fire("mousemove", move(SCRUB_THRESHOLD_PX + 5));
    win.fire("mouseup", {});
    expect(ends).toEqual([{ dragged: true, cancelled: false }]);
    expect(win.host.exitLock).toHaveBeenCalledTimes(1);
    expect(win.host.setScrubbing).toHaveBeenLastCalledWith(false);
    expect(win.count()).toBe(0);
  });

  it("ends when the button was released outside the window", () => {
    const { win, ends } = run();
    win.fire("mousemove", move(SCRUB_THRESHOLD_PX + 5));
    win.fire("mousemove", { movementX: 20, buttons: 0 });
    expect(ends).toEqual([{ dragged: true, cancelled: false }]);
    expect(win.count()).toBe(0);
  });

  it("ends on a window blur without cancelling", () => {
    const { win, ends } = run();
    win.fire("mousemove", move(SCRUB_THRESHOLD_PX + 5));
    win.fire("blur", {});
    expect(ends).toEqual([{ dragged: true, cancelled: false }]);
  });

  it("ends once, however many events arrive", () => {
    const { win, ends } = run();
    win.fire("mousemove", move(SCRUB_THRESHOLD_PX + 5));
    win.fire("mouseup", {});
    win.fire("mouseup", {});
    expect(ends).toHaveLength(1);
  });
});

describe("startScrub — cancelling", () => {
  it("cancels on Escape with no lock, and keeps the key from the timeline", () => {
    const { win, values, ends } = run();
    win.fire("mousemove", move(SCRUB_THRESHOLD_PX + 10));
    expect(values).toEqual([60]);

    const event = {
      key: "Escape",
      stopPropagation: vi.fn(),
      preventDefault: vi.fn(),
    };
    win.fire("keydown", event, true);

    // No value is emitted: re-emitting the start value would record a real undo
    // step and leave the keyframe the first move created.
    expect(values).toEqual([60]);
    expect(ends).toEqual([{ dragged: true, cancelled: true }]);
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(win.count()).toBe(0);
  });

  it("ignores a keystroke that is not Escape", () => {
    const { win, ends } = run();
    win.fire("mousemove", move(SCRUB_THRESHOLD_PX + 10));
    win.fire("keydown", { key: "a" }, true);
    expect(ends).toEqual([]);
  });

  it("cancels when the lock is taken away, which is how Escape arrives under it", () => {
    const { win, values, ends } = run();
    win.fire("mousemove", move(SCRUB_THRESHOLD_PX + 10));
    win.releaseLockExternally();
    expect(values).toEqual([60]);
    expect(ends).toEqual([{ dragged: true, cancelled: true }]);
  });

  it("does not read its own release as a cancel", () => {
    const { win, ends } = run();
    win.fire("mousemove", move(SCRUB_THRESHOLD_PX + 5));
    (win.host.exitLock as any).mockImplementation(() => {
      win.fire("pointerlockchange", {});
    });
    win.fire("mouseup", {});
    expect(ends).toEqual([{ dragged: true, cancelled: false }]);
  });

  it("does not read the grant arriving as a cancel", () => {
    const { win, ends } = run();
    // The lock was asked for on the press; this is it being granted.
    win.fire("pointerlockchange", {});
    expect(ends).toEqual([]);
  });

  it("cancels from the outside, for a field unmounted mid-drag", () => {
    const { win, values, ends, session } = run();
    win.fire("mousemove", move(SCRUB_THRESHOLD_PX + 10));
    session.cancel();
    expect(values).toEqual([60]);
    expect(ends).toEqual([{ dragged: true, cancelled: true }]);
    expect(win.count()).toBe(0);
    session.cancel();
    expect(ends).toHaveLength(1);
  });
});
