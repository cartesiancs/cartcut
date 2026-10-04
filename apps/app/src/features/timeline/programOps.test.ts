import { describe, expect, it } from "vitest";
import type {
  EffectElementType,
  InlineProgram,
  TransitionElementType,
} from "../../@types/timeline";
import { coerceInlineProgram } from "../fx/inlineProgram";
import { videoElement } from "../renderer/testing";
import {
  addEffect,
  setEffectPreset,
  setEffectProgram,
} from "./effectOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import {
  addTransition,
  setTransitionPreset,
  setTransitionProgram,
} from "./transitionOps";

function program(kind: "effect" | "transition", body: string): InlineProgram {
  const result = coerceInlineProgram({
    kind,
    name: "p",
    render: { type: "shader", fragment: body },
    params:
      kind === "effect"
        ? [
            {
              key: "amount",
              label: "Amount",
              uniform: "amount",
              type: "number",
              default: 1,
              min: 0,
              max: 2,
            },
          ]
        : [],
  });
  if (!result.ok) {
    throw new Error(JSON.stringify(result.errors));
  }
  return result.program;
}

const DIM = program(
  "effect",
  "uniform float amount; vec4 effect(vec2 uv) { return getSourceColor(uv) * amount; }",
);
const BRIGHT = program(
  "effect",
  "uniform float amount; vec4 effect(vec2 uv) { return getSourceColor(uv) * (1.0 + amount); }",
);
const FADE = program(
  "transition",
  "vec4 transition(vec2 uv) { return mix(getFromColor(uv), getToColor(uv), progress); }",
);

function videoDoc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      a: videoElement({
        trackId: "v0",
        startTime: 0,
        duration: 4000,
        trim: { startTime: 2000, endTime: 6000 },
        sourceDuration: 10_000,
      }),
      b: videoElement({
        trackId: "v0",
        startTime: 4000,
        duration: 4000,
        trim: { startTime: 2000, endTime: 6000 },
        sourceDuration: 10_000,
      }),
    },
  });
}

function effect(doc: TimelineDocument, id = "fx"): EffectElementType {
  return doc.elements[id] as EffectElementType;
}

function transition(doc: TimelineDocument, id = "t"): TransitionElementType {
  return doc.elements[id] as TransitionElementType;
}

describe("an effect with an inline program", () => {
  it("is added under the program's own id, whatever id the caller passed", () => {
    const doc = addEffect(videoDoc(), "fx", "ignored", 0, 2000, "e0", { amount: 1 }, {
      program: DIM,
    });
    expect(effect(doc).presetId).toBe("inline." + DIM.hash);
    expect(effect(doc).program).toBe(DIM);
  });

  it("swaps programs, and declines a resubmission of the same one", () => {
    const doc = addEffect(videoDoc(), "fx", "", 0, 2000, "e0", { amount: 1 }, {
      program: DIM,
    });
    const swapped = setEffectProgram(doc, "fx", BRIGHT, { amount: 0.5 });
    expect(effect(swapped).presetId).toBe("inline." + BRIGHT.hash);
    expect(effect(swapped).params).toEqual({ amount: 0.5 });

    expect(setEffectProgram(swapped, "fx", { ...BRIGHT }, { amount: 0.5 })).toBe(
      swapped,
    );
    expect(setEffectProgram(swapped, "fx", BRIGHT, { amount: 0.75 })).not.toBe(
      swapped,
    );
  });

  it("declines a missing or non-effect element", () => {
    const doc = videoDoc();
    expect(setEffectProgram(doc, "nope", DIM, {})).toBe(doc);
    expect(setEffectProgram(doc, "a", DIM, {})).toBe(doc);
  });

  it("drops the program, key and all, on a switch to an installed preset", () => {
    const doc = addEffect(videoDoc(), "fx", "", 0, 2000, "e0", { amount: 1 }, {
      program: DIM,
    });
    const installed = setEffectPreset(doc, "fx", "com.example.rain", {});
    expect(effect(installed).presetId).toBe("com.example.rain");
    expect("program" in effect(installed)).toBe(false);
  });

  it("drops the tracks of parameters the new program does not have", () => {
    const doc = addEffect(videoDoc(), "fx", "", 0, 2000, "e0", { amount: 1 }, {
      program: DIM,
    });
    const keyed: TimelineDocument = {
      ...doc,
      elements: {
        ...doc.elements,
        fx: {
          ...effect(doc),
          animation: {
            ...(effect(doc) as any).animation,
            "fx:amount": { isActivate: true, x: [], ax: [] },
          },
        } as EffectElementType,
      },
    };
    const swapped = setEffectProgram(keyed, "fx", FADE as any, {});
    expect((effect(swapped) as any).animation["fx:amount"]).toBeUndefined();
  });
});

describe("a transition with an inline program", () => {
  it("is added under the program's id and carries the program", () => {
    const doc = addTransition(videoDoc(), "t", "a", "b", "x", 800, "center", {}, FADE);
    expect(transition(doc).presetId).toBe("inline." + FADE.hash);
    expect(transition(doc).program).toEqual(FADE);
  });

  it("swaps, declines a no-op, and loses the program to an installed preset", () => {
    const doc = addTransition(videoDoc(), "t", "a", "b", "com.example.fade", 800, "center");
    expect("program" in transition(doc)).toBe(false);

    const inline = setTransitionProgram(doc, "t", FADE, {});
    expect(transition(inline).program).toBe(FADE);
    expect(setTransitionProgram(inline, "t", FADE, {})).toBe(inline);

    const back = setTransitionPreset(inline, "t", "com.example.fade", {});
    expect("program" in transition(back)).toBe(false);
    expect(setTransitionProgram(doc, "a", FADE, {})).toBe(doc);
  });
});
