import { describe, expect, it } from "vitest";
import type { FxPreset } from "../fx/presetTypes";
import { coerceInlineProgram, toRawPayload } from "../fx/inlineProgram";
import { validatePreset } from "../fx/presetValidate";
import { textElement, imageElement } from "../renderer/testing";
import { SCHEMA_VERSION, createTrack, normalizeDocument, type TimelineDocument } from "./tracks";
import {
  boundParams,
  graphicTwinOf,
  hexColorOf,
  textToGraphic,
} from "./typographyOps";

function htmlPreset(render: Record<string, unknown>, extraParams: unknown[] = []): { program: any; preset: FxPreset } {
  const result = coerceInlineProgram({
    kind: "graphic",
    name: "Wave",
    render: {
      type: "html",
      html: '<h1 data-param="title"></h1>',
      css: "h1 { font-family: var(--face); color: var(--ink); font-size: calc(var(--size) * 1px); text-align: left; } h1 { order: var(--side); }",
      ...render,
    },
    params: [
      { key: "title", label: "Title", type: "text", default: "Hello", maxLength: 10 },
      { key: "face", label: "Font", type: "font", default: "bundled:Anton-Regular.ttf" },
      { key: "ink", label: "Colour", type: "color", default: "#ffffff" },
      { key: "size", label: "Size", type: "number", default: 120, min: 10, max: 400 },
      {
        key: "side",
        label: "Align",
        type: "select",
        default: 1,
        options: [
          { value: 0, label: "Left" },
          { value: 1, label: "Center" },
          { value: 2, label: "Right" },
        ],
      },
      ...extraParams,
    ],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const validated = validatePreset(toRawPayload(result.program));
  if (!validated.ok) throw new Error(validated.errors.join("\n"));
  return { program: result.program, preset: validated.preset };
}

const BINDINGS = { text: "title", font: "face", color: "ink", fontSize: "size", align: "side" };
const REFLOW = htmlPreset({ bindings: BINDINGS });
const SCALED = htmlPreset({
  bindings: BINDINGS,
  layout: "scale",
  designSize: { width: 1600, height: 400 },
});
const UNBOUND = htmlPreset({});

function title(over = {}) {
  return textElement({
    key: "t1",
    trackId: "v1",
    startTime: 3000,
    duration: 2500,
    location: { x: 100, y: 200 },
    width: 800,
    height: 100,
    opacity: 70,
    rotation: 15,
    text: "Hi there",
    textcolor: "#ff8800",
    fontsize: 80,
    fontpath: "/fonts/Anton-Regular.ttf",
    ...over,
  });
}

function doc(elements: Record<string, any>): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "text", 0)],
    elements,
  });
}

const bundledFace = (path: string) =>
  path.endsWith("/Anton-Regular.ttf") ? "bundled:Anton-Regular.ttf" : path;

describe("hexColorOf", () => {
  it("accepts the three hex forms and nothing else", () => {
    expect(hexColorOf("#FF8800")).toBe("#ff8800");
    expect(hexColorOf("#ff8800cc")).toBe("#ff8800");
    expect(hexColorOf("#f80")).toBe("#ff8800");
    expect(hexColorOf("rgb(1,2,3)")).toBeNull();
    expect(hexColorOf(undefined)).toBeNull();
  });
});

describe("boundParams", () => {
  it("carries every bound field into the parameter the manifest names", () => {
    const { params, unbound } = boundParams(title(), REFLOW.preset, 800, bundledFace);
    expect(params).toEqual({
      title: "Hi there",
      face: "bundled:Anton-Regular.ttf",
      ink: "#ff8800",
      size: 80,
      side: 0,
    });
    expect(unbound).toEqual([]);
  });

  it("scales the size into layout px for a scaled program", () => {
    // 1600 layout px across an 800 px box: an 80 px title is 160 in the layout.
    expect(boundParams(title(), SCALED.preset, 800, bundledFace).params.size).toBe(160);
  });

  it("clamps the size to the parameter's range", () => {
    expect(boundParams(title({ fontsize: 4 }), REFLOW.preset, 800, bundledFace).params.size).toBe(10);
  });

  it("cuts the text to the parameter's length and says so", () => {
    const { params, unbound } = boundParams(title({ text: "abcdefghijklmnop" }), REFLOW.preset, 800, bundledFace);
    expect(params.title).toBe("abcdefghij");
    expect(unbound).toEqual(["text past 10 characters"]);
  });

  it("reports every field a program without bindings cannot receive", () => {
    const { params, unbound } = boundParams(title(), UNBOUND.preset, 800, bundledFace);
    expect(params).toEqual({});
    expect(unbound).toEqual(["text", "font", "color", "fontSize", "align"]);
  });

  it("does not report a centred alignment or the default face as lost", () => {
    const { unbound } = boundParams(
      title({ fontpath: "default", options: { ...title().options, align: "center" } }),
      UNBOUND.preset,
      800,
      bundledFace,
    );
    expect(unbound).toEqual(["text", "color", "fontSize"]);
  });
});

describe("graphicTwinOf", () => {
  it("stands where the text stood, under its id and on its row", () => {
    const text = title();
    const { graphic } = graphicTwinOf(text, { preset: REFLOW.preset, program: REFLOW.program }, bundledFace);
    expect(graphic.filetype).toBe("graphic");
    expect(graphic.key).toBe(text.key);
    expect(graphic.trackId).toBe("v1");
    expect(graphic.startTime).toBe(3000);
    expect(graphic.duration).toBe(2500);
    expect(graphic.location).toEqual({ x: 100, y: 200 });
    expect([graphic.width, graphic.height]).toEqual([800, 100]);
    expect([graphic.opacity, graphic.rotation]).toEqual([70, 15]);
    expect(graphic.program).toBe(REFLOW.program);
    expect(graphic.presetId).toBe(REFLOW.preset.id);
  });

  it("lets the caller's values win over the bindings", () => {
    const { graphic } = graphicTwinOf(
      title(),
      { preset: REFLOW.preset, program: REFLOW.program, overrides: { ink: "#00ff00" } },
      bundledFace,
    );
    expect(graphic.params.ink).toBe("#00ff00");
    expect(graphic.params.title).toBe("Hi there");
  });

  it("gives a scaled program its design aspect about the text's centre", () => {
    const { graphic } = graphicTwinOf(title(), { preset: SCALED.preset, program: SCALED.program }, bundledFace);
    // 800 wide at 4:1 is 200 tall; the text's centre was at 250.
    expect([graphic.width, graphic.height]).toEqual([800, 200]);
    expect(graphic.location).toEqual({ x: 100, y: 150 });
  });

  it("moves a position curve with the recentred box", () => {
    const text = title();
    (text as any).animation.position = {
      isActivate: true,
      x: [{ type: "linear", p: [0, 100], cs: [0, 100], ce: [0, 100] }],
      y: [{ type: "linear", p: [0, 200], cs: [0, 200], ce: [0, 200] }],
      ax: [[0, 100]],
      ay: [[0, 200]],
    };
    const { graphic } = graphicTwinOf(text, { preset: SCALED.preset, program: SCALED.program }, bundledFace);
    const position = (graphic as any).animation.position;
    expect(position.y[0].p).toEqual([0, 150]);
    expect(position.ay).toEqual([[0, 150]]);
    expect(position.x[0].p).toEqual([0, 100]);
  });

  it("keeps the box of a clip whose size is keyframed", () => {
    const text = title();
    (text as any).animation.size = {
      isActivate: true,
      x: [{ type: "linear", p: [0, 800], cs: [0, 800], ce: [0, 800] }],
      y: [{ type: "linear", p: [0, 100], cs: [0, 100], ce: [0, 100] }],
      ax: [[0, 800]],
      ay: [[0, 100]],
    };
    const { graphic } = graphicTwinOf(text, { preset: SCALED.preset, program: SCALED.program }, bundledFace);
    expect([graphic.location.y, graphic.height]).toEqual([200, 100]);
  });

  it("carries blend, grade, mask and the parent", () => {
    const text = title({
      blend: "screen",
      lut: { presetId: "x", intensity: 50 },
      parentId: "g1",
      mask: {
        shape: "rectangle",
        location: { x: 50, y: 50 },
        size: { width: 50, height: 50 },
        rotation: 0,
        feather: 0,
        roundness: 0,
        invert: false,
      },
    } as any);
    const { graphic } = graphicTwinOf(text, { preset: REFLOW.preset, program: REFLOW.program }, bundledFace);
    expect(graphic.blend).toBe("screen");
    expect(graphic.lut).toEqual({ presetId: "x", intensity: 50 });
    expect(graphic.parentId).toBe("g1");
    // Same box, so the mask's percentages are unchanged.
    expect(graphic.mask?.location).toEqual({ x: 50, y: 50 });
    expect(graphic.mask?.size).toEqual({ width: 50, height: 50 });
  });

  it("names every styling it could not carry", () => {
    const base = title();
    const text = title({
      runs: [{ start: 0, end: 1, style: { textcolor: "#000000" } }],
      textOpacity: 50,
      letterSpacing: 4,
      options: {
        ...base.options,
        isBold: true,
        outline: { enable: true, size: 2, color: "#000000" },
        shadow: { enable: true, offsetX: 1, offsetY: 1, blur: 2, color: "#000000", opacity: 50 },
      },
      background: { enable: true, color: "#000000" },
    } as any);
    const { dropped } = graphicTwinOf(text, { preset: REFLOW.preset, program: REFLOW.program }, bundledFace);
    expect(dropped).toEqual([
      "runs",
      "outline",
      "shadow",
      "background",
      "textOpacity",
      "letterSpacing",
      "bold",
    ]);
  });

  it("reports nothing lost for a plain title into a fully bound program", () => {
    expect(graphicTwinOf(title(), { preset: REFLOW.preset, program: REFLOW.program }, bundledFace).dropped).toEqual([]);
  });

  it("drops a reveal's progress curve and says so", () => {
    const text = title({ reveal: { unit: "character", animate: {} } } as any);
    (text as any).animation.revealProgress = {
      isActivate: true,
      x: [{ type: "linear", p: [0, 0], cs: [0, 0], ce: [0, 0] }],
      ax: [[0, 0]],
    };
    const { graphic, dropped } = graphicTwinOf(text, { preset: REFLOW.preset, program: REFLOW.program }, bundledFace);
    expect((graphic as any).animation.revealProgress).toBeUndefined();
    expect(dropped).toContain("reveal");
    expect(dropped).toContain("keyframes:revealProgress");
  });

  it("does not share keyframe arrays with the text in the undo history", () => {
    const text = title();
    (text as any).animation.opacity = {
      isActivate: true,
      x: [{ type: "linear", p: [0, 100], cs: [0, 100], ce: [0, 100] }],
      ax: [[0, 100]],
    };
    const { graphic } = graphicTwinOf(text, { preset: REFLOW.preset, program: REFLOW.program }, bundledFace);
    expect((graphic as any).animation.opacity.x).not.toBe((text as any).animation.opacity.x);
    expect((graphic as any).animation.opacity.x).toEqual((text as any).animation.opacity.x);
  });
});

describe("textToGraphic", () => {
  it("replaces the text in place", () => {
    const before = doc({ t1: title() });
    const after = textToGraphic(before, ["t1"], { preset: REFLOW.preset, program: REFLOW.program }, bundledFace);
    expect(after).not.toBe(before);
    expect(after.elements.t1.filetype).toBe("graphic");
    expect(Object.keys(after.elements)).toEqual(["t1"]);
  });

  it("declines by identity when no id names a text clip", () => {
    const before = doc({ i1: imageElement({ trackId: "v1" }) });
    expect(textToGraphic(before, ["i1", "missing"], { preset: REFLOW.preset, program: REFLOW.program })).toBe(before);
  });

  it("converts the text clips of a mixed list and leaves the rest", () => {
    const before = doc({
      t1: title(),
      t2: title({ key: "t2", startTime: 9000 }),
      i1: imageElement({ trackId: "v1", startTime: 20000 }),
    });
    const after = textToGraphic(before, ["t1", "t2", "i1"], { preset: REFLOW.preset, program: REFLOW.program });
    expect(after.elements.t1.filetype).toBe("graphic");
    expect(after.elements.t2.filetype).toBe("graphic");
    expect(after.elements.i1).toEqual(before.elements.i1);
  });
});
