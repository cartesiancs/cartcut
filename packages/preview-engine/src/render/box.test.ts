import { describe, it, expect } from "vitest";
import { resolveElementBox } from "./box";
import { track } from "../test/canvas";
import type { RenderElement } from "../model/timeline.types";

const box = {
  location: { x: 100, y: 50 },
  width: 200,
  height: 80,
  rotation: 0,
  opacity: 100,
  startTime: 0,
  duration: 4000,
  animation: {},
};

describe("resolveElementBox", () => {
  it("gives the authored box when nothing is animated", () => {
    expect(resolveElementBox({ ...box, filetype: "image" }, 0)).toEqual({
      x: 100,
      y: 50,
      w: 200,
      h: 80,
      rotation: 0,
    });
  });

  it("follows scale and position for image and video", () => {
    const el: RenderElement = {
      ...box,
      filetype: "image",
      animation: {
        scale: { isActivate: true, ax: track([0, 20]) },
        position: { isActivate: true, ax: track([0, 300]), ay: track([0, 400]) },
      },
    };
    const image = resolveElementBox(el, 0)!;
    expect(image.w).toBe(400);
    expect(image.h).toBe(160);
    expect(image.x).toBe(300 - 100);
    expect(image.y).toBe(400 - 40);

    const video = resolveElementBox({ ...el, filetype: "video" }, 0);
    expect(video).toEqual(image);
  });

  it("moves text without resizing it — text scales its font, not its box", () => {
    const el: RenderElement = {
      ...box,
      filetype: "text",
      animation: {
        scale: { isActivate: true, ax: track([0, 200]) },
        position: { isActivate: true, ax: track([0, 300]), ay: track([0, 400]) },
      },
    };
    expect(resolveElementBox(el, 0)).toEqual({
      x: 300,
      y: 400,
      w: 200,
      h: 80,
      rotation: 0,
    });
  });

  it("ignores position and scale tracks for gif and shape", () => {
    const animated = {
      ...box,
      animation: {
        scale: { isActivate: true, ax: track([0, 20]) },
        position: { isActivate: true, ax: track([0, 300]), ay: track([0, 400]) },
      },
    };
    const expected = { x: 100, y: 50, w: 200, h: 80, rotation: 0 };
    expect(resolveElementBox({ ...animated, filetype: "gif" }, 0)).toEqual(expected);
    expect(resolveElementBox({ ...animated, filetype: "shape" }, 0)).toEqual(expected);
  });

  it("reports the sampled rotation in radians", () => {
    const el: RenderElement = {
      ...box,
      filetype: "image",
      animation: { rotation: { isActivate: true, ax: track([0, 90]) } },
    };
    expect(resolveElementBox(el, 0)!.rotation).toBeCloseTo(Math.PI / 2, 10);
    expect(
      resolveElementBox({ ...el, filetype: "text" }, 0)!.rotation,
    ).toBeCloseTo(Math.PI / 2, 10);
  });

  it("converts static rotation degrees for kinds without a rotation track", () => {
    expect(
      resolveElementBox({ ...box, filetype: "shape", rotation: 180 }, 0)!
        .rotation,
    ).toBeCloseTo(Math.PI, 10);
  });

  it("returns null when the element aborted its draw", () => {
    const el: RenderElement = {
      ...box,
      filetype: "image",
      startTime: 5000,
      animation: { opacity: { isActivate: true, ax: track([0, 100]) } },
    };
    expect(resolveElementBox(el, 0)).toBeNull();
    expect(resolveElementBox({ ...el, filetype: "text" }, 0)).toBeNull();
  });

  it("honours ignorePosition so chrome tracks a dragged element", () => {
    const el: RenderElement = {
      ...box,
      filetype: "image",
      animation: {
        position: { isActivate: true, ax: track([0, 300]), ay: track([0, 400]) },
      },
    };
    const pinned = resolveElementBox(el, 0, { ignorePosition: true })!;
    expect(pinned.x).toBe(100);
    expect(pinned.y).toBe(50);

    const text = resolveElementBox({ ...el, filetype: "text" }, 0, {
      ignorePosition: true,
    })!;
    expect(text.x).toBe(100);
    expect(text.y).toBe(50);
  });
});
