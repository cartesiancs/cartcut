import { describe, it, expect } from "vitest";
import { captionRowMenu, rowMenuPlacement } from "./rowMenu";

describe("captionRowMenu", () => {
  it("always offers the same two entries in the same order", () => {
    for (const input of [
      { index: 0, removed: false },
      { index: 3, removed: false },
      { index: 3, removed: true },
    ]) {
      const items = captionRowMenu(input);
      expect(items).toHaveLength(2);
      expect(items[0].action).toBe("merge");
    }
  });

  it("refuses to merge the first line, which has nothing above it", () => {
    expect(captionRowMenu({ index: 0, removed: false })[0].disabled).toBe(true);
    expect(captionRowMenu({ index: 1, removed: false })[0].disabled).toBe(false);
  });

  it("refuses to merge a struck-out line into a kept one", () => {
    expect(captionRowMenu({ index: 4, removed: true })[0].disabled).toBe(true);
  });

  it("offers the cut, then the way back", () => {
    expect(captionRowMenu({ index: 1, removed: false })[1]).toMatchObject({
      action: "remove",
      icon: "content_cut",
      disabled: false,
    });
    expect(captionRowMenu({ index: 1, removed: true })[1]).toMatchObject({
      action: "restore",
      icon: "undo",
      disabled: false,
    });
  });

  it("names the keystroke that does the same thing, where there is one", () => {
    // Merge is also Backspace at the start of a line; the cut has no key.
    const items = captionRowMenu({ index: 2, removed: false });
    expect(items[0].hint).toBe("Backspace");
    expect(items[1].hint).toBeUndefined();
  });

  it("labels every entry, since the icons carry no words", () => {
    for (const removed of [false, true]) {
      for (const item of captionRowMenu({ index: 2, removed })) {
        expect(item.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("rowMenuPlacement", () => {
  const anchor = { x: 40, y: 200, width: 28, height: 24 };
  const menu = { width: 260, height: 80 };
  const viewport = { width: 1440, height: 900 };

  it("opens below the button, left edges aligned", () => {
    expect(rowMenuPlacement(anchor, menu, viewport)).toEqual({
      x: 40,
      y: 200 + 24 + 4,
    });
  });

  it("flips above when below would run off the bottom", () => {
    // The last row of a scrolled transcript: 40px of room under the button and
    // a menu twice that tall.
    const low = { ...anchor, y: 830 };
    expect(rowMenuPlacement(low, menu, viewport).y).toBe(830 - 4 - 80);
  });

  it("stays on screen when neither side has room", () => {
    // 40px above the button and 56px below it, for an 80px menu. It overlaps
    // its own button rather than hanging off an edge.
    const short = { width: 1440, height: 120 };
    const middle = { ...anchor, y: 40 };
    const at = rowMenuPlacement(middle, menu, short);
    expect(at.y).toBe(8);
    expect(at.y + menu.height).toBeLessThanOrEqual(120);
  });

  it("never puts the first entry above the top of the screen", () => {
    // A viewport shorter than the menu itself, which is the one case where the
    // clamp and the margin disagree.
    const tiny = { width: 1440, height: 60 };
    expect(rowMenuPlacement(anchor, menu, tiny).y).toBe(8);
  });

  it("pulls the menu in from the right edge", () => {
    const right = { ...anchor, x: 1300 };
    expect(rowMenuPlacement(right, menu, viewport).x).toBe(1440 - 8 - 260);
  });

  it("starts at the left margin when the menu is wider than the viewport", () => {
    const narrow = { width: 200, height: 900 };
    expect(rowMenuPlacement(anchor, menu, narrow).x).toBe(8);
  });

  it("measures something: the flip depends on the menu's own height", () => {
    const low = { ...anchor, y: 830 };
    const tall = rowMenuPlacement(low, { width: 260, height: 400 }, viewport);
    const flat = rowMenuPlacement(low, { width: 260, height: 20 }, viewport);
    expect(flat.y).toBe(830 + 24 + 4);
    expect(tall.y).not.toBe(flat.y);
  });
});
