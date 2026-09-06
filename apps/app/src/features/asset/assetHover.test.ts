/**
 * The boundary between "passing over a tile" and "looking at one", pinned to
 * the millisecond, and the rules that keep the preview out of the way of the
 * click and the drag that share its pointer stream.
 */

import { describe, it, expect } from "vitest";
import { DRAG } from "../timeline/dragMachine";
import {
  HOVER,
  idleHover,
  reduceHover,
  type HoverEv,
  type HoverState,
} from "./assetHover";

/** Fold a whole hover, the way the tile does across one visit. */
function run(events: HoverEv[], from: HoverState = idleHover) {
  let state = from;
  const effects: string[] = [];
  for (const ev of events) {
    const next = reduceHover(state, ev);
    state = next.state;
    effects.push(...next.effects.map((e) => e.type));
  }
  return { state, effects };
}

const enter = (t = 0, x = 100, y = 100): HoverEv => ({ type: "enter", x, y, t });

/** Enter, then rest until the preview is up. */
function opened(x = 100, y = 100) {
  return reduceHover(
    reduceHover(idleHover, enter(0, x, y)).state,
    { type: "tick", t: HOVER.DWELL_MS },
  ).state;
}

describe("reduceHover", () => {
  it("waits 800ms — long enough that passing over a tile is not a request", () => {
    expect(HOVER.DWELL_MS).toBe(800);
    // And clear of the press hold, or every gesture about to become a drag
    // would open a preview on its way.
    expect(HOVER.DWELL_MS).toBeGreaterThan(DRAG.LONG_PRESS_MS * 2);
  });

  it("starts waiting on enter, and shows nothing yet", () => {
    const { state, effects } = run([enter(1000)]);

    expect(state.phase).toBe("dwelling");
    expect(state.cursor).toEqual({ x: 100, y: 100 });
    expect(state.enterT).toBe(1000);
    expect(effects).toEqual([]);
  });

  describe("the dwell", () => {
    it("has not completed at 799ms", () => {
      const { state, effects } = run([enter(0), { type: "tick", t: 799 }]);

      expect(state.phase).toBe("dwelling");
      expect(effects).toEqual([]);
    });

    it("completes at exactly 800ms", () => {
      const { state, effects } = run([enter(0), { type: "tick", t: 800 }]);

      expect(state.phase).toBe("open");
      expect(effects).toEqual(["open"]);
    });

    it("does not restart when the pointer moves inside the tile", () => {
      // The decision this suite exists to protect. A cursor on a trackpad never
      // sits perfectly still, so a dwell that resets on movement never fires.
      const { state, effects } = run([
        enter(0),
        { type: "move", x: 104, y: 100, t: 200 },
        { type: "move", x: 108, y: 103, t: 500 },
        { type: "move", x: 101, y: 99, t: 780 },
        { type: "tick", t: 800 },
      ]);

      expect(state.phase).toBe("open");
      expect(effects).toEqual(["open"]);
    });

    it("completes on a move, not only on the clock", () => {
      const { state, effects } = run([
        enter(0),
        { type: "move", x: 140, y: 120, t: 900 },
      ]);

      expect(state.phase).toBe("open");
      expect(effects).toEqual(["open"]);
    });

    it("opens where the cursor last was, not where it entered", () => {
      // `tick` carries no coordinates, so a preview opened by the clock has to
      // take them from somewhere.
      const { state, effects } = reduceHover(
        reduceHover(
          reduceHover(idleHover, enter(0, 100, 100)).state,
          { type: "move", x: 260, y: 340, t: 300 },
        ).state,
        { type: "tick", t: 800 },
      );

      expect(state.phase).toBe("open");
      expect(effects).toEqual([{ type: "open", x: 260, y: 340 }]);
    });

    it("opens only once however many ticks arrive", () => {
      const { state, effects } = run([
        enter(0),
        { type: "tick", t: 800 },
        { type: "tick", t: 1200 },
        { type: "tick", t: 3000 },
      ]);

      expect(state.phase).toBe("open");
      expect(effects).toEqual(["open"]);
    });

    it("ignores a second enter while the preview is up", () => {
      // The overlay is a singleton; opening it twice would lose the first
      // one's teardown.
      const { state, effects } = reduceHover(opened(), enter(5000, 400, 400));

      expect(state.phase).toBe("open");
      expect(effects).toEqual([]);
    });
  });

  describe("while open", () => {
    it("follows the cursor", () => {
      const { state, effects } = reduceHover(opened(), {
        type: "move",
        x: 320,
        y: 210,
        t: 2500,
      });

      expect(state.phase).toBe("open");
      expect(state.cursor).toEqual({ x: 320, y: 210 });
      expect(effects).toEqual([{ type: "move", x: 320, y: 210 }]);
    });

    it("closes when the pointer leaves", () => {
      const { state, effects } = reduceHover(opened(), { type: "leave" });

      expect(state.phase).toBe("idle");
      expect(effects).toEqual([{ type: "close" }]);
    });

    it("closes on cancel — a wheel, a drag, a blur", () => {
      const { state, effects } = reduceHover(opened(), { type: "cancel" });

      expect(state.phase).toBe("idle");
      expect(effects).toEqual([{ type: "close" }]);
    });
  });

  describe("closing", () => {
    it("says nothing when there was nothing open", () => {
      // A `close` from a tile that never opened anything would tear down the
      // preview a *different* tile owns.
      expect(run([enter(0), { type: "leave" }]).effects).toEqual([]);
      expect(run([enter(0), { type: "cancel" }]).effects).toEqual([]);
      expect(run([{ type: "leave" }]).effects).toEqual([]);
      expect(run([{ type: "cancel" }]).effects).toEqual([]);
    });

    it("declines by identity when there is nothing to do", () => {
      for (const ev of [
        { type: "leave" },
        { type: "cancel" },
        { type: "press" },
        { type: "tick", t: 9000 },
      ] as HoverEv[]) {
        expect(reduceHover(idleHover, ev).state).toBe(idleHover);
      }
    });
  });

  describe("a press", () => {
    it("closes the preview and does not reopen it on the same visit", () => {
      // Clicking adds the asset at the playhead and leaves the cursor exactly
      // where it was. Without suppression the preview reappears 800ms later,
      // over an edit the user has moved on from.
      const afterPress = reduceHover(opened(), { type: "press" });

      expect(afterPress.state.phase).toBe("suppressed");
      expect(afterPress.effects).toEqual([{ type: "close" }]);

      const later = run(
        [
          { type: "move", x: 130, y: 130, t: 4000 },
          { type: "tick", t: 9000 },
        ],
        afterPress.state,
      );

      expect(later.state.phase).toBe("suppressed");
      expect(later.effects).toEqual([]);
    });

    it("cancels a dwell that had not finished", () => {
      const { state, effects } = run([
        enter(0),
        { type: "press" },
        { type: "tick", t: 5000 },
      ]);

      expect(state.phase).toBe("suppressed");
      expect(effects).toEqual([]);
    });

    it("lets the tile hover again once the pointer has left and come back", () => {
      const { state, effects } = run([
        enter(0),
        { type: "press" },
        { type: "leave" },
        enter(10_000),
        { type: "tick", t: 12_000 },
      ]);

      expect(state.phase).toBe("open");
      expect(effects).toEqual(["open"]);
    });
  });

  describe("a move with no enter behind it", () => {
    it("starts the dwell anyway, for a window focused with the pointer already on a tile", () => {
      // `pointerenter` does not fire when the window regains focus, and this
      // module's own `blur` cancel is what left the tile in `idle`. Without
      // this the feature is dead until the pointer leaves and comes back.
      const { state, effects } = run([
        { type: "move", x: 10, y: 10, t: 5000 },
        { type: "tick", t: 7000 },
      ]);

      expect(state.phase).toBe("open");
      expect(effects).toEqual(["open"]);
    });

    it("re-arms after a cancel, but only once another 800ms have passed", () => {
      // A wheel cancels while the pointer is still on the tile and still
      // moving. Scrolling holds it shut because every wheel cancels again;
      // resting after the scroll is a fresh dwell, which is what should happen.
      const midScroll = run([
        enter(0),
        { type: "tick", t: 800 },
        { type: "cancel" },
        // A fresh dwell starts here, so it is 1700 that opens it, not 800.
        { type: "move", x: 120, y: 120, t: 900 },
        { type: "tick", t: 1200 },
      ]);

      expect(midScroll.state.phase).toBe("dwelling");
      expect(midScroll.effects).toEqual(["open", "close"]);

      const settled = run([{ type: "tick", t: 1700 }], midScroll.state);
      expect(settled.state.phase).toBe("open");
      expect(settled.effects).toEqual(["open"]);
    });

    it("cannot restart a hover that a press suppressed", () => {
      const { state, effects } = run([
        enter(0),
        { type: "press" },
        { type: "move", x: 120, y: 120, t: 2100 },
        { type: "tick", t: 9000 },
      ]);

      expect(state.phase).toBe("suppressed");
      expect(effects).toEqual([]);
    });
  });
});
