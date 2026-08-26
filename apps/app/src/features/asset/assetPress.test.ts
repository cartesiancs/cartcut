/**
 * The boundaries of "click" versus "pick up", pinned to the millisecond and
 * the pixel. Both are invisible once this logic is inside pointer handlers.
 */

import { describe, it, expect } from "vitest";
import { DRAG } from "../timeline/dragMachine";
import { idlePress, reducePress, type PressEv, type PressState } from "./assetPress";

/** Fold a whole gesture, the way the tile does across one press. */
function run(events: PressEv[], from: PressState = idlePress) {
  let state = from;
  const effects: string[] = [];
  for (const ev of events) {
    const next = reducePress(state, ev);
    state = next.state;
    effects.push(...next.effects.map((e) => e.type));
  }
  return { state, effects };
}

const down = (t = 0, x = 100, y = 100): PressEv => ({ type: "down", x, y, t });

describe("reducePress", () => {
  it("uses the same hold as lifting a clip off its track", () => {
    // Holding to pick something up has to feel the same in both halves of the
    // editor, so the constant is shared rather than copied.
    expect(DRAG.LONG_PRESS_MS).toBe(220);
    expect(DRAG.MOVE_CANCEL_PX).toBe(4);
  });

  it("starts undecided on pointerdown", () => {
    const { state, effects } = run([down(1000)]);

    expect(state.phase).toBe("pressed");
    expect(state.origin).toEqual({ x: 100, y: 100 });
    expect(state.downT).toBe(1000);
    expect(effects).toEqual([]);
  });

  describe("the hold", () => {
    it("is not complete at 219ms", () => {
      const { state, effects } = run([down(0), { type: "tick", t: 219 }]);

      expect(state.phase).toBe("pressed");
      expect(effects).toEqual([]);
    });

    it("completes at exactly 220ms", () => {
      const { state, effects } = run([down(0), { type: "tick", t: 220 }]);

      expect(state.phase).toBe("armed");
      expect(effects).toEqual(["arm"]);
    });

    it("completes from a late move, not only from the clock", () => {
      // The pointer sat still past the hold, then set off. That is an armed
      // drag; treating the travel as a cancel would lose it.
      const { state, effects } = run([
        down(0),
        { type: "move", x: 400, y: 100, t: 300 },
      ]);

      expect(state.phase).toBe("armed");
      expect(effects).toEqual(["arm"]);
    });

    it("arms only once however many ticks arrive", () => {
      const { state, effects } = run([
        down(0),
        { type: "tick", t: 300 },
        { type: "tick", t: 400 },
        { type: "move", x: 160, y: 100, t: 500 },
      ]);

      expect(state.phase).toBe("armed");
      expect(effects).toEqual(["arm"]);
    });

    it("keeps its origin and start time while undecided", () => {
      const { state } = run([down(1000), { type: "move", x: 102, y: 101, t: 1100 }]);

      expect(state.origin).toEqual({ x: 100, y: 100 });
      expect(state.downT).toBe(1000);
    });
  });

  describe("moving before the hold completes", () => {
    it("tolerates 4px of shake", () => {
      const { state, effects } = run([
        down(0),
        { type: "move", x: 104, y: 100, t: 50 },
      ]);

      expect(state.phase).toBe("pressed");
      expect(effects).toEqual([]);
    });

    it("gives up at 5px", () => {
      const { state, effects } = run([
        down(0),
        { type: "move", x: 105, y: 100, t: 50 },
      ]);

      expect(state.phase).toBe("idle");
      expect(effects).toEqual(["disarm"]);
    });

    it("measures travel diagonally, not per axis", () => {
      // 3 across and 3 down is 4.24 of travel: past the tolerance, even though
      // neither axis alone reaches it. Comparing axes separately would let a
      // diagonal flick through.
      const diagonal = run([down(0), { type: "move", x: 103, y: 103, t: 50 }]);
      expect(diagonal.state.phase).toBe("idle");

      // 3-4-5 — a clean 5 of travel, and gone.
      const past = run([down(0), { type: "move", x: 103, y: 104, t: 50 }]);
      expect(past.state.phase).toBe("idle");

      // Straight down by exactly the tolerance is still a press.
      const atTolerance = run([down(0), { type: "move", x: 100, y: 104, t: 50 }]);
      expect(atTolerance.state.phase).toBe("pressed");
    });

    it("leaves nothing behind — no drag and no click", () => {
      // A flick across the panel that added a clip at the playhead would be a
      // surprise every time someone scrolled.
      const { state, effects } = run([
        down(0),
        { type: "move", x: 100, y: 300, t: 50 },
        { type: "up", t: 90 },
      ]);

      expect(state.phase).toBe("idle");
      expect(effects).toEqual(["disarm"]);
      expect(effects).not.toContain("open");
    });
  });

  describe("releasing", () => {
    it("is a click when the hold never completed", () => {
      const { state, effects } = run([down(0), { type: "up", t: 100 }]);

      expect(state).toEqual(idlePress);
      expect(effects).toEqual(["open"]);
    });

    it("is a click right up to the hold boundary", () => {
      const { effects } = run([
        down(0),
        { type: "move", x: 101, y: 100, t: 219 },
        { type: "up", t: 219 },
      ]);

      expect(effects).toEqual(["open"]);
    });

    it("is still a click when the press outlasted the hold", () => {
      // The regression that broke clicking outright. Arming was read as "the
      // user wants to drag", so a press slower than 220ms — which an unhurried
      // click easily is — added nothing at all. Pressing and releasing on the
      // spot means "add this" however long it took.
      const { state, effects } = run([
        down(0),
        { type: "tick", t: 220 },
        { type: "up", t: 400 },
      ]);

      expect(state).toEqual(idlePress);
      expect(effects).toEqual(["arm", "disarm", "open"]);
    });

    it("is a click at any duration, as long as no drag began", () => {
      for (const heldMs of [0, 100, 219, 220, 400, 1500, 10_000]) {
        const { effects } = run([
          down(0),
          { type: "tick", t: heldMs },
          { type: "up", t: heldMs },
        ]);

        expect(effects.filter((e) => e === "open")).toHaveLength(1);
      }
    });

    it("adds nothing once a drag actually started", () => {
      // The drop target has already placed the asset where the user aimed; a
      // second copy at the playhead would be wrong.
      const { state, effects } = run([
        down(0),
        { type: "tick", t: 220 },
        { type: "dragstart" },
        { type: "cancel" },
      ]);

      expect(state).toEqual(idlePress);
      expect(effects).toEqual(["arm", "disarm"]);
      expect(effects).not.toContain("open");
    });

    it("does nothing on a stray up with no press", () => {
      const { state, effects } = run([{ type: "up", t: 10 }]);

      expect(state).toBe(idlePress);
      expect(effects).toEqual([]);
    });
  });

  describe("starting a drag", () => {
    it("is refused until the hold completes", () => {
      // The reducer refuses by not advancing; the component turns that into
      // `preventDefault`. Needed because `draggable` can still be on for a
      // frame after the attribute is written.
      const pressed = run([down(0)]).state;
      const next = reducePress(pressed, { type: "dragstart" });

      expect(next.state).toBe(pressed);
      expect(next.state.phase).toBe("pressed");
    });

    it("is refused when nothing is pressed at all", () => {
      const next = reducePress(idlePress, { type: "dragstart" });

      expect(next.state).toBe(idlePress);
    });

    it("is allowed once armed", () => {
      const { state } = run([
        down(0),
        { type: "tick", t: 220 },
        { type: "dragstart" },
      ]);

      expect(state.phase).toBe("dragging");
    });

    it("ignores a second dragstart while already dragging", () => {
      const dragging = run([
        down(0),
        { type: "tick", t: 220 },
        { type: "dragstart" },
      ]).state;

      expect(reducePress(dragging, { type: "dragstart" }).state).toBe(dragging);
    });
  });

  describe("cancelling", () => {
    it("disarms after a drag ends", () => {
      // `dragend` is what puts `draggable` back off; without it the tile stays
      // armed and the next plain click drags instead.
      const { state, effects } = run([
        down(0),
        { type: "tick", t: 220 },
        { type: "cancel" },
      ]);

      expect(state).toEqual(idlePress);
      expect(effects).toEqual(["arm", "disarm"]);
    });

    it("abandons an undecided press", () => {
      const { state, effects } = run([down(0), { type: "cancel" }]);

      expect(state).toEqual(idlePress);
      expect(effects).toEqual(["disarm"]);
    });

    it("is a no-op when nothing is pressed", () => {
      const { state, effects } = run([{ type: "cancel" }]);

      expect(state).toBe(idlePress);
      expect(effects).toEqual([]);
    });
  });

  describe("reporting no change by identity", () => {
    it("ignores movement with no press behind it", () => {
      const next = reducePress(idlePress, { type: "move", x: 5, y: 5, t: 1 });

      expect(next.state).toBe(idlePress);
    });

    it("ignores a tick with no press behind it", () => {
      const next = reducePress(idlePress, { type: "tick", t: 999 });

      expect(next.state).toBe(idlePress);
    });

    it("ignores a tick once armed", () => {
      const armed = run([down(0), { type: "tick", t: 220 }]).state;
      const next = reducePress(armed, { type: "tick", t: 900 });

      expect(next.state).toBe(armed);
      expect(next.effects).toEqual([]);
    });

    it("ignores movement once armed — the browser owns the drag now", () => {
      const armed = run([down(0), { type: "tick", t: 220 }]).state;
      const next = reducePress(armed, { type: "move", x: 900, y: 900, t: 500 });

      expect(next.state).toBe(armed);
      expect(next.effects).toEqual([]);
    });

    it("does not mutate the state handed to it", () => {
      const start = run([down(0)]).state;
      const snapshot = JSON.parse(JSON.stringify(start));

      reducePress(start, { type: "tick", t: 220 });

      expect(start).toEqual(snapshot);
    });
  });

  describe("a whole gesture, end to end", () => {
    it("click: down, up, one add at the playhead", () => {
      expect(run([down(0), { type: "up", t: 120 }]).effects).toEqual(["open"]);
    });

    it("slow click: down, hold past 220ms, up — still one add", () => {
      const { effects } = run([
        down(0),
        { type: "tick", t: 220 },
        { type: "up", t: 600 },
      ]);

      expect(effects).toEqual(["arm", "disarm", "open"]);
    });

    it("drag: down, hold, drag away, dragend — placed by the drop, not here", () => {
      // The browser stops sending pointer events once a native drag begins, so
      // the gesture ends in `dragend` with no `up` at all.
      const { state, effects } = run([
        down(0),
        { type: "tick", t: 220 },
        { type: "dragstart" },
        { type: "cancel" },
      ]);

      expect(state).toEqual(idlePress);
      expect(effects).toEqual(["arm", "disarm"]);
    });

    it("scroll: down, drag the panel, up — nothing at all", () => {
      const { effects } = run([
        down(0),
        { type: "move", x: 100, y: 140, t: 40 },
        { type: "move", x: 100, y: 260, t: 90 },
        { type: "up", t: 140 },
      ]);

      expect(effects).toEqual(["disarm"]);
    });

    it("a second press after a drag behaves like the first", () => {
      const after = run([down(0), { type: "tick", t: 220 }, { type: "cancel" }]).state;
      const { state, effects } = run([down(1000), { type: "up", t: 1100 }], after);

      expect(state).toEqual(idlePress);
      expect(effects).toEqual(["open"]);
    });
  });
});
