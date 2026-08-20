import { describe, it, expect } from "vitest";
import { MENU_MARGIN_PX, placeMenu } from "./menuPlacement";

/** A 1280x800 window, roughly what the app runs in. */
const VIEWPORT = { w: 1280, h: 800 };
/** Nine items at ~26px plus the menu's own padding — the worst real case. */
const TALL_MENU = { w: 160, h: 240 };
const SMALL_MENU = { w: 160, h: 60 };

function finiteAll(p: { left: number; top: number; maxHeight: number }) {
  expect(Number.isFinite(p.left)).toBe(true);
  expect(Number.isFinite(p.top)).toBe(true);
  expect(Number.isFinite(p.maxHeight)).toBe(true);
}

describe("opening downward", () => {
  it("puts the menu at the cursor when there is room below", () => {
    // The behaviour that must not change: this is every click in the upper
    // part of the window.
    const p = placeMenu({ x: 400, y: 100 }, TALL_MENU, VIEWPORT);
    expect(p.top).toBe(100);
    expect(p.left).toBe(400);
    expect(p.flipped).toBe(false);
  });

  it("does not flip when the menu fits exactly", () => {
    // Boundary: space below is exactly the menu's height. Flipping here would
    // move a menu that was already fine.
    const y = VIEWPORT.h - MENU_MARGIN_PX - TALL_MENU.h;
    const p = placeMenu({ x: 0, y }, TALL_MENU, VIEWPORT);
    expect(p.flipped).toBe(false);
    expect(p.top).toBe(y);
  });

  it("reports the room below as the max height", () => {
    const p = placeMenu({ x: 0, y: 100 }, SMALL_MENU, VIEWPORT);
    expect(p.maxHeight).toBe(VIEWPORT.h - 100 - MENU_MARGIN_PX);
  });

  it("leaves the bottom margin clear", () => {
    const p = placeMenu({ x: 0, y: 100 }, SMALL_MENU, VIEWPORT);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(VIEWPORT.h - MENU_MARGIN_PX);
  });
});

describe("flipping upward", () => {
  it("hangs the menu's bottom edge on the cursor when below is too tight", () => {
    // The fix: a right-click near the bottom of the timeline used to run off
    // the window with no way to scroll to the rest.
    const y = VIEWPORT.h - 40;
    const p = placeMenu({ x: 400, y }, TALL_MENU, VIEWPORT);
    expect(p.flipped).toBe(true);
    expect(p.top + TALL_MENU.h).toBe(y);
  });

  it("keeps the whole flipped menu on screen", () => {
    const p = placeMenu({ x: 0, y: VIEWPORT.h }, TALL_MENU, VIEWPORT);
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.top + TALL_MENU.h).toBeLessThanOrEqual(VIEWPORT.h);
  });

  it("reports the room above as the max height once flipped", () => {
    const y = VIEWPORT.h - 40;
    const p = placeMenu({ x: 0, y }, TALL_MENU, VIEWPORT);
    expect(p.maxHeight).toBe(y - MENU_MARGIN_PX);
    expect(p.maxHeight).toBeGreaterThanOrEqual(TALL_MENU.h);
  });

  it("flips at the very bottom edge of the window", () => {
    const p = placeMenu({ x: 0, y: VIEWPORT.h }, SMALL_MENU, VIEWPORT);
    expect(p.flipped).toBe(true);
  });
});

describe("when neither side fits", () => {
  const SHORT_VIEWPORT = { w: 1280, h: 200 };

  it("takes the roomier side and clamps to it", () => {
    // Cursor near the bottom of a short window: above is roomier, so the menu
    // goes up and scrolls rather than opening into a 20px sliver.
    const p = placeMenu({ x: 0, y: 180 }, TALL_MENU, SHORT_VIEWPORT);
    expect(p.flipped).toBe(true);
    expect(p.maxHeight).toBe(180 - MENU_MARGIN_PX);
  });

  it("opens downward when below is the roomier side", () => {
    const p = placeMenu({ x: 0, y: 20 }, TALL_MENU, SHORT_VIEWPORT);
    expect(p.flipped).toBe(false);
    expect(p.maxHeight).toBe(SHORT_VIEWPORT.h - 20 - MENU_MARGIN_PX);
  });

  it("starts at the margin when flipped and still too tall", () => {
    // `anchorY - menuH` would be negative here, putting the top of the menu
    // off the screen — the half the user most needs to see.
    const p = placeMenu({ x: 0, y: 180 }, TALL_MENU, SHORT_VIEWPORT);
    expect(p.top).toBe(MENU_MARGIN_PX);
  });

  it("never exceeds the window even for a menu taller than it", () => {
    const p = placeMenu({ x: 0, y: 100 }, { w: 160, h: 5000 }, SHORT_VIEWPORT);
    expect(p.maxHeight).toBeLessThanOrEqual(SHORT_VIEWPORT.h - MENU_MARGIN_PX);
    expect(p.top).toBeGreaterThanOrEqual(0);
  });
});

describe("horizontal clamping", () => {
  it("puts the menu at the cursor when there is room to the right", () => {
    expect(placeMenu({ x: 300, y: 10 }, SMALL_MENU, VIEWPORT).left).toBe(300);
  });

  it("pulls the menu back in at the right edge", () => {
    const p = placeMenu({ x: VIEWPORT.w - 10, y: 10 }, SMALL_MENU, VIEWPORT);
    expect(p.left + SMALL_MENU.w).toBeLessThanOrEqual(
      VIEWPORT.w - MENU_MARGIN_PX,
    );
  });

  it("never puts the left edge past the margin", () => {
    expect(placeMenu({ x: 0, y: 10 }, SMALL_MENU, VIEWPORT).left).toBe(
      MENU_MARGIN_PX,
    );
  });

  it("pins the left edge when the menu is wider than the window", () => {
    // Nothing sensible fits; keeping the left edge visible keeps the labels
    // readable, which is more use than centring the overflow.
    const p = placeMenu({ x: 600, y: 10 }, { w: 4000, h: 60 }, VIEWPORT);
    expect(p.left).toBe(MENU_MARGIN_PX);
  });
});

describe("alignRight", () => {
  it("hangs the menu's right edge on the anchor", () => {
    // What the track header's `⋯` menu does today with translateX(-100%).
    const p = placeMenu({ x: 500, y: 10 }, SMALL_MENU, VIEWPORT, {
      alignRight: true,
    });
    expect(p.left + SMALL_MENU.w).toBe(500);
  });

  it("clamps to the margin rather than running off the left", () => {
    // A right-aligned menu opened from a button near the left edge would
    // otherwise land at a negative x — invisible, with no way to reach it.
    const p = placeMenu({ x: 20, y: 10 }, SMALL_MENU, VIEWPORT, {
      alignRight: true,
    });
    expect(p.left).toBe(MENU_MARGIN_PX);
  });

  it("still flips vertically", () => {
    const p = placeMenu({ x: 500, y: VIEWPORT.h - 20 }, TALL_MENU, VIEWPORT, {
      alignRight: true,
    });
    expect(p.flipped).toBe(true);
  });
});

describe("degenerate input", () => {
  it("clamps an anchor below the window", () => {
    const p = placeMenu({ x: 0, y: 99999 }, SMALL_MENU, VIEWPORT);
    finiteAll(p);
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.top).toBeLessThanOrEqual(VIEWPORT.h);
  });

  it("clamps a negative anchor", () => {
    const p = placeMenu({ x: -500, y: -500 }, SMALL_MENU, VIEWPORT);
    finiteAll(p);
    expect(p.left).toBeGreaterThanOrEqual(MENU_MARGIN_PX);
    expect(p.top).toBeGreaterThanOrEqual(0);
  });

  it("survives a zero-sized viewport", () => {
    // What `offsetWidth`/`innerHeight` report for a window that has not laid
    // out yet. A NaN here would put the menu nowhere at all.
    const p = placeMenu({ x: 0, y: 0 }, SMALL_MENU, { w: 0, h: 0 });
    finiteAll(p);
    expect(p.maxHeight).toBeGreaterThanOrEqual(0);
  });

  it("survives a zero-sized menu", () => {
    const p = placeMenu({ x: 100, y: 100 }, { w: 0, h: 0 }, VIEWPORT);
    finiteAll(p);
    expect(p.flipped).toBe(false);
  });

  it("survives non-finite numbers", () => {
    const p = placeMenu(
      { x: NaN, y: Infinity },
      { w: NaN, h: NaN },
      { w: Infinity, h: NaN },
    );
    finiteAll(p);
  });

  it("never reports a negative max height", () => {
    for (const y of [-100, 0, 400, 800, 5000]) {
      expect(
        placeMenu({ x: 0, y }, TALL_MENU, VIEWPORT).maxHeight,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("honours a custom margin", () => {
    const p = placeMenu({ x: 0, y: 10 }, SMALL_MENU, VIEWPORT, { margin: 40 });
    expect(p.left).toBe(40);
  });

  it("treats a negative margin as zero", () => {
    const p = placeMenu({ x: 0, y: 10 }, SMALL_MENU, VIEWPORT, { margin: -50 });
    expect(p.left).toBe(0);
  });
});
