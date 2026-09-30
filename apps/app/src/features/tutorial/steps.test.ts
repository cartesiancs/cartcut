import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ALWAYS_PRESENT,
  TARGET_SELECTORS,
  TUTORIAL_STEPS,
  counterLabel,
  isLastStep,
  type TargetId,
} from "./steps";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const locale = (name: "en" | "ko") =>
  JSON.parse(read(`../../locale/${name}.json`)) as Record<string, unknown>;

const lookup = (json: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (at, key) =>
        at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined,
      json,
    );

/** Every key a step can put on the card. */
const stepKeys = () => [
  "tutorial.label",
  "tutorial.skip",
  "tutorial.next",
  "tutorial.finish",
  "tutorial.done",
  ...TUTORIAL_STEPS.flatMap((step) => [
    step.titleKey,
    step.bodyKey,
    ...step.targets.flatMap((c) => (c.hintKey ? [c.hintKey] : [])),
  ]),
];

/**
 * Where each `data-tutorial` target is written, so a renamed attribute or a
 * rewritten template fails here rather than leaving a step with nothing to
 * point at.
 */
const TARGET_SOURCES: Record<Exclude<TargetId, "settings-canvas-tab">, string> = {
  "sidebar-settings": "../../ui/control/Control.ts",
  "sidebar-file": "../../ui/control/Control.ts",
  "sidebar-text": "../../ui/control/Control.ts",
  "project-duration": "../../ui/control/ControlSetting.ts",
  "asset-select-folder": "../asset/assetBrowser.ts",
  "asset-change-folder": "../asset/assetBrowser.ts",
  "asset-file": "../asset/assetList.ts",
  "asset-folder": "../asset/assetList.ts",
  "timeline-ruler": "../element/elementTimelineRuler.ts",
  "text-default": "../../ui/control/ControlText.ts",
};

describe("tutorial steps", () => {
  it("is the seven steps, in the order they were asked for", () => {
    expect(TUTORIAL_STEPS.map((step) => step.id)).toEqual([
      "duration",
      "file-tab",
      "folder",
      "add-file",
      "playhead",
      "text-tab",
      "add-text",
    ]);
  });

  it("gives every target a selector", () => {
    for (const step of TUTORIAL_STEPS) {
      for (const { target } of step.targets) {
        expect(TARGET_SELECTORS[target], target).toBeTruthy();
      }
    }
  });

  // A step whose every target can be missing would leave the card pointing at
  // nothing the moment the user wanders off.
  it("ends every step's list with something that is always on screen", () => {
    for (const step of TUTORIAL_STEPS) {
      const last = step.targets[step.targets.length - 1];
      expect(ALWAYS_PRESENT.has(last.target), step.id).toBe(true);
    }
  });

  it("explains every prerequisite, and never the step's own target", () => {
    for (const step of TUTORIAL_STEPS) {
      expect(step.targets[0].hintKey, step.id).toBeUndefined();

      if (step.targets.length > 1) {
        const last = step.targets[step.targets.length - 1];
        expect(last.hintKey, step.id).toBeTruthy();
      }
    }
  });

  it("points the playhead step at the playhead", () => {
    const playhead = TUTORIAL_STEPS.find((step) => step.id === "playhead")!;
    expect(playhead.anchor).toBe("playhead");
    expect(playhead.targets.map((c) => c.target)).toEqual(["timeline-ruler"]);
  });

  it("counts from one", () => {
    expect(counterLabel(0)).toBe("1 / 7");
    expect(counterLabel(6)).toBe("7 / 7");
    expect(isLastStep(6)).toBe(true);
    expect(isLastStep(5)).toBe(false);
  });

  describe("copy", () => {
    for (const name of ["en", "ko"] as const) {
      it(`has every key in ${name}`, () => {
        const json = locale(name);
        for (const key of stepKeys()) {
          const value = lookup(json, key);
          expect(typeof value, `${name}: ${key}`).toBe("string");
          expect((value as string).length, `${name}: ${key}`).toBeGreaterThan(0);
        }
      });

      // CLAUDE.md's writing rule, applied where it would otherwise slip in.
      it(`uses no em-dash or middle dot in ${name}`, () => {
        const block = JSON.stringify(lookup(locale(name), "tutorial"));
        expect(block).not.toMatch(/[\u2014\u00b7]/);
      });
    }

    // `addText` inserts at 0ms, not at the playhead, so saying otherwise would
    // be a promise the click does not keep.
    it("does not promise the text lands at the playhead", () => {
      const body = lookup(locale("en"), "tutorial.steps.add_text.body") as string;
      expect(body.toLowerCase()).not.toContain("playhead");
    });
  });

  describe("wiring", () => {
    for (const [target, source] of Object.entries(TARGET_SOURCES)) {
      it(`finds ${target} in ${source.split("/").pop()}`, () => {
        expect(read(source)).toContain(`data-tutorial="${target}"`);
      });
    }

    it("finds the Canvas sub-tab by the attribute the tab bar already writes", () => {
      expect(TARGET_SELECTORS["settings-canvas-tab"]).toContain(
        'data-panel="canvas"',
      );
      expect(read("../option/optionTabBar.ts")).toContain("data-panel=${tab.id}");
      expect(read("../../ui/control/ControlSetting.ts")).toMatch(
        /id:\s*"canvas"/,
      );
    });
  });
});
