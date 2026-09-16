import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  HIDDEN_UPDATE,
  promptOf,
  reduceUpdate,
  shouldInstall,
  type UpdateView,
} from "./updateView";

function locale(name: string): Record<string, unknown> {
  const path = fileURLToPath(
    new URL(`../../locale/${name}.json`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

function lookup(dict: Record<string, unknown>, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      dict,
    );
}

describe("reduceUpdate", () => {
  it("maps each event main sends to a card", () => {
    const steps: Array<[unknown, UpdateView]> = [
      [
        { kind: "available", version: "0.5.7" },
        { phase: "available", version: "0.5.7" },
      ],
      [
        { kind: "progress", version: "0.5.7", percent: 42 },
        { phase: "downloading", version: "0.5.7", percent: 42 },
      ],
      [
        { kind: "preparing", version: "0.5.7" },
        { phase: "preparing", version: "0.5.7" },
      ],
      [
        { kind: "downloaded", version: "0.5.7" },
        { phase: "ready", version: "0.5.7" },
      ],
      [
        { kind: "failed", version: "0.5.7", message: "socket hang up" },
        { phase: "failed", version: "0.5.7", message: "socket hang up" },
      ],
    ];

    let view = HIDDEN_UPDATE;
    for (const [event, expected] of steps) {
      view = reduceUpdate(view, event);
      expect(view).toEqual(expected);
    }
  });

  it("returns the same card when nothing changed", () => {
    const view = reduceUpdate(HIDDEN_UPDATE, {
      kind: "progress",
      version: "0.5.7",
      percent: 42,
    });

    expect(
      reduceUpdate(view, { kind: "progress", version: "0.5.7", percent: 42 }),
    ).toBe(view);
  });

  it("returns a new card when only the percent moved", () => {
    const view = reduceUpdate(HIDDEN_UPDATE, {
      kind: "progress",
      version: "0.5.7",
      percent: 42,
    });

    const next = reduceUpdate(view, {
      kind: "progress",
      version: "0.5.7",
      percent: 43,
    });
    expect(next).not.toBe(view);
    expect(next).toEqual({ phase: "downloading", version: "0.5.7", percent: 43 });
  });

  it("ignores what main could not have sent", () => {
    const view = reduceUpdate(HIDDEN_UPDATE, {
      kind: "available",
      version: "0.5.7",
    });

    for (const junk of [
      null,
      undefined,
      "available",
      42,
      {},
      { kind: "available" },
      { kind: "available", version: 7 },
      { kind: "progress", version: "0.5.7" },
      { kind: "progress", version: "0.5.7", percent: Number.NaN },
      { kind: "restarting", version: "0.5.7" },
    ]) {
      expect(reduceUpdate(view, junk)).toBe(view);
    }
  });

  it("clamps a percent into a whole number from 0 to 100", () => {
    const at = (percent: number) =>
      reduceUpdate(HIDDEN_UPDATE, { kind: "progress", version: "1", percent });

    expect(at(12.9)).toEqual({ phase: "downloading", version: "1", percent: 12 });
    expect(at(-3)).toEqual({ phase: "downloading", version: "1", percent: 0 });
    expect(at(250)).toEqual({ phase: "downloading", version: "1", percent: 100 });
  });

  it("keeps a failure without a message", () => {
    expect(
      reduceUpdate(HIDDEN_UPDATE, { kind: "failed", version: "0.5.7" }),
    ).toEqual({ phase: "failed", version: "0.5.7", message: "" });
  });
});

describe("promptOf", () => {
  it("draws nothing while there is no update", () => {
    expect(promptOf(HIDDEN_UPDATE)).toBeNull();
  });

  it("offers the download, then waits, then offers the restart", () => {
    expect(promptOf({ phase: "available", version: "1" })).toEqual({
      messageKey: "update.available",
      buttonKey: "update.download",
      action: "download",
      progress: null,
    });
    expect(promptOf({ phase: "downloading", version: "1", percent: 30 })).toEqual(
      {
        messageKey: "update.downloading",
        buttonKey: "update.download",
        action: null,
        progress: 30,
      },
    );
    expect(promptOf({ phase: "preparing", version: "1" })).toEqual({
      messageKey: "update.preparing",
      buttonKey: "update.restart",
      action: null,
      progress: "indeterminate",
    });
    expect(promptOf({ phase: "ready", version: "1" })).toEqual({
      messageKey: "update.ready",
      buttonKey: "update.restart",
      action: "install",
      progress: 100,
    });
  });

  it("offers the download again after a failure", () => {
    expect(
      promptOf({ phase: "failed", version: "1", message: "socket hang up" }),
    ).toEqual({
      messageKey: "update.failed",
      buttonKey: "update.retry",
      action: "download",
      progress: null,
    });
  });

  // `LocaleController.t` answers "" for a missing key, so a typo here is a
  // blank button rather than an error anywhere.
  for (const name of ["en", "ko"]) {
    it(`finds every key it uses in ${name}.json`, () => {
      const dict = locale(name);
      const views: UpdateView[] = [
        { phase: "available", version: "1" },
        { phase: "downloading", version: "1", percent: 1 },
        { phase: "preparing", version: "1" },
        { phase: "ready", version: "1" },
        { phase: "failed", version: "1", message: "" },
      ];
      const keys = new Set(["update.unsaved_confirm", "update.close"]);
      for (const view of views) {
        const prompt = promptOf(view);
        keys.add(prompt!.messageKey);
        keys.add(prompt!.buttonKey);
      }
      for (const key of keys) {
        expect(lookup(dict, key), `${name}: ${key}`).toEqual(
          expect.stringMatching(/\S/),
        );
      }
    });
  }
});

describe("shouldInstall", () => {
  it("does not ask when everything is saved", () => {
    let asked = false;
    const confirm = () => {
      asked = true;
      return false;
    };

    expect(shouldInstall(false, confirm)).toBe(true);
    expect(asked).toBe(false);
  });

  it("follows the answer when there is unsaved work", () => {
    expect(shouldInstall(true, () => true)).toBe(true);
    expect(shouldInstall(true, () => false)).toBe(false);
  });
});
