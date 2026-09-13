import { describe, it, expect } from "vitest";
import { effectSampleAt } from "./effectSample";
import { bakeTrack, normalizeKeyframes } from "../../animation/keyframes";
import { effectElement } from "../testing";
import type { EffectElementType } from "../../../@types/timeline";

/** A live scalar track over `stops`, authored and baked together. */
function track(stops: Array<[number, number]>, isActivate = true) {
  const x = normalizeKeyframes(
    stops.map(([t, v]) => ({
      type: "linear",
      p: [t, v],
      cs: [t, v],
      ce: [t, v],
    })),
  );
  return { isActivate, x, ax: bakeTrack(x, 60) };
}

function effect(over: Partial<EffectElementType> = {}): EffectElementType {
  return effectElement({
    startTime: 1000,
    duration: 2000,
    intensity: 80,
    params: { amount: 0.2, tint: "#ff0000" },
    ...over,
  } as Partial<EffectElementType>);
}

describe("effectSampleAt", () => {
  // The property the compositor's fast path rests on: an effect nobody has
  // animated must hand `applyParams` the very object it always did.
  describe("the unanimated case costs nothing", () => {
    it("returns the element's own params by identity", () => {
      const element = effect();
      const sample = effectSampleAt(element, 2000);
      expect(sample.params).toBe(element.params);
      expect(sample.intensity).toBe(80);
    });

    it("returns them by identity for a track that exists but is switched off", () => {
      const element = effect({
        animation: {
          ...(effect().animation as any),
          "fx:amount": track([[0, 0]], false),
          intensity: track([[0, 0]], false),
        },
      } as Partial<EffectElementType>);
      const sample = effectSampleAt(element, 2000);
      expect(sample.params).toBe(element.params);
      expect(sample.intensity).toBe(80);
    });

    it("returns them by identity where a live curve sits on the static value", () => {
      const element = effect({
        animation: {
          ...(effect().animation as any),
          "fx:amount": track([
            [0, 0.2],
            [2000, 0.2],
          ]),
        },
      } as Partial<EffectElementType>);
      expect(effectSampleAt(element, 2000).params).toBe(element.params);
    });
  });

  describe("a live track drives the value", () => {
    const animated = () =>
      effect({
        animation: {
          ...(effect().animation as any),
          "fx:amount": track([
            [0, 0],
            [2000, 1],
          ]),
          intensity: track([
            [0, 0],
            [2000, 100],
          ]),
        },
      } as Partial<EffectElementType>);

    it("samples at the halfway point", () => {
      // `cursor` is absolute; the element starts at 1000, so 2000 is halfway.
      const sample = effectSampleAt(animated(), 2000);
      expect(sample.params.amount).toBeCloseTo(0.5, 2);
      expect(sample.intensity).toBeCloseTo(50, 1);
    });

    it("leaves the parameters it does not name alone", () => {
      expect(effectSampleAt(animated(), 2000).params.tint).toBe("#ff0000");
    });

    it("does not write back onto the element", () => {
      const element = animated();
      effectSampleAt(element, 2000);
      expect(element.params.amount).toBe(0.2);
      expect(element.intensity).toBe(80);
    });

    it("falls back to the static value before the clip starts", () => {
      // `sampleTrack` answers the fallback for a cursor that has not reached
      // the element, which is the same rule `localSampleAt` follows.
      const element = animated();
      const sample = effectSampleAt(element, 500);
      expect(sample.params).toBe(element.params);
      expect(sample.params.amount).toBe(0.2);
      expect(sample.intensity).toBe(80);
    });
  });

  describe("the values that reach the compositor are bounded", () => {
    it("clamps intensity to 0-100, the range setEffectIntensity enforces", () => {
      const element = effect({
        animation: {
          ...(effect().animation as any),
          // An overshooting curve is supposed to leave its keyframes' range.
          // What is clamped is only what reaches the uniform.
          intensity: track([
            [0, -400],
            [2000, 400],
          ]),
        },
      } as Partial<EffectElementType>);
      expect(effectSampleAt(element, 1000).intensity).toBe(0);
      expect(effectSampleAt(element, 3000).intensity).toBe(100);
    });

    it("leaves a parameter unclamped, because the range is the manifest's", () => {
      // `glslWrap.ts#uniformValueOf` holds the range and clamps there; this
      // module has never seen the manifest.
      const element = effect({
        animation: {
          ...(effect().animation as any),
          "fx:amount": track([
            [0, 50],
            [2000, 50],
          ]),
        },
      } as Partial<EffectElementType>);
      expect(effectSampleAt(element, 2000).params.amount).toBeCloseTo(50, 5);
    });
  });

  describe("an orphan track drives nothing", () => {
    it("ignores a track whose parameter has gone", () => {
      const element = effect({
        params: { tint: "#ff0000" },
        animation: {
          ...(effect().animation as any),
          "fx:amount": track([
            [0, 0],
            [2000, 1],
          ]),
        },
      } as Partial<EffectElementType>);
      const sample = effectSampleAt(element, 2000);
      expect(sample.params).toBe(element.params);
      expect(sample.params.amount).toBeUndefined();
    });

    it("ignores a track whose parameter is not a number", () => {
      const element = effect({
        animation: {
          ...(effect().animation as any),
          "fx:tint": track([
            [0, 0],
            [2000, 1],
          ]),
        },
      } as Partial<EffectElementType>);
      expect(effectSampleAt(element, 2000).params.tint).toBe("#ff0000");
    });
  });
});
