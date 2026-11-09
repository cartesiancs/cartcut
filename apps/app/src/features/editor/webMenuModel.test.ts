import { describe, expect, it } from "vitest";
import {
  acceleratorTokens,
  matchesAccelerator,
  nextItem,
  shortcutLabel,
  WEB_HIDDEN_COMMANDS,
  webMenus,
  webShortcutCommands,
  type KeyLike,
} from "./webMenuModel";

const key = (code: string, over: Partial<KeyLike> = {}): KeyLike => ({
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe("webMenus", () => {
  const menus = webMenus(true);
  const labels = (menu: string) =>
    menus
      .find((m) => m.label === menu)!
      .items.map((item) => (item.kind === "separator" ? "-" : item.label));

  it("draws the desktop's menus a browser can use, in the desktop's order", () => {
    expect(menus.map((menu) => menu.label)).toEqual([
      "File",
      "Edit",
      "Clip",
      "Playback",
      "Utilities",
      "View",
      "About",
      "Help",
    ]);
  });

  it("keeps every File item a page can act on, and drops Close", () => {
    expect(labels("File")).toEqual([
      "Open Project…",
      "Save Project",
      "Save Project As…",
      "-",
      "Auto Save",
      "-",
      "Import Media…",
      "Import Subtitles…",
      "Export Video…",
      "Export Subtitles…",
    ]);
  });

  it("leaves out the desktop-only tools without leaving a stray separator", () => {
    expect(labels("Utilities")).toEqual([
      "Audio Record",
      "-",
      "Text to Speech",
      "Prompter",
      "-",
      "Auto Track",
      "-",
      "Export Template…",
    ]);
    const ids = menus.flatMap((menu) => menu.items.flatMap((item) => (item.kind === "command" ? [item.id] : [])));
    for (const hidden of WEB_HIDDEN_COMMANDS) {
      expect(ids).not.toContain(hidden);
    }
  });

  it("writes shortcuts the platform's way", () => {
    const save = webMenus(true)[0].items.find((item) => item.kind === "command" && item.id === "file.saveAs");
    expect(save).toMatchObject({ shortcut: "⇧⌘S" });
    const pc = webMenus(false)[0].items.find((item) => item.kind === "command" && item.id === "file.saveAs");
    expect(pc).toMatchObject({ shortcut: "Ctrl+Shift+S" });
  });
});

describe("accelerators", () => {
  it("reads Electron's spelling", () => {
    expect(acceleratorTokens("CmdOrCtrl+Shift+S")).toEqual(["Mod", "Shift", "S"]);
    expect(acceleratorTokens("CmdOrCtrl+Plus")).toEqual(["Mod", "+"]);
    expect(shortcutLabel("CmdOrCtrl+/", true)).toBe("⌘/");
    expect(shortcutLabel(undefined, true)).toBeNull();
  });

  it("matches the platform modifier strictly, as the editor's own shortcuts do", () => {
    expect(matchesAccelerator("CmdOrCtrl+S", key("KeyS", { metaKey: true }), true)).toBe(true);
    expect(matchesAccelerator("CmdOrCtrl+S", key("KeyS", { ctrlKey: true }), true)).toBe(false);
    expect(matchesAccelerator("CmdOrCtrl+S", key("KeyS", { ctrlKey: true }), false)).toBe(true);
    expect(matchesAccelerator("CmdOrCtrl+S", key("KeyS", { metaKey: true }), false)).toBe(false);
    expect(matchesAccelerator("CmdOrCtrl+S", key("KeyS", { metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(matchesAccelerator("CmdOrCtrl+Shift+S", key("KeyS", { metaKey: true, shiftKey: true }), true)).toBe(true);
    // AltGr arrives as Ctrl+Alt on a European layout and must not save.
    expect(matchesAccelerator("CmdOrCtrl+S", key("KeyS", { ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(matchesAccelerator("CmdOrCtrl+/", key("Slash", { metaKey: true }), true)).toBe(true);
  });

  it("binds only what the page does not already bind", () => {
    const ids = webShortcutCommands().map((command) => command.id);
    expect(ids).toContain("file.save");
    expect(ids).toContain("help.shortcuts");
    expect(ids).not.toContain("edit.undo");
    expect(ids).not.toContain("clip.split");
    expect(ids).not.toContain("view.previewZoomIn");
  });
});

describe("nextItem", () => {
  const items = webMenus(true)[0].items;

  it("skips separators and wraps", () => {
    expect(nextItem(items, -1, 1)).toBe(0);
    expect(nextItem(items, 2, 1)).toBe(4);
    expect(nextItem(items, 4, -1)).toBe(2);
    expect(nextItem(items, items.length - 1, 1)).toBe(0);
    expect(nextItem(items, -1, -1)).toBe(items.length - 1);
  });
});
