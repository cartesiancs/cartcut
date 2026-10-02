import { describe, expect, it } from "vitest";
import { FIT_PADDING_PX } from "../preview/viewport";
import {
  STAGE_ZOOM_MIN,
  containViewport,
  panViewport,
  pointerIntent,
  stageFit,
  stageGeometry,
  stagePoint,
  wheelViewport,
  type StageSize,
} from "./stageView";

/** A 16:9 working frame on a stage wider than it is tall. */
const WIDE: StageSize = { viewW: 1000, viewH: 600, frameW: 960, frameH: 540 };

/** A 9:16 phone clip on the same stage: x fits long after y has to pan. */
const PORTRAIT: StageSize = { viewW: 1000, viewH: 600, frameW: 540, frameH: 960 };

const NO_PAN = { deltaX: 0, deltaY: 0 };

describe("containViewport", () => {
  it("centres the frame at fit, wherever the centre was asked to be", () => {
    expect(
      containViewport({ zoom: 100, center: { x: 0, y: 900 } }, WIDE),
    ).toEqual(stageFit(WIDE));
  });

  it("will not zoom out past fit", () => {
    const out = containViewport({ zoom: 20, center: { x: 10, y: 10 } }, WIDE);

    expect(out.zoom).toBe(STAGE_ZOOM_MIN);
    expect(out.center).toEqual({ x: 480, y: 270 });
  });

  it("stops the frame's edge one fit padding inside the stage", () => {
    const out = containViewport(
      { zoom: 400, center: { x: 5000, y: -5000 } },
      WIDE,
    );
    const geometry = stageGeometry(out, WIDE);

    const right = WIDE.frameW * geometry.scale + geometry.offsetX;
    const top = geometry.offsetY;
    expect(right).toBeCloseTo(WIDE.viewW - FIT_PADDING_PX, 6);
    expect(top).toBeCloseTo(FIT_PADDING_PX, 6);
  });

  it("centres an axis that still fits while the other one pans", () => {
    // At 150% the portrait frame is 1.5 * 552 = 828px tall and about 466px
    // wide: y is past the stage and may move, x is narrower than it and may not.
    const out = containViewport(
      { zoom: 150, center: { x: 0, y: 0 } },
      PORTRAIT,
    );

    expect(out.center.x).toBe(PORTRAIT.frameW / 2);
    expect(out.center.y).toBeGreaterThan(0);
    expect(out.center.y).toBeLessThan(PORTRAIT.frameH / 2);
  });

  it("answers a fit for a viewport that is not a number", () => {
    expect(
      containViewport({ zoom: Number.NaN, center: { x: Number.NaN, y: 3 } }, WIDE),
    ).toEqual(stageFit(WIDE));
  });
});

describe("panViewport", () => {
  it("moves the picture with the drag, by view pixels", () => {
    const start = { zoom: 400, center: { x: 480, y: 270 } };
    const before = stagePoint(start, WIDE, 500, 300);

    const moved = panViewport(start, 40, -20, WIDE);

    // The frame pixel that was under (500, 300) is now under (540, 280).
    const after = stagePoint(moved, WIDE, 540, 280);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(moved.center).not.toEqual(start.center);
  });

  it("does nothing at fit, where there is nowhere to go", () => {
    expect(panViewport(stageFit(WIDE), 300, 300, WIDE)).toEqual(stageFit(WIDE));
  });
});

describe("wheelViewport", () => {
  it("pans on a plain wheel, against the scroll as the preview does", () => {
    const start = { zoom: 400, center: { x: 480, y: 270 } };

    const out = wheelViewport(
      start,
      { deltaX: 30, deltaY: 10, ctrlKey: false },
      { x: 0, y: 0 },
      WIDE,
    );

    expect(out.zoom).toBe(400);
    expect(out.center.x).toBeGreaterThan(start.center.x);
    expect(out.center.y).toBeGreaterThan(start.center.y);
  });

  it("zooms toward the pointer on a pinch", () => {
    const start = { zoom: 400, center: { x: 480, y: 270 } };
    const at = { x: 620, y: 240 };
    const before = stagePoint(start, WIDE, at.x, at.y);

    const out = wheelViewport(
      start,
      { ...NO_PAN, deltaY: -20, ctrlKey: true },
      at,
      WIDE,
    );

    expect(out.zoom).toBeGreaterThan(400);
    const after = stagePoint(out, WIDE, at.x, at.y);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("lands exactly on fit when a pinch out overshoots it", () => {
    const out = wheelViewport(
      { zoom: 140, center: { x: 600, y: 200 } },
      { ...NO_PAN, deltaY: 500, ctrlKey: true },
      { x: 900, y: 100 },
      WIDE,
    );

    expect(out).toEqual(stageFit(WIDE));
  });
});

describe("pointerIntent", () => {
  const onPicture = { x: 100, y: 100 };
  const offPicture = { x: -4, y: 100 };
  const left = { button: 0, altKey: false };

  it("places the box on a plain press on the picture", () => {
    expect(pointerIntent(left, onPicture, WIDE, true)).toBe("place");
  });

  it("pans from the margin around the picture", () => {
    expect(pointerIntent(left, offPicture, WIDE, true)).toBe("pan");
  });

  it("pans on the picture while a box cannot be placed", () => {
    expect(pointerIntent(left, onPicture, WIDE, false)).toBe("pan");
  });

  it("always pans with the middle button or alt", () => {
    expect(
      pointerIntent({ button: 1, altKey: false }, onPicture, WIDE, true),
    ).toBe("pan");
    expect(
      pointerIntent({ button: 0, altKey: true }, onPicture, WIDE, true),
    ).toBe("pan");
  });

  it("ignores the right button", () => {
    expect(
      pointerIntent({ button: 2, altKey: false }, onPicture, WIDE, true),
    ).toBe("none");
  });

  it("treats the frame's far edge as outside it", () => {
    expect(
      pointerIntent(left, { x: WIDE.frameW, y: 10 }, WIDE, true),
    ).toBe("pan");
    expect(
      pointerIntent(left, { x: WIDE.frameW - 0.5, y: 10 }, WIDE, true),
    ).toBe("place");
  });
});
