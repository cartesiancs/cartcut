import { describe, it, expect } from "vitest";
import {
  addEffect,
  addEffectTrack,
  effectOf,
  setEffectBlend,
  setEffectIntensity,
  setEffectParams,
  setEffectPreset,
} from "./effectOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  trackById,
  type TimelineDocument,
} from "./tracks";
import { DEFAULT_INTENSITY } from "../element/effectElement";
import { videoElement } from "../renderer/testing";
import {
  animatableProperties,
  canAnimate,
  isVisualTimelineElement,
  type EffectElementType,
} from "../../@types/timeline";

function videoDoc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      clip: videoElement({ trackId: "v0", startTime: 0, duration: 4000 }),
    },
  });
}

function effect(doc: TimelineDocument, id: string): EffectElementType {
  const element = doc.elements[id];
  if (element == null || element.filetype !== "effect") {
    throw new Error(`${id} is not an effect`);
  }
  return element;
}

describe("addEffect", () => {
  it("lands on an effect track, creating one if there is none", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 0, 2000, "e0");
    const fx = effect(doc, "fx");

    const track = trackById(doc, fx.trackId);
    expect(track?.kind).toBe("effect");
    expect(track?.name).toBe("E1");
  });

  it("carries the preset and its parameters", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 500, 2000, "e0", {
      amount: 60,
    });
    expect(effectOf(doc.elements.fx)).toEqual({
      presetId: "rain",
      params: { amount: 60 },
      intensity: DEFAULT_INTENSITY,
      blend: undefined,
    });
    expect(effect(doc, "fx").startTime).toBe(500);
    expect(effect(doc, "fx").duration).toBe(2000);
  });

  it("has no box on canvas — it always covers the whole frame", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 0, 2000, "e0");
    const fx = effect(doc, "fx") as any;
    expect(fx.width).toBeUndefined();
    expect(fx.height).toBeUndefined();
    expect(fx.rotation).toBeUndefined();
  });

  it("stacks onto a second row rather than overlapping on one", () => {
    let doc = addEffect(videoDoc(), "fx1", "rain", 0, 2000, "e0");
    doc = addEffect(doc, "fx2", "vignette", 0, 2000, "e1");
    expect(effect(doc, "fx2").trackId).not.toBe(effect(doc, "fx1").trackId);
  });

  it("shares a row when the two do not overlap in time", () => {
    let doc = addEffect(videoDoc(), "fx1", "rain", 0, 2000, "e0");
    doc = addEffect(doc, "fx2", "vignette", 2000, 2000, "e1");
    expect(effect(doc, "fx2").trackId).toBe(effect(doc, "fx1").trackId);
  });

  it("declines by identity on a taken id or a non-positive length", () => {
    const doc = videoDoc();
    expect(addEffect(doc, "clip", "rain", 0, 2000, "e0")).toBe(doc);
    expect(addEffect(doc, "fx", "rain", 0, 0, "e0")).toBe(doc);
    expect(addEffect(doc, "fx", "rain", 0, -5, "e0")).toBe(doc);
  });
});

describe("setEffectPreset", () => {
  it("re-seeds the parameters instead of carrying them across", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 0, 2000, "e0", {
      amount: 60,
    });
    const next = setEffectPreset(doc, "fx", "vignette", { softness: 0.5 });

    expect(effect(next, "fx").presetId).toBe("vignette");
    // `amount` meant something to `rain`. Leaving it here would let the new
    // preset read a value it never declared and never validated.
    expect(effect(next, "fx").params).toEqual({ softness: 0.5 });
  });

  it("declines when that preset is already selected", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 0, 2000, "e0");
    expect(setEffectPreset(doc, "fx", "rain", {})).toBe(doc);
  });

  it("declines on a non-effect id", () => {
    const doc = videoDoc();
    expect(setEffectPreset(doc, "clip", "rain", {})).toBe(doc);
    expect(setEffectPreset(doc, "nope", "rain", {})).toBe(doc);
  });
});

describe("setEffectParams", () => {
  it("patches only the named keys", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 0, 2000, "e0", {
      amount: 60,
      tint: "#ffffff",
    });
    const next = setEffectParams(doc, "fx", { amount: 20 });
    expect(effect(next, "fx").params).toEqual({
      amount: 20,
      tint: "#ffffff",
    });
  });

  it("declines when nothing would change", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 0, 2000, "e0", {
      amount: 60,
    });
    expect(setEffectParams(doc, "fx", { amount: 60 })).toBe(doc);
    expect(setEffectParams(doc, "fx", {})).toBe(doc);
  });
});

describe("setEffectIntensity", () => {
  it("clamps to 0-100 rather than refusing an over-scrubbed spinner", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 0, 2000, "e0");
    expect(effect(setEffectIntensity(doc, "fx", 250), "fx").intensity).toBe(100);
    expect(effect(setEffectIntensity(doc, "fx", -40), "fx").intensity).toBe(0);
  });

  it("declines when the clamped value is already held", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 0, 2000, "e0");
    expect(setEffectIntensity(doc, "fx", 100)).toBe(doc);
    expect(setEffectIntensity(doc, "fx", 900)).toBe(doc);
  });
});

describe("setEffectBlend", () => {
  it("sets and clears the field", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 0, 2000, "e0");
    const screened = setEffectBlend(doc, "fx", "screen");
    expect(effect(screened, "fx").blend).toBe("screen");

    const cleared = setEffectBlend(screened, "fx", null);
    // Removed, not set to undefined: `JSON.stringify` drops an undefined value,
    // so a saved project would differ from the one in memory.
    expect("blend" in effect(cleared, "fx")).toBe(false);
  });

  it("declines when the value is unchanged", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 0, 2000, "e0");
    expect(setEffectBlend(doc, "fx", null)).toBe(doc);
    const screened = setEffectBlend(doc, "fx", "screen");
    expect(setEffectBlend(screened, "fx", "screen")).toBe(screened);
  });
});

describe("addEffectTrack", () => {
  it("goes to the top of the stack, where it applies to everything", () => {
    const doc = addEffectTrack(videoDoc(), "e0");
    expect(trackById(doc, "e0")?.index).toBe(0);
    expect(trackById(doc, "v0")?.index).toBe(1);
  });

  it("declines when that track already exists", () => {
    const doc = addEffectTrack(videoDoc(), "e0");
    expect(addEffectTrack(doc, "e0")).toBe(doc);
  });
});

describe("an effect's place in the type system", () => {
  it("is excluded from the paint loop, so it needs no renderer entry", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 0, 2000, "e0");
    expect(isVisualTimelineElement(doc.elements.fx)).toBe(false);
  });

  it("animates opacity and nothing else", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 0, 2000, "e0");
    expect(canAnimate(doc.elements.fx)).toBe(true);
    // No position, scale or rotation: there is no box to move.
    expect(animatableProperties(doc.elements.fx)).toEqual(["opacity"]);
  });

  it("carries the opacity animation block that keyframe editing needs", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 0, 2000, "e0");
    expect(effect(doc, "fx").animation.opacity).toEqual({
      isActivate: false,
      x: [],
      ax: [],
    });
  });

  it("takes a paint rank from its row, which is what scopes it", () => {
    const doc = addEffect(videoDoc(), "fx", "rain", 0, 2000, "e0");
    // Row 0 is the front of the composite, so the effect paints last and
    // therefore applies to the clip beneath it.
    expect(effect(doc, "fx").priority).toBeGreaterThan(
      doc.elements.clip.priority,
    );
  });
});
