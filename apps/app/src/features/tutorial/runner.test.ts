import { describe, expect, it } from "vitest";
import type { OnboardingFlagPort } from "../onboarding/onboardingFlag";
import type { TutorialSnapshot } from "./completion";
import { DONE_FLASH_MS, FALLBACK_SETTLE_MS } from "./motion";
import type { Rect } from "./placement";
import {
  createTutorialRunner,
  type CardLayout,
  type CardModel,
  type TutorialEnv,
} from "./runner";
import { TUTORIAL_STEPS, type TargetId } from "./steps";

const FRAME_MS = 16;

const at = (left: number, top: number, width = 40, height = 40): Rect => ({
  left,
  top,
  width,
  height,
});

/**
 * The editor, the card, the flag and the frame clock, all in memory.
 *
 * The editor starts where a first-run user's does: the Settings tab open, the
 * Duration row on screen, no folder, an empty timeline.
 */
function harness(options: { finishedBefore?: boolean } = {}) {
  const editor = {
    snapshot: {
      durationSec: 10,
      hasDirectory: false,
      elementCount: 0,
      textCount: 0,
      activeSidebarTab: "home",
      rulerMoves: 0,
    } as TutorialSnapshot,
    targets: new Map<TargetId, Rect>([
      ["sidebar-settings", at(0, 40)],
      ["sidebar-file", at(0, 80)],
      ["sidebar-text", at(0, 120)],
      ["timeline-ruler", at(0, 560, 1440, 24)],
      ["project-duration", at(60, 200, 300, 38)],
    ]),
    clipped: new Set<TargetId>(),
    suspended: false,
    reveals: [] as TargetId[],
    watching: 0,
    unwatched: 0,
  };

  const env: TutorialEnv = {
    snapshot: () => ({ ...editor.snapshot }),
    probe: (target) => {
      const rect = editor.targets.get(target);
      return rect ? { rect, clipped: editor.clipped.has(target) } : null;
    },
    playheadX: () => 500,
    reveal: (target) => void editor.reveals.push(target),
    viewport: () => ({ w: 1440, h: 900, insetTop: 34 }),
    suspended: () => editor.suspended,
    watch: () => {
      editor.watching += 1;
      return () => void (editor.unwatched += 1);
    },
  };

  const shown: (CardModel | null)[] = [];
  const placed: (CardLayout | null)[] = [];

  const stored = { value: options.finishedBefore ? true : null } as {
    value: boolean | null;
  };
  const flag: OnboardingFlagPort = {
    name: "tutorial",
    readMirror: () => null,
    writeMirror: () => {},
    clearMirror: () => {},
    readStored: async () =>
      stored.value === null ? undefined : { value: stored.value },
    writeStored: (value) => void (stored.value = value),
    clearStored: () => void (stored.value = null),
    warn: () => {},
  };

  const frames = new Map<number, () => void>();
  let nextId = 1;
  let clock = 1000;

  const runner = createTutorialRunner({
    env,
    view: {
      show: (model) => void shown.push(model),
      cardSize: () => ({ w: 280, h: 160 }),
      place: (layout) => void placed.push(layout),
    },
    flag,
    scheduler: {
      request: (callback) => {
        const id = nextId++;
        frames.set(id, callback);
        return id;
      },
      cancel: (id) => void frames.delete(id),
    },
    now: () => clock,
  });

  /** Run `count` frames, each `ms` apart. */
  const tick = (count = 1, ms = FRAME_MS) => {
    for (let i = 0; i < count; i++) {
      clock += ms;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback();
    }
  };

  /** Long enough for any check-mark flash to end. */
  const flash = () => tick(Math.ceil(DONE_FLASH_MS / FRAME_MS) + 1);

  const step = () => {
    const s = runner.state;
    return s.kind === "running" ? s.step : s.kind;
  };

  const lastModel = () => shown[shown.length - 1];

  /** Skip ahead to a step by pressing Next. */
  const goTo = (index: number) => {
    while (runner.state.kind === "running" && runner.state.step < index) {
      runner.next();
    }
  };

  return {
    runner,
    editor,
    shown,
    placed,
    stored,
    frames,
    tick,
    flash,
    step,
    lastModel,
    goTo,
  };
}

const stepIndex = (id: string) =>
  TUTORIAL_STEPS.findIndex((step) => step.id === id);

describe("tutorial runner", () => {
  describe("starting", () => {
    it("starts at the first step for someone who has not seen it", async () => {
      const h = harness();

      await expect(h.runner.startIfNew()).resolves.toBe(true);

      expect(h.step()).toBe(0);
      expect(h.lastModel()).toEqual({
        step: 0,
        phase: "showing",
        hintKey: null,
        hidden: false,
      });
      expect(h.editor.watching).toBe(1);
    });

    it("stays away from someone who finished or skipped it before", async () => {
      const h = harness({ finishedBefore: true });

      await expect(h.runner.startIfNew()).resolves.toBe(false);

      expect(h.step()).toBe("idle");
      expect(h.shown).toEqual([]);
      expect(h.frames.size).toBe(0);
    });

    it("places the card beside its target before the first frame", async () => {
      const h = harness();
      await h.runner.startIfNew();

      const layout = h.placed[h.placed.length - 1]!;
      expect(layout.card.side).toBe("right");
      expect(layout.ring).not.toBeNull();
    });
  });

  describe("judging a step", () => {
    it("counts only what happens after the step began", async () => {
      const h = harness();
      h.editor.snapshot.durationSec = 30;
      await h.runner.startIfNew();

      h.tick(3);
      expect(h.lastModel()?.phase).toBe("showing");

      h.editor.snapshot.durationSec = 45;
      h.tick();
      expect(h.lastModel()?.phase).toBe("done");

      h.flash();
      expect(h.step()).toBe(1);
    });

    it("completes a tab that was already open as the step began", async () => {
      const h = harness();
      h.editor.snapshot.activeSidebarTab = "draft";
      await h.runner.startIfNew();
      h.runner.next();

      h.tick();
      expect(h.lastModel()).toMatchObject({ step: 1, phase: "done" });

      h.flash();
      expect(h.step()).toBe(stepIndex("folder"));
    });

    it("moves on once when Next is pressed during the flash", async () => {
      const h = harness();
      await h.runner.startIfNew();

      h.editor.snapshot.durationSec = 20;
      h.tick();
      h.runner.next();
      expect(h.step()).toBe(1);

      h.flash();
      expect(h.step()).toBe(1);
    });

    it("leaves the folder step where it was when the dialog is cancelled", async () => {
      const h = harness();
      await h.runner.startIfNew();
      h.goTo(stepIndex("folder"));

      // Cancelling the native dialog changes nothing at all.
      h.tick(20);

      expect(h.step()).toBe(stepIndex("folder"));
      expect(h.lastModel()?.phase).toBe("showing");
    });

    // Opening the Text tab and clicking the Text tile straight away puts the
    // text on the timeline during the tab step's flash, before the text step
    // has begun.
    it("counts what the user did during the previous step's flash", async () => {
      const h = harness();
      await h.runner.startIfNew();
      h.goTo(stepIndex("text-tab"));

      h.editor.snapshot.activeSidebarTab = "text";
      h.tick();
      expect(h.lastModel()?.phase).toBe("done");

      h.editor.snapshot.elementCount += 1;
      h.editor.snapshot.textCount += 1;
      h.flash();

      expect(h.step()).toBe(stepIndex("add-text"));
      h.tick();
      expect(h.lastModel()).toMatchObject({
        step: stepIndex("add-text"),
        phase: "done",
      });
    });

    it("does not take playback moving the cursor for the playhead step", async () => {
      const h = harness();
      await h.runner.startIfNew();
      h.goTo(stepIndex("playhead"));

      // The snapshot carries no cursor at all: only ruler gestures count.
      h.tick(10);
      expect(h.lastModel()?.phase).toBe("showing");

      h.editor.snapshot.rulerMoves = 1;
      h.tick();
      expect(h.lastModel()?.phase).toBe("done");
    });

    it("aims the playhead step's arrow at the playhead", async () => {
      const h = harness();
      await h.runner.startIfNew();
      h.goTo(stepIndex("playhead"));

      const { card } = h.placed[h.placed.length - 1]!;
      expect(card.side).toBe("top");
      expect(card.left + card.arrow).toBe(500);
    });
  });

  describe("pointing", () => {
    it("points at a prerequisite, with the reason, when the target is missing", async () => {
      const h = harness();
      await h.runner.startIfNew();
      h.editor.targets.set("asset-select-folder", at(80, 300, 120, 32));
      h.goTo(stepIndex("add-file"));

      expect(h.lastModel()?.hintKey).toBe("tutorial.hints.select_folder_first");
    });

    it("moves to a better target at once", async () => {
      const h = harness();
      await h.runner.startIfNew();
      h.goTo(stepIndex("add-file"));
      expect(h.lastModel()?.hintKey).toBe("tutorial.hints.open_file_tab");

      h.editor.targets.set("asset-file", at(80, 300, 100, 100));
      h.tick();

      expect(h.lastModel()?.hintKey).toBeNull();
    });

    it("rides out a target that disappears for less than the settle time", async () => {
      const h = harness();
      await h.runner.startIfNew();
      const rect = h.editor.targets.get("project-duration")!;

      h.editor.targets.delete("project-duration");
      h.tick(Math.floor(FALLBACK_SETTLE_MS / FRAME_MS) - 2);
      h.editor.targets.set("project-duration", rect);
      h.tick(3);

      expect(h.shown.every((model) => model?.hintKey == null)).toBe(true);
    });

    it("falls back once the target has been gone for the settle time", async () => {
      const h = harness();
      await h.runner.startIfNew();

      h.editor.targets.delete("project-duration");
      h.tick(Math.ceil(FALLBACK_SETTLE_MS / FRAME_MS) + 2);

      expect(h.lastModel()?.hintKey).toBe("tutorial.hints.open_settings");
    });

    it("scrolls a clipped target into view once, not every frame", async () => {
      const h = harness();
      h.editor.clipped.add("project-duration");
      await h.runner.startIfNew();

      h.tick(10);

      expect(h.editor.reveals).toEqual(["project-duration"]);
    });

    it("tells the view nothing on a frame where nothing moved", async () => {
      const h = harness();
      await h.runner.startIfNew();
      h.tick();
      const shows = h.shown.length;
      const places = h.placed.length;

      h.tick(30);

      expect(h.shown.length).toBe(shows);
      expect(h.placed.length).toBe(places);
    });

    it("re-places the card when its target moves", async () => {
      const h = harness();
      await h.runner.startIfNew();
      const places = h.placed.length;

      h.editor.targets.set("project-duration", at(60, 260, 300, 38));
      h.tick();

      expect(h.placed.length).toBe(places + 1);
    });
  });

  describe("while something is in front of the editor", () => {
    it("hides the card and judges nothing until it is gone", async () => {
      const h = harness();
      await h.runner.startIfNew();

      h.editor.suspended = true;
      h.editor.snapshot.durationSec = 90;
      h.tick(5);

      expect(h.lastModel()).toMatchObject({ phase: "showing", hidden: true });
      expect(h.placed[h.placed.length - 1]).toBeNull();

      h.editor.suspended = false;
      h.tick();
      expect(h.lastModel()).toMatchObject({ phase: "done", hidden: false });
    });
  });

  describe("ending", () => {
    it("records a finish, takes the card away and stops listening", async () => {
      const h = harness();
      await h.runner.startIfNew();
      h.goTo(stepIndex("add-text"));

      h.editor.snapshot.textCount = 1;
      h.tick();
      h.flash();

      expect(h.runner.state).toEqual({ kind: "finished", outcome: "completed" });
      expect(h.stored.value).toBe(true);
      expect(h.shown[h.shown.length - 1]).toBeNull();
      expect(h.placed[h.placed.length - 1]).toBeNull();
      expect(h.frames.size).toBe(0);
      expect(h.editor.unwatched).toBe(1);
    });

    it("records a skip the same way", async () => {
      const h = harness();
      await h.runner.startIfNew();
      h.tick();

      h.runner.skip();

      expect(h.runner.state).toEqual({ kind: "finished", outcome: "skipped" });
      expect(h.stored.value).toBe(true);
      expect(h.frames.size).toBe(0);
      expect(h.editor.unwatched).toBe(1);
    });

    it("finishes on Next from the last step", async () => {
      const h = harness();
      await h.runner.startIfNew();
      h.goTo(TUTORIAL_STEPS.length - 1);

      h.runner.next();

      expect(h.runner.state).toEqual({ kind: "finished", outcome: "completed" });
    });

    it("runs again from the first step when asked to, after finishing", async () => {
      const h = harness();
      await h.runner.startIfNew();
      h.runner.skip();

      h.runner.restart();

      expect(h.step()).toBe(0);
      expect(h.editor.watching).toBe(2);
      expect(h.frames.size).toBe(1);
    });

    // Help > Reset Onboarding: the tour comes back, and the tutorial has to be
    // ready to follow it from the first step rather than carry on hidden.
    it("goes back to before it began when reset, recording nothing", async () => {
      const h = harness();
      await h.runner.startIfNew();
      h.goTo(stepIndex("playhead"));
      h.tick();

      h.runner.reset();

      expect(h.runner.state).toEqual({ kind: "idle" });
      expect(h.shown[h.shown.length - 1]).toBeNull();
      expect(h.placed[h.placed.length - 1]).toBeNull();
      expect(h.frames.size).toBe(0);
      expect(h.editor.unwatched).toBe(1);
      expect(h.stored.value).toBeNull();

      await expect(h.runner.startIfNew()).resolves.toBe(true);
      expect(h.step()).toBe(0);
      expect(h.editor.watching).toBe(2);
    });

    it("does nothing when reset while it is not running", () => {
      const h = harness();

      h.runner.reset();

      expect(h.shown).toEqual([]);
      expect(h.placed).toEqual([]);
      expect(h.editor.unwatched).toBe(0);
    });

    it("stops everything when disposed, without recording anything", async () => {
      const h = harness();
      await h.runner.startIfNew();
      h.tick();

      h.runner.dispose();
      h.runner.next();

      expect(h.frames.size).toBe(0);
      expect(h.stored.value).toBeNull();
      expect(h.editor.unwatched).toBe(1);
    });
  });
});
