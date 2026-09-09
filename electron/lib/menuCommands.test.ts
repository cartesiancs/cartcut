import { describe, expect, it } from "vitest";
import {
  MENU_COMMANDS,
  menuCommand,
  type MenuCommandId,
} from "./menuCommands";

describe("the menu command table", () => {
  it("has no duplicate ids", () => {
    const ids = MENU_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every command a label", () => {
    for (const command of MENU_COMMANDS) {
      expect(command.label.length, command.id).toBeGreaterThan(0);
    }
  });

  it("never registers one accelerator twice", () => {
    // Two items on ⌘S is not a menu that shows two shortcuts — it is one
    // command that never fires, chosen by whichever item Electron reaches
    // first, and nothing about the menu says which.
    const accelerators = MENU_COMMANDS.map(
      (command) => command.accelerator,
    ).filter((accelerator): accelerator is string => accelerator != null);

    expect(new Set(accelerators).size).toBe(accelerators.length);
  });

  it("does not register a bare key as an accelerator", () => {
    // A menu accelerator is global to the window with no per-focus escape, so
    // Space would toggle playback every time a caption was typed into and
    // Backspace would delete the selected clip instead of a character. Those
    // bindings belong to the renderer's keydown handlers, which can see the
    // focus. Anything registered here has to carry a modifier.
    for (const command of MENU_COMMANDS) {
      if (command.accelerator == null) {
        continue;
      }
      expect(
        /^(CmdOrCtrl|Command|Control|Ctrl|Alt|Option|Shift|Super)\+/.test(
          command.accelerator,
        ),
        `${command.id}: ${command.accelerator}`,
      ).toBe(true);
    }
  });

  it("only claims the renderer owns a key when there is a key to own", () => {
    for (const command of MENU_COMMANDS) {
      if (command.rendererOwnsKey) {
        expect(command.accelerator, command.id).toBeDefined();
      }
    }
  });

  it("throws on an id that is not in the table", () => {
    expect(() => menuCommand("nope" as MenuCommandId)).toThrow(
      /Unknown menu command/,
    );
  });
});
