import { describe, expect, it } from "vitest";
import {
  detectIsMac,
  formatShortcut,
  hasEditorModifier,
  shortcutParts,
} from "./platform";

// Every call passes `isMac` explicitly. Node exposes a real
// `navigator.platform`, so a test leaning on the module default would pass on a
// Mac and fail the moment CI runs Linux.
const MAC = true;
const PC = false;

describe("detectIsMac", () => {
  it("prefers the UA-CH platform hint", () => {
    expect(detectIsMac({ userAgentData: { platform: "macOS" } })).toBe(true);
    expect(detectIsMac({ userAgentData: { platform: "Windows" } })).toBe(false);
    expect(detectIsMac({ userAgentData: { platform: "Linux" } })).toBe(false);
  });

  it("lets the hint override a contradicting platform and user agent", () => {
    expect(
      detectIsMac({
        userAgentData: { platform: "Windows" },
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      }),
    ).toBe(false);
  });

  it("falls back to navigator.platform", () => {
    expect(detectIsMac({ platform: "MacIntel" })).toBe(true);
    expect(detectIsMac({ platform: "Win32" })).toBe(false);
    expect(detectIsMac({ platform: "Linux x86_64" })).toBe(false);
  });

  it("falls back to the user agent string last", () => {
    expect(
      detectIsMac({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      }),
    ).toBe(true);
    expect(
      detectIsMac({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }),
    ).toBe(false);
  });

  it("answers false for anything it cannot read", () => {
    expect(detectIsMac(null)).toBe(false);
    expect(detectIsMac(undefined)).toBe(false);
    expect(detectIsMac({})).toBe(false);
    expect(detectIsMac({ userAgentData: {} })).toBe(false);
    expect(detectIsMac({ platform: "" })).toBe(false);
  });
});

describe("hasEditorModifier", () => {
  it("takes Cmd and refuses Ctrl on macOS", () => {
    expect(hasEditorModifier({ metaKey: true }, MAC)).toBe(true);
    expect(hasEditorModifier({ ctrlKey: true }, MAC)).toBe(false);
    expect(hasEditorModifier({ metaKey: true, ctrlKey: true }, MAC)).toBe(false);
    expect(hasEditorModifier({}, MAC)).toBe(false);
  });

  it("takes Ctrl and refuses Meta elsewhere", () => {
    expect(hasEditorModifier({ ctrlKey: true }, PC)).toBe(true);
    expect(hasEditorModifier({ metaKey: true }, PC)).toBe(false);
    expect(hasEditorModifier({ ctrlKey: true, metaKey: true }, PC)).toBe(false);
    expect(hasEditorModifier({}, PC)).toBe(false);
  });

  it("refuses AltGr, which reports as Ctrl+Alt", () => {
    expect(hasEditorModifier({ ctrlKey: true, altKey: true }, PC)).toBe(false);
    expect(hasEditorModifier({ metaKey: true, altKey: true }, MAC)).toBe(false);
  });

  it("answers false for a missing event", () => {
    expect(hasEditorModifier(null, MAC)).toBe(false);
    expect(hasEditorModifier(undefined, PC)).toBe(false);
  });
});

describe("formatShortcut", () => {
  it("spells the platform modifier", () => {
    expect(formatShortcut(["Mod", "Z"], MAC)).toBe("⌘Z");
    expect(formatShortcut(["Mod", "Z"], PC)).toBe("Ctrl+Z");
  });

  it("orders modifiers the way each platform prints them", () => {
    // Apple writes ⇧⌘Z, not ⌘⇧Z — the toolbar used to get this backwards, and
    // to emit the mixed "Ctrl+⇧Z" on Windows.
    expect(formatShortcut(["Mod", "Shift", "Z"], MAC)).toBe("⇧⌘Z");
    expect(formatShortcut(["Mod", "Shift", "Z"], PC)).toBe("Ctrl+Shift+Z");
  });

  it("sorts by rank rather than author order", () => {
    expect(formatShortcut(["Shift", "Mod", "Z"], MAC)).toBe("⇧⌘Z");
    expect(formatShortcut(["Mod", "Alt", "Shift", "K"], MAC)).toBe("⌥⇧⌘K");
  });

  it("uses key legends on macOS and words elsewhere", () => {
    expect(formatShortcut(["Delete"], MAC)).toBe("⌦");
    expect(formatShortcut(["Delete"], PC)).toBe("Delete");
    expect(formatShortcut(["Backspace"], MAC)).toBe("⌫");
    expect(formatShortcut(["Backspace"], PC)).toBe("Backspace");
    expect(formatShortcut(["Escape"], MAC)).toBe("⎋");
    expect(formatShortcut(["Escape"], PC)).toBe("Esc");
  });

  it("spells Space and the arrows the same on both", () => {
    expect(formatShortcut(["Space"], MAC)).toBe("Space");
    expect(formatShortcut(["Space"], PC)).toBe("Space");
    expect(formatShortcut(["ArrowLeft"], MAC)).toBe("←");
    expect(formatShortcut(["ArrowLeft"], PC)).toBe("←");
    expect(formatShortcut(["ArrowUp"], PC)).toBe("↑");
  });

  it("passes an unknown token through uppercased rather than throwing", () => {
    expect(formatShortcut(["Q"], MAC)).toBe("Q");
    expect(formatShortcut(["Mod", "q"], PC)).toBe("Ctrl+Q");
    expect(formatShortcut(["Mod", "0"], MAC)).toBe("⌘0");
  });
});

describe("shortcutParts", () => {
  it("keeps one string per key so a caller can render chips", () => {
    expect(shortcutParts(["Mod", "Shift", "Z"], MAC)).toEqual(["⇧", "⌘", "Z"]);
    expect(shortcutParts(["Mod", "Shift", "Z"], PC)).toEqual([
      "Ctrl",
      "Shift",
      "Z",
    ]);
  });
});
