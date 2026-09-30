import { describe, expect, it } from "vitest";
import {
  IDLE_RULER,
  isStepSatisfied,
  pressRuler,
  releaseRuler,
  type TutorialSnapshot,
} from "./completion";

const snap = (over: Partial<TutorialSnapshot> = {}): TutorialSnapshot => ({
  durationSec: 10,
  hasDirectory: false,
  elementCount: 0,
  textCount: 0,
  activeSidebarTab: "home",
  rulerMoves: 0,
  ...over,
});

describe("step completion", () => {
  describe("changes, which must happen after the step began", () => {
    it("counts a new duration, either way", () => {
      const c = { kind: "durationChanged" } as const;
      expect(isStepSatisfied(c, snap(), snap())).toBe(false);
      expect(isStepSatisfied(c, snap(), snap({ durationSec: 30 }))).toBe(true);
      expect(isStepSatisfied(c, snap(), snap({ durationSec: 5 }))).toBe(true);
    });

    // The settings panel mutates the store's object in place, so a duration
    // the field briefly holds as NaN (an emptied input) must not count.
    it("does not count a duration that is not a number", () => {
      const c = { kind: "durationChanged" } as const;
      expect(isStepSatisfied(c, snap(), snap({ durationSec: NaN }))).toBe(false);
      expect(isStepSatisfied(c, snap({ durationSec: NaN }), snap())).toBe(false);
    });

    it("counts an added clip, and not one that was already there", () => {
      const c = { kind: "elementAdded" } as const;
      const before = snap({ elementCount: 3 });
      expect(isStepSatisfied(c, before, snap({ elementCount: 3 }))).toBe(false);
      expect(isStepSatisfied(c, before, snap({ elementCount: 2 }))).toBe(false);
      expect(isStepSatisfied(c, before, snap({ elementCount: 4 }))).toBe(true);
    });

    it("counts only a text for the text step", () => {
      const c = { kind: "textAdded" } as const;
      expect(isStepSatisfied(c, snap(), snap({ elementCount: 1 }))).toBe(false);
      expect(
        isStepSatisfied(c, snap(), snap({ elementCount: 1, textCount: 1 })),
      ).toBe(true);
    });

    it("counts a ruler gesture, not a moved cursor", () => {
      const c = { kind: "playheadMoved" } as const;
      expect(isStepSatisfied(c, snap(), snap())).toBe(false);
      expect(isStepSatisfied(c, snap(), snap({ rulerMoves: 1 }))).toBe(true);
    });
  });

  describe("states, which count whenever they hold", () => {
    it("counts the tab that is open, including one open before the step", () => {
      const file = { kind: "sidebarTab", tab: "draft" } as const;
      const open = snap({ activeSidebarTab: "draft" });

      expect(isStepSatisfied(file, snap(), snap())).toBe(false);
      expect(isStepSatisfied(file, snap(), open)).toBe(true);
      expect(isStepSatisfied(file, open, open)).toBe(true);
      expect(
        isStepSatisfied({ kind: "sidebarTab", tab: "text" }, snap(), open),
      ).toBe(false);
    });

    it("counts an open folder", () => {
      const c = { kind: "folderOpen" } as const;
      expect(isStepSatisfied(c, snap(), snap())).toBe(false);
      expect(isStepSatisfied(c, snap(), snap({ hasDirectory: true }))).toBe(true);
    });
  });
});

describe("ruler gesture", () => {
  it("counts a press that moved the playhead, on release", () => {
    const pressed = pressRuler(IDLE_RULER, 1000);
    expect(pressed.moves).toBe(0);

    const released = releaseRuler(pressed, 2500);
    expect(released).toEqual({ pressedAt: null, moves: 1 });
  });

  it("does not count a press that left the playhead where it was", () => {
    const released = releaseRuler(pressRuler(IDLE_RULER, 1000), 1000);
    expect(released).toEqual({ pressedAt: null, moves: 0 });
  });

  // Playback, the arrow keys and a click anywhere else all move the cursor
  // with no press on the ruler behind them.
  it("ignores a release with no press, by identity", () => {
    const gesture = { pressedAt: null, moves: 2 };
    expect(releaseRuler(gesture, 5000)).toBe(gesture);
  });

  it("ignores a press at a cursor that is not a number", () => {
    expect(pressRuler(IDLE_RULER, NaN)).toBe(IDLE_RULER);
  });

  it("keeps counting across gestures", () => {
    let gesture = IDLE_RULER;
    for (const [from, to] of [
      [0, 100],
      [100, 100],
      [100, 400],
    ]) {
      gesture = releaseRuler(pressRuler(gesture, from), to);
    }
    expect(gesture.moves).toBe(2);
  });
});
