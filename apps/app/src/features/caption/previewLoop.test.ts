import { describe, expect, it } from "vitest";
import {
  ChromeGate,
  PreviewLoop,
  chromeKey,
  chromeStateOf,
  type FrameScheduler,
} from "./previewLoop";
import { linesFromWordGroups } from "./lines";
import { playheadLabel } from "../media/playback";

/**
 * The two animation-frame handles, against a fake scheduler.
 *
 * Nothing here runs a real frame: `fakeScheduler` hands back ids and lets the
 * test decide when a callback fires, which is what makes "a pending paint
 * survives `start()`" expressible at all.
 */
function fakeScheduler() {
  const pending = new Map<number, () => void>();
  const cancelled: number[] = [];
  let nextId = 1;

  const scheduler: FrameScheduler = {
    request(callback) {
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      return id;
    },
    cancel(id) {
      cancelled.push(id);
      pending.delete(id);
    },
  };

  return {
    scheduler,
    cancelled,
    /** Ids still armed, oldest first. */
    armed: () => [...pending.keys()],
    /** Fire one armed callback. */
    fire(id: number) {
      const callback = pending.get(id);
      expect(callback, `frame ${id} is not armed`).toBeTypeOf("function");
      pending.delete(id);
      callback!();
    },
    /** Fire whatever is armed, once. */
    fireAll() {
      for (const id of [...pending.keys()]) this.fire(id);
    },
  };
}

describe("PreviewLoop.start", () => {
  it("arms a frame and runs the step when it fires", () => {
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);
    let steps = 0;

    loop.start(() => {
      steps += 1;
    });
    expect(loop.isRunning).toBe(true);
    expect(steps).toBe(0);

    host.fireAll();
    expect(steps).toBe(1);
  });

  it("re-arms itself every frame", () => {
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);
    let steps = 0;

    loop.start(() => {
      steps += 1;
    });
    for (let i = 0; i < 5; i += 1) host.fireAll();

    expect(steps).toBe(5);
    expect(loop.isRunning).toBe(true);
  });

  it("cancels a frame already armed, so two loops cannot run at once", () => {
    // Double-clicking Play. Two loops would composite the frame twice and
    // advance nothing, on the thread doing the compositing.
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);

    loop.start(() => {});
    const first = host.armed()[0];
    loop.start(() => {});

    expect(host.cancelled).toContain(first);
    expect(host.armed()).toHaveLength(1);
  });

  it("runs only the newest step after a restart", () => {
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);
    const ran: string[] = [];

    loop.start(() => ran.push("first"));
    loop.start(() => ran.push("second"));
    host.fireAll();

    expect(ran).toEqual(["second"]);
  });

  it("does NOT cancel a pending paint", () => {
    // Pinned as it is, not tidied. A repaint coalesced while paused still fires
    // alongside the loop's first frame, so "at most one repaint in flight" is
    // not an invariant of this class and never was.
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);
    let paints = 0;
    let steps = 0;

    loop.schedulePaint(() => {
      paints += 1;
    });
    loop.start(() => {
      steps += 1;
    });

    expect(loop.hasPendingPaint).toBe(true);
    expect(host.armed()).toHaveLength(2);

    host.fireAll();
    expect(paints).toBe(1);
    expect(steps).toBe(1);
  });
});

describe("PreviewLoop.stop", () => {
  it("cancels the loop and clears it", () => {
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);

    loop.start(() => {});
    const armed = host.armed()[0];
    loop.stop();

    expect(host.cancelled).toContain(armed);
    expect(loop.isRunning).toBe(false);
    expect(host.armed()).toHaveLength(0);
  });

  it("cancels a pending paint too", () => {
    // The loop used to outlive the component, going on compositing a
    // full-resolution frame every 16ms against a canvas nobody could see.
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);

    loop.schedulePaint(() => {});
    const armed = host.armed()[0];
    loop.stop();

    expect(host.cancelled).toContain(armed);
    expect(loop.hasPendingPaint).toBe(false);
  });

  it("cancels both handles at once", () => {
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);

    loop.start(() => {});
    loop.schedulePaint(() => {});
    expect(host.armed()).toHaveLength(2);

    loop.stop();
    expect(host.armed()).toHaveLength(0);
    expect(loop.isRunning).toBe(false);
    expect(loop.hasPendingPaint).toBe(false);
  });

  it("stops the loop from re-arming", () => {
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);
    let steps = 0;

    loop.start(() => {
      steps += 1;
    });
    loop.stop();
    expect(host.armed()).toHaveLength(0);
    expect(steps).toBe(0);
  });

  it("wins when called from inside the step", () => {
    // The frame currently running re-arms only if `done` is still false, so a
    // stop from within the step body is the last word. Nothing must be armed
    // after it.
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);
    let steps = 0;

    loop.start(() => {
      steps += 1;
      loop.stop();
    });
    host.fireAll();

    expect(steps).toBe(1);
    expect(loop.isRunning).toBe(false);
    expect(host.armed()).toHaveLength(0);
  });

  it("is safe with nothing armed, and safe twice", () => {
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);

    expect(() => {
      loop.stop();
      loop.stop();
    }).not.toThrow();
    expect(host.cancelled).toEqual([]);
  });

  it("can be restarted after stopping", () => {
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);
    let steps = 0;

    loop.start(() => {
      steps += 1;
    });
    loop.stop();
    loop.start(() => {
      steps += 1;
    });
    host.fireAll();
    host.fireAll();

    expect(steps).toBe(2);
  });
});

describe("PreviewLoop.schedulePaint", () => {
  it("paints once on the next frame", () => {
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);
    let paints = 0;

    loop.schedulePaint(() => {
      paints += 1;
    });
    expect(paints).toBe(0);

    host.fireAll();
    expect(paints).toBe(1);
  });

  it("coalesces several calls in one turn into one frame", () => {
    // An edit that dirties the picture twice — changing the text and moving the
    // caret — must cost one composite, not two.
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);
    let paints = 0;
    const paint = () => {
      paints += 1;
    };

    loop.schedulePaint(paint);
    loop.schedulePaint(paint);
    loop.schedulePaint(paint);

    expect(host.armed()).toHaveLength(1);
    host.fireAll();
    expect(paints).toBe(1);
  });

  it("can be armed again once it has fired", () => {
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);
    let paints = 0;
    const paint = () => {
      paints += 1;
    };

    loop.schedulePaint(paint);
    host.fireAll();
    expect(loop.hasPendingPaint).toBe(false);

    loop.schedulePaint(paint);
    host.fireAll();
    expect(paints).toBe(2);
  });

  it("keeps the FIRST callback when several are queued in one turn", () => {
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);
    const ran: string[] = [];

    loop.schedulePaint(() => ran.push("first"));
    loop.schedulePaint(() => ran.push("second"));
    host.fireAll();

    expect(ran).toEqual(["first"]);
  });

  it("still paints after stop, which is what pausing does", () => {
    // `stopVideo` is `stop()` then `schedulePaint()`, in that order, to draw one
    // last frame at the paused position. A guard on `done` here would blank the
    // preview on every pause.
    const host = fakeScheduler();
    const loop = new PreviewLoop(host.scheduler);
    let paints = 0;

    loop.start(() => {});
    loop.stop();
    loop.schedulePaint(() => {
      paints += 1;
    });

    expect(host.armed()).toHaveLength(1);
    host.fireAll();
    expect(paints).toBe(1);
    expect(loop.isRunning).toBe(false);
  });
});

describe("chromeKey", () => {
  const lines = () =>
    linesFromWordGroups([
      [
        { word: "hello", start: 0, end: 1 },
        { word: "there", start: 2, end: 3 },
      ],
      [{ word: "again", start: 4, end: 5 }],
    ]);

  it("names the line and the word", () => {
    expect(chromeKey(lines(), 0.5)).toBe("0:0");
    expect(chromeKey(lines(), 2.5)).toBe("0:1");
    expect(chromeKey(lines(), 4.5)).toBe("1:0");
  });

  it("uses -1 for a line with no word being spoken", () => {
    expect(chromeKey(lines(), 1.5)).toBe("0:-1");
  });

  it("uses -1 for both outside every line", () => {
    expect(chromeKey(lines(), 99)).toBe("-1:-1");
    expect(chromeKey([], 0)).toBe("-1:-1");
  });

  it("never collides with the gate's initial empty string", () => {
    // `ChromeGate` starts at "", so the first call must always look different —
    // otherwise the very first frame of a transcript does not render.
    for (const t of [-1, 0, 1.5, 4.5, 99]) {
      expect(chromeKey(lines(), t)).not.toBe("");
    }
  });
});

describe("ChromeGate", () => {
  it("re-renders the first time it is asked", () => {
    expect(new ChromeGate().changed("0:0", "0:01 / 0:05")).toBe(true);
  });

  it("declines an unchanged frame", () => {
    const gate = new ChromeGate();
    gate.changed("0:0", "0:01");
    expect(gate.changed("0:0", "0:01")).toBe(false);
  });

  it("declines the same frame however many times it is asked", () => {
    const gate = new ChromeGate();
    gate.changed("0:0", "0:01");
    for (let i = 0; i < 60; i += 1) {
      expect(gate.changed("0:0", "0:01")).toBe(false);
    }
  });

  it("re-renders when the highlighted word moves", () => {
    const gate = new ChromeGate();
    gate.changed("0:0", "0:01");
    expect(gate.changed("0:1", "0:01")).toBe(true);
  });

  it("re-renders when only the readout moves", () => {
    const gate = new ChromeGate();
    gate.changed("0:0", "0:01");
    expect(gate.changed("0:0", "0:02")).toBe(true);
  });

  it("re-renders again after going back to a previous state", () => {
    // It remembers only the last frame, not a history — scrubbing backwards has
    // to repaint.
    const gate = new ChromeGate();
    gate.changed("0:0", "0:01");
    gate.changed("0:1", "0:02");
    expect(gate.changed("0:0", "0:01")).toBe(true);
  });
});

describe("chromeStateOf", () => {
  const lines = () => linesFromWordGroups([[{ word: "hi", start: 0, end: 1 }]]);

  it("pairs the key with the label the template renders", () => {
    expect(chromeStateOf(lines(), 0.5, 10)).toEqual({
      active: "0:0",
      label: playheadLabel(0.5, 10),
    });
  });

  it("gates on the rendered label, so it changes where the readout does", () => {
    // `formatPlayhead` floors. Gating on `Math.round` would hold the re-render
    // back across the very boundary the readout changes at, leaving it a second
    // stale — which is why the label itself is the key.
    const gate = new ChromeGate();
    const at = (t: number) => chromeStateOf(lines(), t, 10);

    const a = at(0.9);
    expect(gate.changed(a.active, a.label)).toBe(true);

    // Still 0:00 — floored — so nothing re-renders even though Math.round would
    // have called 0.9 a different second from 0.4.
    const b = at(0.4);
    expect(b.label).toBe(a.label);
    expect(gate.changed(b.active, b.label)).toBe(false);

    // Crossing 1.0 is where the readout actually changes.
    const c = at(1.05);
    expect(c.label).not.toBe(a.label);
    expect(gate.changed(c.active, c.label)).toBe(true);
  });

  it("drops about two orders of magnitude of re-renders across a still second", () => {
    // The reason the gate exists: sixty frames of a second in which nothing the
    // template shows has changed must produce one re-render, not sixty.
    const gate = new ChromeGate();
    let renders = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      const { active, label } = chromeStateOf(lines(), 0.1 + frame / 1000, 10);
      if (gate.changed(active, label)) renders += 1;
    }
    expect(renders).toBe(1);
  });
});
