import { describe, expect, it } from "vitest";
import { MENU_MARGIN_PX } from "../menu/menuPlacement";
import { msToPxSigned } from "../timeline/geometry";
import {
  ARROW_PX,
  CARD_RADIUS_PX,
  COACHMARK_GAP_PX,
  RING_PAD_PX,
  floatingPlacement,
  intersectRects,
  placeCoachmark,
  playheadClientX,
  revealDelta,
  ringRect,
  sideOrder,
  type Rect,
} from "./placement";

const VIEWPORT = { w: 1440, h: 900 };
const CARD = { w: 280, h: 160 };
const KEEP = CARD_RADIUS_PX + ARROW_PX;

const rect = (left: number, top: number, width: number, height: number): Rect => ({
  left,
  top,
  width,
  height,
});

describe("coachmark placement", () => {
  it("leaves the arrow's tip short of the ring", () => {
    expect(COACHMARK_GAP_PX).toBeGreaterThan(RING_PAD_PX + ARROW_PX);
  });

  it("tries the preferred side, its opposite, then the other two", () => {
    expect(sideOrder("right")).toEqual(["right", "left", "bottom", "top"]);
    expect(sideOrder("top")).toEqual(["top", "bottom", "right", "left"]);
  });

  it("sits on the preferred side, centred on the target", () => {
    const target = rect(40, 300, 40, 40);
    const p = placeCoachmark(target, CARD, VIEWPORT, { side: "right" });

    expect(p.side).toBe("right");
    expect(p.left).toBe(80 + COACHMARK_GAP_PX);
    expect(p.top).toBe(320 - CARD.h / 2);
    expect(p.arrow).toBe(CARD.h / 2);
    expect(p.overlaps).toBe(false);
  });

  it("flips to the opposite side when the preferred one has no room", () => {
    const target = rect(1300, 300, 60, 40);
    const p = placeCoachmark(target, CARD, VIEWPORT, { side: "right" });

    expect(p.side).toBe("left");
    expect(p.left + CARD.w).toBe(1300 - COACHMARK_GAP_PX);
  });

  // The ruler: the width of the window, so neither side can hold the card and
  // it has to go above.
  it("goes above a target as wide as the window", () => {
    const ruler = rect(0, 560, 1440, 24);
    const p = placeCoachmark(ruler, CARD, VIEWPORT, { side: "right" });

    expect(p.side).toBe("bottom");
    const above = placeCoachmark(ruler, CARD, VIEWPORT, { side: "top" });
    expect(above.side).toBe("top");
    expect(above.top + CARD.h).toBe(560 - COACHMARK_GAP_PX);
  });

  it("aims the arrow at an anchor inside the target", () => {
    const ruler = rect(200, 560, 1200, 24);
    const p = placeCoachmark(ruler, CARD, VIEWPORT, {
      side: "top",
      anchor: { x: 700 },
    });

    expect(p.left + p.arrow).toBe(700);
  });

  it("keeps the anchor on the target when it is scrolled off it", () => {
    const ruler = rect(200, 560, 1200, 24);
    const p = placeCoachmark(ruler, CARD, VIEWPORT, {
      side: "top",
      anchor: { x: -5000 },
    });

    expect(p.left + p.arrow).toBeGreaterThanOrEqual(200);
  });

  it("slides along the edge to stay on screen, and keeps the arrow off the corners", () => {
    // A sidebar button at the very top of the window.
    const target = rect(0, 40, 40, 40);
    const p = placeCoachmark(target, CARD, VIEWPORT, {
      side: "right",
      insetTop: 34,
    });

    expect(p.top).toBe(34 + MENU_MARGIN_PX);
    expect(p.arrow).toBeGreaterThanOrEqual(KEEP);
    expect(p.arrow).toBeLessThanOrEqual(CARD.h - KEEP);
    // Kept off the rounded corner, which moves it a pixel from the target's
    // middle, and still on the target.
    expect(p.top + p.arrow).toBeGreaterThanOrEqual(40);
    expect(p.top + p.arrow).toBeLessThanOrEqual(80);
  });

  it("never goes over the title bar", () => {
    const target = rect(600, 60, 100, 30);
    const p = placeCoachmark(target, CARD, VIEWPORT, {
      side: "top",
      insetTop: 34,
    });

    expect(p.side).not.toBe("top");
    expect(p.top).toBeGreaterThanOrEqual(34 + MENU_MARGIN_PX);
  });

  it("sits over the target, on screen, when no side has room", () => {
    const small = { w: 300, h: 200 };
    const target = rect(0, 0, 300, 200);
    const p = placeCoachmark(target, { w: 290, h: 190 }, small, { side: "right" });

    expect(p.overlaps).toBe(true);
    expect(p.left).toBeGreaterThanOrEqual(MENU_MARGIN_PX);
    expect(p.top).toBeGreaterThanOrEqual(MENU_MARGIN_PX);
  });

  it("is finite for any input", () => {
    const bad = [NaN, Infinity, -Infinity];
    for (const value of bad) {
      const p = placeCoachmark(
        rect(value, value, value, value),
        { w: value, h: value },
        { w: value, h: value },
        { side: "right", anchor: { x: value, y: value }, insetTop: value },
      );
      for (const field of [p.left, p.top, p.arrow]) {
        expect(Number.isFinite(field)).toBe(true);
      }
    }

    const zero = placeCoachmark(rect(10, 10, 10, 10), CARD, { w: 0, h: 0 }, {
      side: "top",
    });
    expect(Number.isFinite(zero.left) && Number.isFinite(zero.top)).toBe(true);
  });

  // The property that matters, over a grid of targets across the window:
  // whenever a side was found, the card is on screen and clear of the target.
  it("never covers the target or leaves the window when a side fits", () => {
    const sides = ["right", "left", "top", "bottom"] as const;
    for (let x = 0; x < VIEWPORT.w; x += 97) {
      for (let y = 34; y < VIEWPORT.h; y += 61) {
        for (const side of sides) {
          const target = rect(x, y, 48, 32);
          const p = placeCoachmark(target, CARD, VIEWPORT, { side, insetTop: 34 });
          if (p.overlaps) continue;

          const card = rect(p.left, p.top, CARD.w, CARD.h);
          expect(intersectRects(card, target)).toBeNull();
          expect(p.left).toBeGreaterThanOrEqual(MENU_MARGIN_PX);
          expect(p.top).toBeGreaterThanOrEqual(34 + MENU_MARGIN_PX);
          expect(p.left + CARD.w).toBeLessThanOrEqual(VIEWPORT.w - MENU_MARGIN_PX);
          expect(p.top + CARD.h).toBeLessThanOrEqual(VIEWPORT.h - MENU_MARGIN_PX);
        }
      }
    }
  });
});

describe("floating placement", () => {
  it("centres the card above the bottom edge, pointing at nothing", () => {
    const p = floatingPlacement(CARD, VIEWPORT);
    expect(p.side).toBe("none");
    expect(p.left).toBe((VIEWPORT.w - CARD.w) / 2);
    expect(p.top + CARD.h).toBeLessThan(VIEWPORT.h);
  });
});

describe("ring", () => {
  it("stands off the target by its pad", () => {
    expect(ringRect(rect(100, 100, 50, 20), VIEWPORT)).toEqual(
      rect(100 - RING_PAD_PX, 100 - RING_PAD_PX, 50 + 2 * RING_PAD_PX, 20 + 2 * RING_PAD_PX),
    );
  });

  // The sidebar's buttons are flush with the window's left edge.
  it("is cut to the window, so a control at its edge keeps all four sides", () => {
    const ring = ringRect(rect(0, 40, 40, 40), VIEWPORT);
    expect(ring.left).toBe(0);
    expect(ring.width).toBe(40 + RING_PAD_PX);
  });
});

describe("revealing a target in its panel", () => {
  const panel = rect(0, 100, 300, 400);

  it("does nothing for a target already inside", () => {
    expect(revealDelta(rect(0, 200, 100, 40), panel)).toBe(0);
  });

  it("scrolls up to a target above", () => {
    expect(revealDelta(rect(0, 60, 100, 40), panel)).toBe(60 - 100 - MENU_MARGIN_PX);
  });

  it("scrolls down to a target below", () => {
    expect(revealDelta(rect(0, 480, 100, 40), panel)).toBe(
      520 - 500 + MENU_MARGIN_PX,
    );
  });

  it("aligns a target taller than the panel by its top", () => {
    expect(revealDelta(rect(0, 300, 100, 1000), panel)).toBe(
      300 - 100 - MENU_MARGIN_PX,
    );
  });

  it("is zero for a measurement that is not a number", () => {
    expect(revealDelta(rect(0, NaN, 100, 40), panel)).toBe(0);
  });
});

describe("playhead x", () => {
  it("is where the ruler draws it", () => {
    const range = 0.9;
    expect(playheadClientX(40, 2000, range, 120)).toBe(
      40 + msToPxSigned(2000, range) - 120 + 1,
    );
  });

  it("is null rather than NaN", () => {
    expect(playheadClientX(40, NaN, 0.9, 0)).toBeNull();
  });
});
