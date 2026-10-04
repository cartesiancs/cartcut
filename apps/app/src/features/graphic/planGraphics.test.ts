import { describe, expect, it } from "vitest";
import type { GraphicElementType, Timeline } from "../../@types/timeline";
import { createGraphicElement } from "../element/graphicElement";
import { coerceInlineProgram, toRawPayload } from "../fx/inlineProgram";
import type { FxPreset } from "../fx/presetTypes";
import { validatePreset } from "../fx/presetValidate";
import { planGraphics, quantizeScale, type PlanInput } from "./planGraphics";

function htmlPreset(css: string): { program: any; preset: FxPreset } {
  const result = coerceInlineProgram({
    kind: "graphic",
    name: "T",
    render: { type: "html", html: '<h1 data-param="title" data-split="chars"></h1>', css },
    params: [
      { key: "title", label: "T", type: "text", default: "Hi" },
      { key: "size", label: "S", type: "number", default: 40, min: 10, max: 100 },
    ],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const validated = validatePreset(toRawPayload(result.program));
  if (!validated.ok) throw new Error(validated.errors.join("\n"));
  return { program: result.program, preset: validated.preset };
}

const ANIMATED = htmlPreset("h1 { font-size: calc(var(--size) * 1px); animation: rise 1s; } @keyframes rise { from { opacity: 0 } }");
const STILL = htmlPreset("h1 { font-size: calc(var(--size) * 1px); }");

function graphic(preset: { program: any }, over: Partial<GraphicElementType> = {}): GraphicElementType {
  return {
    ...createGraphicElement({
      program: preset.program,
      params: { title: "Hi", size: 40 },
      name: "g",
      startTime: 1000,
      duration: 2000,
      width: 400,
      height: 200,
    }),
    trackId: "t",
    priority: 1,
    ...over,
  };
}

function input(elements: Timeline, timeInMs: number, over: Partial<PlanInput> = {}): PlanInput {
  const presets = new Map<string, FxPreset>([
    [ANIMATED.program.hash, ANIMATED.preset],
    [STILL.program.hash, STILL.preset],
  ]);
  return {
    elements,
    timeInMs,
    fps: 30,
    presetOf: (element) => presets.get(element.program?.hash ?? "") ?? null,
    scaleOf: () => 1,
    resolvers: { fontFamilyOf: () => "x", imageUrlOf: () => null },
    fontGeneration: 0,
    ...over,
  };
}

describe("planGraphics", () => {
  it("plans a visible html graphic and skips one off screen or on a hidden row", () => {
    const elements: Timeline = {
      on: graphic(ANIMATED),
      later: graphic(ANIMATED, { startTime: 9000 }),
      hidden: graphic(ANIMATED, { trackHidden: true } as any),
    };
    const jobs = planGraphics(input(elements, 1500));
    expect(jobs.map((j) => j.instanceId)).toEqual(["on"]);
    const job = jobs[0];
    expect(job.texts).toEqual({ title: "Hi" });
    expect(job.vars["--t"]).toBe("0.5");
    expect(job.layoutBox).toEqual({ width: 400, height: 200 });
    expect(job.raster).toEqual({ width: 400, height: 200 });
  });

  it("keys an animated graphic by time and a static one not", () => {
    const a1 = planGraphics(input({ g: graphic(ANIMATED) }, 1500))[0];
    const a2 = planGraphics(input({ g: graphic(ANIMATED) }, 1600))[0];
    expect(a1.key).not.toBe(a2.key);
    const s1 = planGraphics(input({ g: graphic(STILL) }, 1500))[0];
    const s2 = planGraphics(input({ g: graphic(STILL) }, 2900))[0];
    expect(s1.static).toBe(true);
    expect(s1.key).toBe(s2.key);
  });

  it("changes the key with a value, the raster size or a font arriving", () => {
    const base = planGraphics(input({ g: graphic(STILL) }, 1500))[0].key;
    const value = planGraphics(input({ g: graphic(STILL, { params: { title: "Yo", size: 40 } }) }, 1500))[0].key;
    const scaled = planGraphics(input({ g: graphic(STILL) }, 1500, { scaleOf: () => 2 }))[0];
    const fonts = planGraphics(input({ g: graphic(STILL) }, 1500, { fontGeneration: 1 }))[0].key;
    expect(new Set([base, value, scaled.key, fonts]).size).toBe(4);
    expect(scaled.raster).toEqual({ width: 800, height: 400 });
  });

  it("plans a graphic inside a template at the template's inner cursor, under its namespaced id", () => {
    const inner = graphic(ANIMATED, { startTime: 0 });
    const template = { filetype: "template", startTime: 5000, duration: 3000, trackId: "t", priority: 1, width: 10, height: 10, location: { x: 0, y: 0 } } as any;
    const jobs = planGraphics(
      input({ tpl: template }, 5500, {
        expandTemplate: (id, _el, cursor) => ({
          elements: { [id + "::inner"]: inner },
          cursor: cursor - 5000,
        }),
      }),
    );
    expect(jobs.map((j) => j.instanceId)).toEqual(["tpl::inner"]);
    expect(jobs[0].vars["--t"]).toBe("0.5");
  });

  it("ignores a GLSL graphic, which draws without a raster", () => {
    const shader = coerceInlineProgram({
      kind: "graphic",
      name: "S",
      render: { type: "shader", fragment: "vec4 graphic(vec2 uv) { return vec4(1.0); }" },
    });
    if (!shader.ok) throw new Error("shader");
    const g = graphic({ program: shader.program });
    const jobs = planGraphics(input({ g }, 1500, { presetOf: () => ({ ...ANIMATED.preset, render: { type: "shader", source: "main.frag" } }) as FxPreset }));
    expect(jobs).toEqual([]);
  });
});

describe("quantizeScale", () => {
  it("rounds up onto thirds of an octave, landing on 1, 2 and 4 exactly", () => {
    expect(quantizeScale(1)).toBe(1);
    expect(quantizeScale(2)).toBe(2);
    expect(quantizeScale(4)).toBe(4);
    expect(quantizeScale(1.1)).toBe(1.2599);
    expect(quantizeScale(0.7)).toBe(0.7937);
    expect(quantizeScale(Number.NaN)).toBe(1);
  });
});
