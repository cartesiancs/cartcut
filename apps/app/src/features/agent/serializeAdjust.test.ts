import { describe, expect, it } from "vitest";

import { COLOR_ADJUSTMENT_KEYS, type ColorAdjustments } from "../../@types/timeline";
import {
  audioElement,
  gifElement,
  groupElement,
  imageElement,
  shapeElement,
  textElement,
  videoElement,
} from "../renderer/testing";
import { clipDetail, clipRow } from "./serialize";

/**
 * Colour adjustments in the agent's view. Held to the rules `lut` and `blend`
 * already follow: compact in a list, explicit in a detail view, and absent —
 * not `{}` — on a kind of clip that cannot carry them.
 */

const EVERY_SLIDER: ColorAdjustments = Object.fromEntries(
  COLOR_ADJUSTMENT_KEYS.map((key) => [key, key === "sharpen" ? 7 : 11]),
);

describe("clipRow", () => {
  it("says nothing about an unadjusted clip", () => {
    expect("adjust" in clipRow("v", videoElement({}))).toBe(false);
    expect("adjust" in clipRow("v", videoElement({ adjust: {} }))).toBe(false);
    expect("adjust" in clipRow("v", videoElement({ adjust: { exposure: 0 } }))).toBe(false);
  });

  it("reports only the sliders that are moved", () => {
    expect(
      clipRow("v", videoElement({ adjust: { exposure: 20, fade: 0, vignette: -10 } })).adjust,
    ).toEqual({ exposure: 20, vignette: -10 });
  });

  it("reports what renders: clamped, with keys it does not know dropped", () => {
    expect(
      clipRow("v", videoElement({ adjust: { exposure: 400, glow: 3 } as ColorAdjustments })).adjust,
    ).toEqual({ exposure: 100 });
  });
});

describe("clipDetail", () => {
  it("reports {} for an adjustable clip with nothing set", () => {
    for (const element of [
      videoElement({}),
      imageElement({}),
      gifElement({}),
      shapeElement({}),
      textElement({}),
    ]) {
      expect(clipDetail("x", element).adjust, element.filetype).toEqual({});
    }
  });

  it("is absent on audio and on a group, which cannot carry adjustments", () => {
    expect("adjust" in clipDetail("a", audioElement({}))).toBe(false);
    expect("adjust" in clipDetail("g", groupElement({}))).toBe(false);
  });

  it("reports every moved slider", () => {
    expect(clipDetail("v", videoElement({ adjust: EVERY_SLIDER })).adjust).toEqual(EVERY_SLIDER);
  });

  it("costs at most fifteen numbers however many sliders are moved", () => {
    const adjust = clipDetail("v", videoElement({ adjust: EVERY_SLIDER })).adjust as Record<
      string,
      unknown
    >;
    expect(Object.values(adjust).filter((v) => typeof v === "number")).toHaveLength(15);
  });
});
