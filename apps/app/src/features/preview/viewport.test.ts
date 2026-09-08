import { describe, it, expect } from "vitest";
import {
  clampZoom,
  computeGeometry,
  fitScale,
  fitViewport,
  screenToWorld,
  worldToScreen,
  zoomAround,
  FIT_PADDING_PX,
  ZOOM_MAX,
  ZOOM_MIN,
  type Viewport,
} from "./viewport";

const VIEW_W = 800;
const VIEW_H = 500;

describe("fitScale", () => {
  it("fits by whichever axis runs out first", () => {
    // 1920x1080 into 800x500 minus padding: width binds (752/1920 < 452/1080).
    expect(fitScale(VIEW_W, VIEW_H, 1920, 1080)).toBeCloseTo(752 / 1920);
    // A portrait frame into the same viewport: height binds.
    expect(fitScale(VIEW_W, VIEW_H, 1080, 1920)).toBeCloseTo(452 / 1920);
  });

  it("falls back to 1 rather than producing NaN or Infinity", () => {
    expect(fitScale(VIEW_W, VIEW_H, 0, 1080)).toBe(1);
    expect(fitScale(VIEW_W, VIEW_H, 1920, NaN)).toBe(1);
    // Before first layout the canvas has no size.
    expect(fitScale(0, 0, 1920, 1080)).toBe(1);
    // Viewport smaller than the padding it wants to leave.
    expect(fitScale(FIT_PADDING_PX, FIT_PADDING_PX, 1920, 1080)).toBe(1);
  });
});

/**
 * The playback preview passes 0 here, which is what makes zoom 100 mean "the
 * frame fills the viewport" rather than "the frame fits with a margin". The
 * padding is a trailing default precisely so every existing caller and every
 * test above keeps the behaviour it had.
 */
describe("fitScale with an explicit padding", () => {
  it("fills the viewport exactly at zero padding", () => {
    expect(fitScale(VIEW_W, VIEW_H, 1920, 1080, 0)).toBeCloseTo(800 / 1920);
    expect(fitScale(VIEW_W, VIEW_H, 1080, 1920, 0)).toBeCloseTo(500 / 1920);
  });

  it("matches the default when handed the default", () => {
    expect(fitScale(VIEW_W, VIEW_H, 1920, 1080, FIT_PADDING_PX)).toBe(
      fitScale(VIEW_W, VIEW_H, 1920, 1080),
    );
  });

  it("still has a viewport to fill when the padding is gone", () => {
    // The one case the default rejects outright: a viewport smaller than its
    // own padding. With none, there is nothing to run out of.
    expect(fitScale(10, 10, 1920, 1080, 0)).toBeCloseTo(10 / 1920);
  });

  it("treats a nonsense padding as none rather than inverting the viewport", () => {
    expect(fitScale(VIEW_W, VIEW_H, 1920, 1080, -100)).toBeCloseTo(800 / 1920);
    expect(fitScale(VIEW_W, VIEW_H, 1920, 1080, NaN)).toBeCloseTo(800 / 1920);
  });
});

describe("computeGeometry with an explicit padding", () => {
  it("puts the frame dead centre, edge to edge on its tight axis", () => {
    const frameW = 1920;
    const frameH = 1080;
    const g = computeGeometry(
      fitViewport(frameW, frameH),
      VIEW_W,
      VIEW_H,
      frameW,
      frameH,
      0,
    );

    const topLeft = worldToScreen(g, 0, 0);
    const bottomRight = worldToScreen(g, frameW, frameH);

    // Width binds at 800/1920, so the frame reaches both vertical edges...
    expect(topLeft.x).toBeCloseTo(0);
    expect(bottomRight.x).toBeCloseTo(VIEW_W);
    // ...and the leftover height is letterboxed symmetrically.
    expect(topLeft.y).toBeCloseTo(VIEW_H - bottomRight.y);
    expect(topLeft.y).toBeGreaterThan(0);
  });

  it("letterboxes the other way for a portrait frame", () => {
    const g = computeGeometry(fitViewport(1080, 1920), VIEW_W, VIEW_H, 1080, 1920, 0);
    const topLeft = worldToScreen(g, 0, 0);
    const bottomRight = worldToScreen(g, 1080, 1920);

    expect(topLeft.y).toBeCloseTo(0);
    expect(bottomRight.y).toBeCloseTo(VIEW_H);
    expect(topLeft.x).toBeCloseTo(VIEW_W - bottomRight.x);
  });

  it("shows nothing outside the frame on the tight axis", () => {
    const g = computeGeometry(fitViewport(1920, 1080), VIEW_W, VIEW_H, 1920, 1080, 0);
    // A world point one pixel left of the frame is off the canvas entirely.
    expect(worldToScreen(g, -1, 0).x).toBeLessThan(0);
    expect(worldToScreen(g, 1921, 0).x).toBeGreaterThan(VIEW_W);
  });
});

describe("fitViewport / computeGeometry", () => {
  it("puts the whole frame on screen with padding at zoom 100", () => {
    const frames: [number, number][] = [
      [1920, 1080],
      [1080, 1920],
      [3840, 2160],
      [1080, 1080],
    ];

    for (const [frameW, frameH] of frames) {
      const vp = fitViewport(frameW, frameH);
      const g = computeGeometry(vp, VIEW_W, VIEW_H, frameW, frameH);

      const topLeft = worldToScreen(g, 0, 0);
      const bottomRight = worldToScreen(g, frameW, frameH);

      expect(topLeft.x).toBeGreaterThanOrEqual(FIT_PADDING_PX - 0.001);
      expect(topLeft.y).toBeGreaterThanOrEqual(FIT_PADDING_PX - 0.001);
      expect(bottomRight.x).toBeLessThanOrEqual(VIEW_W - FIT_PADDING_PX + 0.001);
      expect(bottomRight.y).toBeLessThanOrEqual(VIEW_H - FIT_PADDING_PX + 0.001);
    }
  });

  it("centres the frame", () => {
    const frameW = 1920;
    const frameH = 1080;
    const g = computeGeometry(
      fitViewport(frameW, frameH),
      VIEW_W,
      VIEW_H,
      frameW,
      frameH,
    );
    const centre = worldToScreen(g, frameW / 2, frameH / 2);

    expect(centre.x).toBeCloseTo(VIEW_W / 2);
    expect(centre.y).toBeCloseTo(VIEW_H / 2);
  });

  it("keeps the canvas shape fixed when the resolution changes", () => {
    // The viewport size is what it is; only `scale` reacts to the frame.
    const landscape = computeGeometry(
      fitViewport(1920, 1080),
      VIEW_W,
      VIEW_H,
      1920,
      1080,
    );
    const portrait = computeGeometry(
      fitViewport(1080, 1920),
      VIEW_W,
      VIEW_H,
      1080,
      1920,
    );

    expect(landscape.scale).not.toBeCloseTo(portrait.scale);
    // Both still centre their own frame in the same viewport.
    expect(worldToScreen(landscape, 960, 540).x).toBeCloseTo(VIEW_W / 2);
    expect(worldToScreen(portrait, 540, 960).x).toBeCloseTo(VIEW_W / 2);
  });
});

describe("screenToWorld / worldToScreen", () => {
  it("round-trips, including outside the frame in every quadrant", () => {
    const vp: Viewport = { zoom: 237, center: { x: 900, y: 400 } };
    const g = computeGeometry(vp, VIEW_W, VIEW_H, 1920, 1080);

    const points = [
      { x: 0, y: 0 },
      { x: 960, y: 540 },
      { x: -800, y: -600 }, // up-left of the frame
      { x: 4000, y: -200 }, // up-right
      { x: -300, y: 3000 }, // down-left
      { x: 5000, y: 4000 }, // down-right
    ];

    for (const p of points) {
      const s = worldToScreen(g, p.x, p.y);
      const back = screenToWorld(g, s.x, s.y);
      expect(back.x).toBeCloseTo(p.x);
      expect(back.y).toBeCloseTo(p.y);
    }
  });
});

describe("zoomAround", () => {
  it("keeps the world point under the cursor stationary", () => {
    const frameW = 1920;
    const frameH = 1080;
    const vp = fitViewport(frameW, frameH);

    const cursor = { x: 120, y: 420 }; // deliberately off-centre
    const before = computeGeometry(vp, VIEW_W, VIEW_H, frameW, frameH);
    const anchor = screenToWorld(before, cursor.x, cursor.y);

    for (const zoom of [40, 250, 900]) {
      const next = zoomAround(
        vp,
        zoom,
        cursor.x,
        cursor.y,
        VIEW_W,
        VIEW_H,
        frameW,
        frameH,
      );
      const g = computeGeometry(next, VIEW_W, VIEW_H, frameW, frameH);
      const stillThere = worldToScreen(g, anchor.x, anchor.y);

      expect(next.zoom).toBe(zoom);
      expect(stillThere.x).toBeCloseTo(cursor.x);
      expect(stillThere.y).toBeCloseTo(cursor.y);
    }
  });

  it("clamps the zoom and still anchors at the clamped scale", () => {
    const vp = fitViewport(1920, 1080);
    const cursor = { x: 700, y: 100 };
    const before = computeGeometry(vp, VIEW_W, VIEW_H, 1920, 1080);
    const anchor = screenToWorld(before, cursor.x, cursor.y);

    const next = zoomAround(
      vp,
      100000,
      cursor.x,
      cursor.y,
      VIEW_W,
      VIEW_H,
      1920,
      1080,
    );
    expect(next.zoom).toBe(ZOOM_MAX);

    const g = computeGeometry(next, VIEW_W, VIEW_H, 1920, 1080);
    const stillThere = worldToScreen(g, anchor.x, anchor.y);
    expect(stillThere.x).toBeCloseTo(cursor.x);
    expect(stillThere.y).toBeCloseTo(cursor.y);
  });
});

describe("clampZoom", () => {
  it("bounds the range and rejects non-finite input", () => {
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(1e9)).toBe(ZOOM_MAX);
    expect(clampZoom(150)).toBe(150);
    expect(clampZoom(NaN)).toBe(100);
    expect(clampZoom(Infinity)).toBe(ZOOM_MAX);
  });
});
