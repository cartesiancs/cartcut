/**
 * Where the preview lands, and how big it is. Both are invisible in code review
 * and obvious the moment a preview opens half off the screen or under the
 * pointer that asked for it.
 */

import { describe, it, expect } from "vitest";
import {
  PREVIEW_GAP_PX,
  PREVIEW_MARGIN_PX,
  PREVIEW_MAX_H_FRACTION,
  PREVIEW_MAX_W_FRACTION,
  placePreview,
  previewBoxSize,
} from "./hoverPreviewPlacement";

const VIEWPORT = { w: 1440, h: 900 };
/** A box that comfortably fits on either side of a centred cursor. */
const BOX = { w: 480, h: 270 };

describe("previewBoxSize", () => {
  it("shrinks a large source to fit the window", () => {
    // The user's own footage: a 3600x2338 screen recording.
    const size = previewBoxSize({ w: 3600, h: 2338 }, VIEWPORT);

    expect(size.w).toBeLessThanOrEqual(VIEWPORT.w * PREVIEW_MAX_W_FRACTION);
    expect(size.h).toBeLessThanOrEqual(VIEWPORT.h * PREVIEW_MAX_H_FRACTION);
  });

  it("preserves the aspect ratio", () => {
    const size = previewBoxSize({ w: 3600, h: 2338 }, VIEWPORT);

    expect(size.w / size.h).toBeCloseTo(3600 / 2338, 6);
  });

  it("is limited by whichever axis runs out first", () => {
    // A tall source is capped by height, and must not be as wide as a wide one.
    const tall = previewBoxSize({ w: 1080, h: 1920 }, VIEWPORT);
    const wide = previewBoxSize({ w: 1920, h: 1080 }, VIEWPORT);

    expect(tall.h).toBeCloseTo(VIEWPORT.h * PREVIEW_MAX_H_FRACTION, 6);
    expect(wide.w).toBeCloseTo(VIEWPORT.w * PREVIEW_MAX_W_FRACTION, 6);
    expect(tall.w).toBeLessThan(wide.w);
  });

  it("never scales a small source up", () => {
    // A 64px icon blown up to 600px is a blurry 64px icon.
    const size = previewBoxSize({ w: 64, h: 64 }, VIEWPORT);

    expect(size).toEqual({ w: 64, h: 64 });
  });

  it("falls back to a 16:9 box while the size is still unknown", () => {
    // `loadedmetadata` has not fired yet. A collapsed box reads as a broken
    // feature; a normally shaped one reads as a loading one.
    const size = previewBoxSize({ w: 0, h: 0 }, VIEWPORT);

    expect(size.w).toBeGreaterThan(0);
    expect(size.h).toBeGreaterThan(0);
    expect(size.w / size.h).toBeCloseTo(16 / 9, 6);
  });

  describe("degenerate input", () => {
    it("stays finite for a zero-sized viewport", () => {
      const size = previewBoxSize({ w: 1920, h: 1080 }, { w: 0, h: 0 });

      expect(Number.isFinite(size.w)).toBe(true);
      expect(Number.isFinite(size.h)).toBe(true);
      expect(size.w).toBeGreaterThanOrEqual(0);
      expect(size.h).toBeGreaterThanOrEqual(0);
    });

    it("stays finite for NaN and Infinity", () => {
      for (const natural of [
        { w: NaN, h: 1080 },
        { w: 1920, h: Infinity },
        { w: -100, h: -100 },
      ]) {
        const size = previewBoxSize(natural, VIEWPORT);
        expect(Number.isFinite(size.w)).toBe(true);
        expect(Number.isFinite(size.h)).toBe(true);
      }

      const bad = previewBoxSize({ w: 1920, h: 1080 }, { w: NaN, h: NaN });
      expect(Number.isFinite(bad.w)).toBe(true);
      expect(Number.isFinite(bad.h)).toBe(true);
    });
  });
});

describe("placePreview", () => {
  it("sits below and to the right of the cursor when there is room", () => {
    const at = placePreview({ x: 200, y: 200 }, BOX, VIEWPORT);

    expect(at.left).toBe(200 + PREVIEW_GAP_PX);
    expect(at.top).toBe(200 + PREVIEW_GAP_PX);
    expect(at.flippedX).toBe(false);
    expect(at.flippedY).toBe(false);
  });

  it("flips to the left of the cursor near the right edge", () => {
    const at = placePreview({ x: 1400, y: 200 }, BOX, VIEWPORT);

    expect(at.flippedX).toBe(true);
    expect(at.flippedY).toBe(false);
    expect(at.left + BOX.w).toBe(1400 - PREVIEW_GAP_PX);
  });

  it("flips above the cursor near the bottom edge", () => {
    const at = placePreview({ x: 200, y: 860 }, BOX, VIEWPORT);

    expect(at.flippedX).toBe(false);
    expect(at.flippedY).toBe(true);
    expect(at.top + BOX.h).toBe(860 - PREVIEW_GAP_PX);
  });

  it("flips on both axes in the bottom-right corner", () => {
    const at = placePreview({ x: 1400, y: 860 }, BOX, VIEWPORT);

    expect(at.flippedX).toBe(true);
    expect(at.flippedY).toBe(true);
  });

  it("never covers the cursor", () => {
    // The reason this module is not `placeMenu`. Swept across the whole window,
    // because the failure only shows up near an edge.
    for (let x = 0; x <= VIEWPORT.w; x += 40) {
      for (let y = 0; y <= VIEWPORT.h; y += 40) {
        const at = placePreview({ x, y }, BOX, VIEWPORT);
        const covers =
          x >= at.left &&
          x <= at.left + BOX.w &&
          y >= at.top &&
          y <= at.top + BOX.h;

        expect(covers, `covered the cursor at ${x},${y}`).toBe(false);
      }
    }
  });

  it("keeps the preview inside the window margin", () => {
    for (let x = -200; x <= VIEWPORT.w + 200; x += 37) {
      for (let y = -200; y <= VIEWPORT.h + 200; y += 37) {
        const at = placePreview({ x, y }, BOX, VIEWPORT);

        expect(at.left).toBeGreaterThanOrEqual(PREVIEW_MARGIN_PX);
        expect(at.top).toBeGreaterThanOrEqual(PREVIEW_MARGIN_PX);
        expect(at.left + BOX.w).toBeLessThanOrEqual(
          VIEWPORT.w - PREVIEW_MARGIN_PX,
        );
        expect(at.top + BOX.h).toBeLessThanOrEqual(
          VIEWPORT.h - PREVIEW_MARGIN_PX,
        );
      }
    }
  });

  describe("the side it opened on", () => {
    it("keeps it while the cursor moves and it still fits", () => {
      // Right at the boundary where the box stops fitting below. Without the
      // preference, a 1px tremor here flips the preview above and back at
      // pointer rate — and a tile is only ~70px tall, so a cursor resting on
      // that boundary stays on it.
      const boundary = VIEWPORT.h - PREVIEW_MARGIN_PX - BOX.h - PREVIEW_GAP_PX;
      const below = placePreview({ x: 200, y: boundary }, BOX, VIEWPORT);
      expect(below.flippedY).toBe(false);

      const nudged = placePreview({ x: 200, y: boundary + 1 }, BOX, VIEWPORT, {
        prefer: below,
      });

      expect(nudged.flippedY).toBe(false);
      expect(nudged.top).toBe(VIEWPORT.h - PREVIEW_MARGIN_PX - BOX.h);
    });

    it("gives it up when the box genuinely stops fitting", () => {
      const preferBelow = { flippedX: false, flippedY: false };
      const at = placePreview({ x: 200, y: 880 }, BOX, VIEWPORT, {
        prefer: preferBelow,
      });

      expect(at.flippedY).toBe(true);
    });

    it("does not oscillate as the cursor creeps across the boundary", () => {
      // The overlay feeds the previous result back in, so this is the loop it
      // actually runs. A side that changes more than once here is a preview
      // that visibly strobes.
      let side: { flippedX: boolean; flippedY: boolean } | undefined;
      const sides: string[] = [];

      for (let y = 560; y <= 700; y += 1) {
        const at = placePreview({ x: 200, y }, BOX, VIEWPORT, { prefer: side });
        side = at;
        sides.push(`${at.flippedY}`);

        const covers =
          200 >= at.left &&
          200 <= at.left + BOX.w &&
          y >= at.top &&
          y <= at.top + BOX.h;
        expect(covers, `covered the cursor at y=${y}`).toBe(false);
      }

      const changes = sides.filter((s, i) => i > 0 && s !== sides[i - 1]);
      expect(changes).toHaveLength(1);
    });

    it("does not stick to a side that never fitted", () => {
      // Preferring the left at the left edge must not push the box off screen.
      const at = placePreview({ x: 20, y: 200 }, BOX, VIEWPORT, {
        prefer: { flippedX: true, flippedY: false },
      });

      expect(at.flippedX).toBe(false);
      expect(at.left).toBeGreaterThanOrEqual(PREVIEW_MARGIN_PX);
    });
  });

  it("honours an explicit gap and margin", () => {
    const at = placePreview({ x: 100, y: 100 }, BOX, VIEWPORT, {
      gap: 40,
      margin: 2,
    });

    expect(at.left).toBe(140);
    expect(at.top).toBe(140);
  });

  describe("degenerate input", () => {
    it("pins the top-left corner on screen when the box cannot fit", () => {
      const at = placePreview({ x: 100, y: 100 }, { w: 5000, h: 5000 }, VIEWPORT);

      expect(at.left).toBe(PREVIEW_MARGIN_PX);
      expect(at.top).toBe(PREVIEW_MARGIN_PX);
    });

    it("stays finite for NaN, Infinity and a zero-sized viewport", () => {
      const cases = [
        placePreview({ x: NaN, y: 100 }, BOX, VIEWPORT),
        placePreview({ x: 100, y: Infinity }, BOX, VIEWPORT),
        placePreview({ x: 100, y: 100 }, { w: NaN, h: NaN }, VIEWPORT),
        placePreview({ x: 100, y: 100 }, BOX, { w: 0, h: 0 }),
        placePreview({ x: -Infinity, y: -Infinity }, BOX, { w: NaN, h: NaN }),
      ];

      for (const at of cases) {
        expect(Number.isFinite(at.left)).toBe(true);
        expect(Number.isFinite(at.top)).toBe(true);
      }
    });
  });
});
