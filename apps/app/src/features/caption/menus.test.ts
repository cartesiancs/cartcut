import { describe, it, expect } from "vitest";
import {
  captionPlacementButton,
  captionPlacementMenu,
  captionRowMenu,
  menuPlacement,
} from "./menus";

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

describe("menuPlacement", () => {
  const anchor = { x: 40, y: 200, width: 28, height: 24 };
  const menu = { width: 260, height: 80 };
  const viewport = { width: 1440, height: 900 };

  it("opens below the button, left edges aligned", () => {
    expect(menuPlacement(anchor, menu, viewport)).toEqual({
      x: 40,
      y: 200 + 24 + 4,
    });
  });

  it("flips above when below would run off the bottom", () => {
    // The last row of a scrolled transcript: 40px of room under the button and
    // a menu twice that tall.
    const low = { ...anchor, y: 830 };
    expect(menuPlacement(low, menu, viewport).y).toBe(830 - 4 - 80);
  });

  it("stays on screen when neither side has room", () => {
    // 40px above the button and 56px below it, for an 80px menu. It overlaps
    // its own button rather than hanging off an edge.
    const short = { width: 1440, height: 120 };
    const middle = { ...anchor, y: 40 };
    const at = menuPlacement(middle, menu, short);
    expect(at.y).toBe(8);
    expect(at.y + menu.height).toBeLessThanOrEqual(120);
  });

  it("never puts the first entry above the top of the screen", () => {
    // A viewport shorter than the menu itself, which is the one case where the
    // clamp and the margin disagree.
    const tiny = { width: 1440, height: 60 };
    expect(menuPlacement(anchor, menu, tiny).y).toBe(8);
  });

  it("pulls the menu in from the right edge", () => {
    const right = { ...anchor, x: 1300 };
    expect(menuPlacement(right, menu, viewport).x).toBe(1440 - 8 - 260);
  });

  it("starts at the left margin when the menu is wider than the viewport", () => {
    const narrow = { width: 200, height: 900 };
    expect(menuPlacement(anchor, menu, narrow).x).toBe(8);
  });

  it("measures something: the flip depends on the menu's own height", () => {
    const low = { ...anchor, y: 830 };
    const tall = menuPlacement(low, { width: 260, height: 400 }, viewport);
    const flat = menuPlacement(low, { width: 260, height: 20 }, viewport);
    expect(flat.y).toBe(830 + 24 + 4);
    expect(tall.y).not.toBe(flat.y);
  });
});

describe("captionPlacementMenu", () => {
  it("offers both placements, in the same order either way", () => {
    for (const current of ["center", "lowerThird"] as const) {
      expect(captionPlacementMenu(current).map((i) => i.placement)).toEqual([
        "center",
        "lowerThird",
      ]);
    }
  });

  it("marks exactly the current one", () => {
    expect(
      captionPlacementMenu("center").filter((i) => i.selected),
    ).toHaveLength(1);
    expect(captionPlacementMenu("center")[0].selected).toBe(true);
    expect(captionPlacementMenu("lowerThird")[1].selected).toBe(true);
  });

  it("labels every entry, since the icons carry no words", () => {
    for (const item of captionPlacementMenu("center")) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});

describe("captionPlacementButton", () => {
  it("shows the placement the captions are at, not a fixed glyph", () => {
    // The bar this replaced lit the selected button. The trigger is the only
    // thing left that can say where the captions are without being opened.
    expect(captionPlacementButton("center").icon).not.toBe(
      captionPlacementButton("lowerThird").icon,
    );
  });

  it("draws its glyph from the same table as the menu", () => {
    for (const current of ["center", "lowerThird"] as const) {
      const selected = captionPlacementMenu(current).find((i) => i.selected);
      expect(captionPlacementButton(current).icon).toBe(selected?.icon);
    }
  });

  it("names the placement in words, for an icon-only button", () => {
    expect(captionPlacementButton("lowerThird").label).toContain("lower third");
  });
});

describe("captionRowMenu at a clip boundary", () => {
  // The line above belongs to another file. The merge would be refused by
  // `lines.ts`, so the menu says so rather than offering a no-op.
  it("disables Merge on the first line of a clip, wherever it sits", () => {
    const [merge] = captionRowMenu({ index: 4, removed: false, startsClip: true });
    expect(merge.action).toBe("merge");
    expect(merge.disabled).toBe(true);
  });

  it("leaves Merge alone inside a clip", () => {
    const [merge] = captionRowMenu({ index: 4, removed: false, startsClip: false });
    expect(merge.disabled).toBe(false);
  });

  it("keeps the same two entries either way", () => {
    const actions = (startsClip: boolean) =>
      captionRowMenu({ index: 2, removed: false, startsClip }).map((i) => i.action);
    expect(actions(true)).toEqual(actions(false));
  });
});
