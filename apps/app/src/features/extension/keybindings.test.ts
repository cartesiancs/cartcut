import { describe, expect, it } from "vitest";

import {
  chordKey,
  matchesChord,
  matchesWhen,
  parseChord,
  reservedChords,
  resolveBindings,
  resolveKeybinding,
} from "./keybindings";
import type { ContributedKeybinding } from "./contributions";

const binding = (
  extId: string,
  key: string,
  overrides: Partial<ContributedKeybinding> = {},
): ContributedKeybinding => ({ extId, commandId: "do.thing", key, when: null, ...overrides });

describe("parseChord", () => {
  it("reads modifiers and a letter", () => {
    expect(parseChord("mod+alt+z")).toEqual({
      mod: true,
      alt: true,
      shift: false,
      ctrl: false,
      code: "KeyZ",
    });
  });

  it("accepts the words an author is likely to write", () => {
    expect(parseChord("cmd+k")?.mod).toBe(true);
    expect(parseChord("Command+K")?.mod).toBe(true);
    expect(parseChord("ctrl+k")?.ctrl).toBe(true);
    expect(parseChord("option+k")?.alt).toBe(true);
    expect(parseChord("Shift+K")?.shift).toBe(true);
  });

  it("uses the physical key, not the character", () => {
    // `code` rather than `key`: a binding on `z` has to be the same physical
    // key on an AZERTY keyboard as on a QWERTY one.
    expect(parseChord("z")?.code).toBe("KeyZ");
    expect(parseChord("1")?.code).toBe("Digit1");
    expect(parseChord("slash")?.code).toBe("Slash");
    expect(parseChord("KeyQ")?.code).toBe("KeyQ");
  });

  it("refuses a modifier it does not know", () => {
    expect(parseChord("hyper+k")).toBeNull();
  });

  it("refuses nonsense", () => {
    for (const value of ["", "   ", "+", "mod+"]) {
      expect([value, parseChord(value)]).toEqual([value, null]);
    }
  });
});

describe("matchesChord", () => {
  const chord = parseChord("mod+shift+k")!;

  it("takes Command on macOS and Control elsewhere", () => {
    const mac = { code: "KeyK", metaKey: true, shiftKey: true };
    const win = { code: "KeyK", ctrlKey: true, shiftKey: true };
    expect(matchesChord(chord, mac, true)).toBe(true);
    expect(matchesChord(chord, win, false)).toBe(true);
    // The wrong modifier for the platform is not a match, which is what stops
    // Ctrl+D on a Mac from firing something bound to Cmd+D.
    expect(matchesChord(chord, win, true)).toBe(false);
  });

  it("refuses a press with an extra modifier held", () => {
    expect(matchesChord(chord, { code: "KeyK", metaKey: true, shiftKey: true, altKey: true }, true)).toBe(
      false,
    );
  });
});

describe("reservedChords", () => {
  const reserved = reservedChords();

  it("covers the app's own shortcuts", () => {
    // Derived from `SHORTCUTS`, so a shortcut added to the app is reserved
    // from that moment without anybody remembering this file.
    expect(reserved.has(chordKey(parseChord("mod+z")!))).toBe(true);
    expect(reserved.has(chordKey(parseChord("mod+c")!))).toBe(true);
  });

  it("covers the bare keys the timeline binds", () => {
    for (const code of ["Space", "ArrowLeft", "Delete", "Backspace", "Escape"]) {
      expect([code, reserved.has(code)]).toEqual([code, true]);
    }
  });
});

describe("resolveBindings", () => {
  it("accepts a chord nothing else uses", () => {
    const { bindings, problems } = resolveBindings([binding("acme.hello", "mod+alt+h")]);
    expect(bindings).toHaveLength(1);
    expect(problems).toHaveLength(0);
  });

  it("refuses a chord the app already uses, at registration", () => {
    // Refused here rather than at dispatch: refusing late would mean the key
    // is listed in an extension's documentation and silently does nothing.
    const { bindings, problems } = resolveBindings([binding("acme.hello", "mod+z")]);
    expect(bindings).toHaveLength(0);
    expect(problems[0].reason).toContain("already uses");
  });

  it("gives a contested chord to the first registrant and reports the loser", () => {
    const { bindings, problems } = resolveBindings([
      binding("a.one", "mod+alt+j"),
      binding("b.two", "mod+alt+j"),
    ]);
    expect(bindings.map((entry) => entry.extId)).toEqual(["a.one"]);
    expect(problems[0]).toMatchObject({ extId: "b.two" });
  });

  it("reports a chord it cannot parse rather than dropping it silently", () => {
    const { problems } = resolveBindings([binding("acme.hello", "hyper+k")]);
    expect(problems[0].reason).toContain("parse");
  });
});

describe("matchesWhen", () => {
  const context = { selectionCount: 2, selectionTypes: ["video", "text"] };

  it("is true with no clause", () => {
    expect(matchesWhen(null, context)).toBe(true);
    expect(matchesWhen("  ", context)).toBe(true);
  });

  it("reads the three forms", () => {
    expect(matchesWhen("selection", context)).toBe(true);
    expect(matchesWhen("selection", { selectionCount: 0, selectionTypes: [] })).toBe(false);
    expect(matchesWhen("selection.type == video", context)).toBe(true);
    expect(matchesWhen("selection.type == audio", context)).toBe(false);
    expect(matchesWhen("selection.count >= 2", context)).toBe(true);
    expect(matchesWhen("selection.count > 2", context)).toBe(false);
  });

  it("matches a clause it does not understand", () => {
    // A binding that does nothing is harder to diagnose than one that fires
    // when it should not, so an unknown clause degrades to "always".
    expect(matchesWhen("someFutureThing && whatever", context)).toBe(true);
  });
});

describe("resolveKeybinding", () => {
  it("finds the binding for a press", () => {
    const { bindings } = resolveBindings([binding("acme.hello", "mod+alt+h")]);
    const found = resolveKeybinding(
      bindings,
      { code: "KeyH", metaKey: true, altKey: true },
      { selectionCount: 0, selectionTypes: [] },
      true,
    );
    expect(found?.extId).toBe("acme.hello");
  });

  it("skips a binding whose when clause does not hold", () => {
    const { bindings } = resolveBindings([
      binding("acme.hello", "mod+alt+h", { when: "selection" }),
    ]);
    const found = resolveKeybinding(
      bindings,
      { code: "KeyH", metaKey: true, altKey: true },
      { selectionCount: 0, selectionTypes: [] },
      true,
    );
    expect(found).toBeNull();
  });
});
