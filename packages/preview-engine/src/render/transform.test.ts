import { describe, it, expect } from "vitest";
import { resolveBoxTransform } from "./transform";
import type { RenderElement } from "../model/timeline.types";

const base: RenderElement = {
  startTime: 0,
  location: { x: 100, y: 50 },
  width: 200,
  height: 80,
  rotation: 0,
  opacity: 100,
  animation: {},
};

describe("resolveBoxTransform", () => {
  it("returns the static box when no animation is active", () => {
    const tf = resolveBoxTransform(base, 1000);
    expect(tf.abort).toBe(false);
    expect(tf).toMatchObject({
      scaleX: 100,
      scaleY: 50,
      scaleW: 200,
      scaleH: 80,
      rotation: 0,
      alpha: 1,
    });
  });

  it("converts static rotation degrees to radians", () => {
    const tf = resolveBoxTransform({ ...base, rotation: 90 }, 0);
    expect(tf.rotation).toBeCloseTo(Math.PI / 2, 10);
  });

  it("applies static opacity as 0..1 alpha", () => {
    expect(resolveBoxTransform({ ...base, opacity: 50 }, 0).alpha).toBe(0.5);
  });

  it("scales around the center (scaleX = x - (scaleW-w)/2)", () => {
    const el: RenderElement = {
      ...base,
      animation: { scale: { isActivate: true, ax: [[0, 20]] } }, // sampleScale -> 2
    };
    const tf = resolveBoxTransform(el, 0);
    expect(tf.scaleW).toBe(400); // 200 * 2
    expect(tf.scaleH).toBe(160); // 80 * 2
    expect(tf.scaleX).toBe(100 - (400 - 200) / 2); // 0
    expect(tf.scaleY).toBe(50 - (160 - 80) / 2); // 10
  });

  it("aborts when a keyframed opacity track is sampled before start", () => {
    const el: RenderElement = {
      ...base,
      startTime: 1000,
      animation: { opacity: { isActivate: true, ax: [[0, 100]] } },
    };
    expect(resolveBoxTransform(el, 0).abort).toBe(true);
  });

  it("moves to sampled position offset by the scale compensation", () => {
    const el: RenderElement = {
      ...base,
      startTime: 0,
      animation: {
        position: { isActivate: true, ax: [[0, 300]], ay: [[0, 400]] },
      },
    };
    const tf = resolveBoxTransform(el, 0);
    // no scale animation -> compareW/H default 1 -> offset by 0.5
    expect(tf.scaleX).toBe(300 - 0.5);
    expect(tf.scaleY).toBe(400 - 0.5);
  });

  it("aborts when a keyframed position track is sampled before start", () => {
    const el: RenderElement = {
      ...base,
      startTime: 1000,
      animation: {
        position: { isActivate: true, ax: [[0, 300]], ay: [[0, 400]] },
      },
    };
    expect(resolveBoxTransform(el, 0).abort).toBe(true);
  });

  it("composes scale, rotation and position together", () => {
    // The preview's video path sampled position before rotation and returned
    // early inside the position branch, so rotation was dropped whenever both
    // tracks were active. All element kinds now compose the same way.
    const el: RenderElement = {
      ...base,
      startTime: 0,
      animation: {
        scale: { isActivate: true, ax: [[0, 20]] }, // -> 2x
        rotation: { isActivate: true, ax: [[0, 90]] },
        position: { isActivate: true, ax: [[0, 300]], ay: [[0, 400]] },
      },
    };
    const tf = resolveBoxTransform(el, 0);
    expect(tf.abort).toBe(false);
    expect(tf.rotation).toBeCloseTo(Math.PI / 2, 10);
    expect(tf.scaleW).toBe(400);
    expect(tf.scaleH).toBe(160);
    // position wins over the scale-centering, offset by the scale compensation
    expect(tf.scaleX).toBe(300 - (400 - 200) / 2);
    expect(tf.scaleY).toBe(400 - (160 - 80) / 2);
  });

  it("applies the sampled opacity track over the static opacity", () => {
    const el: RenderElement = {
      ...base,
      opacity: 100,
      animation: {
        opacity: { isActivate: true, ax: [[0, 100], [1000, 40]] },
      },
    };
    expect(resolveBoxTransform(el, 1000).alpha).toBeCloseTo(0.4, 10);
  });

  it("clamps a negative sampled opacity to zero", () => {
    const el: RenderElement = {
      ...base,
      animation: { opacity: { isActivate: true, ax: [[0, -50]] } },
    };
    expect(resolveBoxTransform(el, 0).alpha).toBe(0);
  });

  it("skips the position track when ignorePosition is set", () => {
    const el: RenderElement = {
      ...base,
      startTime: 0,
      animation: {
        position: { isActivate: true, ax: [[0, 300]], ay: [[0, 400]] },
      },
    };
    const tf = resolveBoxTransform(el, 0, { ignorePosition: true });
    expect(tf.abort).toBe(false);
    expect(tf.scaleX).toBe(100);
    expect(tf.scaleY).toBe(50);
  });

  it("still applies scale and rotation when position is ignored", () => {
    const el: RenderElement = {
      ...base,
      animation: {
        scale: { isActivate: true, ax: [[0, 20]] },
        rotation: { isActivate: true, ax: [[0, 180]] },
        position: { isActivate: true, ax: [[0, 300]], ay: [[0, 400]] },
      },
    };
    const tf = resolveBoxTransform(el, 0, { ignorePosition: true });
    expect(tf.scaleW).toBe(400);
    expect(tf.rotation).toBeCloseTo(Math.PI, 10);
    expect(tf.scaleX).toBe(100 - (400 - 200) / 2);
  });
});
