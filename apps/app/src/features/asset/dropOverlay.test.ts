/**
 * Three curtain bugs, pinned.
 *
 * It rose on internal drags and swallowed them; it stayed up forever when a
 * drag left the window without dropping; and it flickered across every child
 * element boundary on the way in.
 */

import { describe, it, expect } from "vitest";
import { idleOverlay, reduceOverlay, type OverlayState } from "./dropOverlay";

/** Fold a sequence, the way the component does across a whole drag. */
function run(
  events: Parameters<typeof reduceOverlay>[1][],
  from: OverlayState = idleOverlay,
): OverlayState {
  return events.reduce(reduceOverlay, from);
}

describe("reduceOverlay", () => {
  it("raises the curtain for files from outside", () => {
    const next = reduceOverlay(idleOverlay, {
      type: "enter",
      intent: "os-files",
    });

    expect(next.visible).toBe(true);
    expect(next.depth).toBe(1);
  });

  it("leaves an asset drag completely alone", () => {
    // The bug: the curtain covered the timeline canvas mid-drag, so the drop
    // the canvas was waiting for went to the curtain instead. Identity, not
    // just equality — the caller skips the re-render on it.
    const next = reduceOverlay(idleOverlay, { type: "enter", intent: "asset" });

    expect(next).toBe(idleOverlay);
  });

  it("leaves a text or link drag alone too", () => {
    const next = reduceOverlay(idleOverlay, { type: "enter", intent: "ignore" });

    expect(next).toBe(idleOverlay);
  });

  it("does not rise when an asset drag crosses many elements", () => {
    const next = run([
      { type: "enter", intent: "asset" },
      { type: "enter", intent: "asset" },
      { type: "leave" },
      { type: "enter", intent: "asset" },
    ]);

    expect(next.visible).toBe(false);
    expect(next.depth).toBe(0);
  });

  describe("crossing child elements", () => {
    it("stays up while the drag is still inside something", () => {
      // dragenter/dragleave pair off as the pointer crosses boundaries. Hiding
      // on the first `leave` is what made the old curtain strobe.
      const next = run([
        { type: "enter", intent: "os-files" },
        { type: "enter", intent: "os-files" },
        { type: "leave" },
      ]);

      expect(next.visible).toBe(true);
      expect(next.depth).toBe(1);
    });

    it("comes down once the last one is left", () => {
      const next = run([
        { type: "enter", intent: "os-files" },
        { type: "enter", intent: "os-files" },
        { type: "leave" },
        { type: "leave" },
      ]);

      expect(next.visible).toBe(false);
      expect(next.depth).toBe(0);
    });

    it("nests arbitrarily deep and still balances", () => {
      const enters = Array.from({ length: 7 }, () => ({
        type: "enter" as const,
        intent: "os-files" as const,
      }));
      const leaves = Array.from({ length: 7 }, () => ({ type: "leave" as const }));

      expect(run([...enters, ...leaves])).toEqual(idleOverlay);
    });
  });

  describe("never getting stuck", () => {
    it("comes down on a drop no matter how deep the drag was", () => {
      const deep = run([
        { type: "enter", intent: "os-files" },
        { type: "enter", intent: "os-files" },
        { type: "enter", intent: "os-files" },
      ]);

      expect(reduceOverlay(deep, { type: "drop" })).toEqual(idleOverlay);
    });

    it("comes down when the drag leaves the window without dropping", () => {
      // The bug that blocked the whole UI: `dragleave` and `drop` were bound to
      // the curtain while `dragenter` was on `document`, so escaping the window
      // mid-drag left it up with nothing able to take it down.
      const mid = reduceOverlay(idleOverlay, {
        type: "enter",
        intent: "os-files",
      });

      expect(reduceOverlay(mid, { type: "end" })).toEqual(idleOverlay);
    });

    it("cannot count below zero on unbalanced leaves", () => {
      // Chromium does emit a `dragleave` with no matching `dragenter` — after
      // a drop, and when a drag is cancelled. A negative depth would make the
      // next real drag need extra enters before the curtain appeared.
      const next = run([{ type: "leave" }, { type: "leave" }, { type: "leave" }]);

      expect(next.depth).toBe(0);
      expect(next.visible).toBe(false);
    });

    it("recovers cleanly for the next drag after being cancelled", () => {
      const after = run([
        { type: "enter", intent: "os-files" },
        { type: "enter", intent: "os-files" },
        { type: "end" },
        { type: "leave" },
        { type: "enter", intent: "os-files" },
      ]);

      expect(after).toEqual({ depth: 1, visible: true });
    });
  });

  it("reports no change by identity when already idle", () => {
    expect(reduceOverlay(idleOverlay, { type: "leave" })).toBe(idleOverlay);
    expect(reduceOverlay(idleOverlay, { type: "drop" })).toBe(idleOverlay);
    expect(reduceOverlay(idleOverlay, { type: "end" })).toBe(idleOverlay);
  });
});
