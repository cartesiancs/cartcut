import { describe, expect, it } from "vitest";
import {
  SHORTCUTS,
  shortcut,
  shortcutLabel,
  shortcutLabelWithAlternates,
  shortcutsByGroup,
  type ShortcutId,
} from "./shortcuts";
import { isModifierToken, isNamedKeyToken } from "../../utils/platform";

const MAC = true;
const PC = false;

describe("the registry", () => {
  it("has no duplicate ids", () => {
    const ids = SHORTCUTS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every entry a label, a description and at least one key", () => {
    for (const spec of SHORTCUTS) {
      expect(spec.label.length, spec.id).toBeGreaterThan(0);
      expect(spec.description.length, spec.id).toBeGreaterThan(0);
      expect(spec.keys.length, spec.id).toBeGreaterThan(0);
    }
  });

  it("uses only tokens the formatter knows", () => {
    // A typo like "Cmd" or "Meta" would render as a literal word instead of a
    // glyph, silently, in both the tooltip and the help modal.
    const bindings = SHORTCUTS.flatMap((spec) => [
      spec.keys,
      ...(spec.alternates ?? []),
    ]);

    for (const keys of bindings) {
      for (const token of keys) {
        const known =
          isModifierToken(token) || isNamedKeyToken(token) || token.length === 1;
        expect(known, `unknown shortcut token: ${token}`).toBe(true);
      }
    }
  });

  it("throws on an id that is not in the table", () => {
    expect(() => shortcut("nope" as ShortcutId)).toThrow(/Unknown shortcut id/);
  });
});

describe("shortcutsByGroup", () => {
  it("covers every entry exactly once", () => {
    const grouped = shortcutsByGroup().flatMap((section) => section.items);
    expect(grouped).toHaveLength(SHORTCUTS.length);
    expect(new Set(grouped.map((spec) => spec.id)).size).toBe(SHORTCUTS.length);
  });

  it("puts each entry under its own group and gives the group a title", () => {
    for (const section of shortcutsByGroup()) {
      expect(section.title.length).toBeGreaterThan(0);
      for (const spec of section.items) {
        expect(spec.group).toBe(section.group);
      }
    }
  });

  it("preserves registry order within a group", () => {
    const edit = shortcutsByGroup().find((s) => s.group === "edit");
    expect(edit?.items.map((spec) => spec.id)).toEqual([
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "split",
      "delete",
    ]);
  });
});

describe("labels", () => {
  it("renders the toolbar's six bindings for each platform", () => {
    // Pinned because the toolbar looks these up by id: renaming one should
    // break here rather than silently drop a tooltip's shortcut.
    const expected: Record<string, [string, string]> = {
      undo: ["⌘Z", "Ctrl+Z"],
      redo: ["⇧⌘Z", "Ctrl+Shift+Z"],
      split: ["⌘D", "Ctrl+D"],
      cut: ["⌘X", "Ctrl+X"],
      copy: ["⌘C", "Ctrl+C"],
      paste: ["⌘V", "Ctrl+V"],
    };

    for (const [id, [mac, pc]] of Object.entries(expected)) {
      expect(shortcutLabel(id as ShortcutId, MAC), id).toBe(mac);
      expect(shortcutLabel(id as ShortcutId, PC), id).toBe(pc);
    }
  });

  it("joins alternates with a slash", () => {
    expect(shortcutLabelWithAlternates("delete", MAC)).toBe("⌦ / ⌫");
    expect(shortcutLabelWithAlternates("delete", PC)).toBe("Delete / Backspace");
  });

  it("leaves an entry without alternates alone", () => {
    expect(shortcutLabelWithAlternates("playPause", MAC)).toBe("Space");
  });

  it("agrees with the toolbar's button labels", () => {
    // `timelineToolbar` keeps its own labels for the buttons with no binding,
    // so the overlapping ones are the pair that could drift.
    expect(shortcut("undo").label).toBe("Undo");
    expect(shortcut("redo").label).toBe("Redo");
    expect(shortcut("split").label).toBe("Split at playhead");
    expect(shortcut("cut").label).toBe("Cut");
    expect(shortcut("copy").label).toBe("Copy");
    expect(shortcut("paste").label).toBe("Paste");
    expect(shortcut("delete").label).toBe("Delete");
  });
});
