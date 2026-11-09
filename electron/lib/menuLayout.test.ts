import { describe, expect, it } from "vitest";
import { MENU_COMMANDS } from "./menuCommands";
import { MENU_LAYOUT, tidySlots } from "./menuLayout";

describe("MENU_LAYOUT", () => {
  it("places every command exactly once, but the two whose rows are built at run time", () => {
    const placed = MENU_LAYOUT.flatMap((menu) =>
      menu.slots.filter((slot): slot is string => typeof slot === "string" && slot !== "-"),
    );
    const dynamic = new Set(["file.autoSaveRecover", "extension.command"]);
    const expected = MENU_COMMANDS.map((command) => command.id).filter((id) => !dynamic.has(id));
    expect([...placed].sort()).toEqual([...expected].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it("keeps the menus in the order the desktop app has always shown them", () => {
    expect(MENU_LAYOUT.map((menu) => menu.label)).toEqual([
      "File",
      "Edit",
      "Clip",
      "Playback",
      "Utilities",
      "View",
      "Extensions",
      "Window",
      "About",
      "Help",
    ]);
  });
});

describe("tidySlots", () => {
  it("drops separators at the ends and in runs", () => {
    expect(tidySlots(["-", "a", "-", "-", "b", "-"])).toEqual(["a", "-", "b"]);
    expect(tidySlots(["-", "-"])).toEqual([]);
    expect(tidySlots(["a", "b"])).toEqual(["a", "b"]);
  });
});
