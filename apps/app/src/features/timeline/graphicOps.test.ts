import { describe, expect, it } from "vitest";
import {
  animatableProperties,
  canAnimate,
  isVisualTimelineElement,
  type GraphicElementType,
  type InlineProgram,
} from "../../@types/timeline";
import { normalizeAnimation } from "../animation/keyframes";
import { moveKeyframe, toggleKeyframe } from "../animation/keyframeOps";
import { coerceInlineProgram } from "../fx/inlineProgram";
import { splitClip, trimClipStart } from "./clipOps";
import {
  addGraphic,
  setGraphicName,
  setGraphicParams,
  setGraphicPreset,
  setGraphicProgram,
} from "./graphicOps";
import { canMergeClips, mergeClips } from "./mergeOps";
import { SCHEMA_VERSION, normalizeDocument, trackById, type TimelineDocument } from "./tracks";

function program(body: string): InlineProgram {
  const result = coerceInlineProgram({
    kind: "graphic",
    name: "Glow",
    render: { type: "shader", fragment: body },
    params: [
      { key: "tint", label: "Tint", uniform: "tint", type: "color", default: "#ff8800" },
      { key: "speed", label: "Speed", uniform: "speed", type: "number", default: 1, min: 0, max: 4 },
    ],
  });
  if (!result.ok) {
    throw new Error(JSON.stringify(result.errors));
  }
  return result.program;
}

const GLOW = program(
  "uniform vec3 tint; uniform float speed; vec4 graphic(vec2 uv) { return vec4(tint * fract(uv.x + time * speed), 1.0); }",
);
const OTHER = program(
  "uniform vec3 tint; uniform float speed; vec4 graphic(vec2 uv) { return vec4(tint * uv.y * speed, 1.0); }",
);

function emptyDoc(): TimelineDocument {
  return normalizeDocument({ schemaVersion: SCHEMA_VERSION, tracks: [], elements: {} });
}

function withGraphic(over: Partial<Parameters<typeof addGraphic>[3]> = {}): TimelineDocument {
  return addGraphic(emptyDoc(), "g", "t0", {
    program: GLOW,
    params: { tint: "#ff8800", speed: 1 },
    name: "Glow",
    startMs: 0,
    durationMs: 4000,
    x: 0,
    y: 0,
    width: 640,
    height: 360,
    ...over,
  });
}

function graphic(doc: TimelineDocument, id = "g"): GraphicElementType {
  return doc.elements[id] as GraphicElementType;
}

describe("a graphic in the type system", () => {
  it("is visual and animatable, with one track per numeric parameter", () => {
    const g = graphic(withGraphic());
    expect(isVisualTimelineElement(g)).toBe(true);
    expect(canAnimate(g)).toBe(true);
    expect(animatableProperties(g)).toEqual([
      "position",
      "opacity",
      "scale",
      "rotation",
      "size",
      "fx:speed",
    ]);
  });
});

describe("addGraphic", () => {
  it("places lettering on a text row and a background on a video row", () => {
    const lettering = withGraphic();
    expect(trackById(lettering, graphic(lettering).trackId)?.kind).toBe("text");
    const background = withGraphic({ trackKind: "video" });
    expect(trackById(background, graphic(background).trackId)?.kind).toBe("video");
  });

  it("stores the program under its own id", () => {
    const g = graphic(withGraphic());
    expect(g.presetId).toBe("inline." + GLOW.hash);
    expect(g.program).toBe(GLOW);
    expect(g.localpath).toBe("GRAPHIC");
  });

  it("declines a taken id, no length, no box, or nothing to draw", () => {
    const doc = withGraphic();
    expect(addGraphic(doc, "g", "t1", { ...base(), program: GLOW })).toBe(doc);
    const empty = emptyDoc();
    expect(addGraphic(empty, "x", "t", { ...base(), program: GLOW, durationMs: 0 })).toBe(empty);
    expect(addGraphic(empty, "x", "t", { ...base(), program: GLOW, width: 0 })).toBe(empty);
    expect(addGraphic(empty, "x", "t", base())).toBe(empty);
  });
});

function base() {
  return { name: "x", startMs: 0, durationMs: 1000, x: 0, y: 0, width: 10, height: 10 };
}

describe("setGraphicProgram, setGraphicPreset, setGraphicParams, setGraphicName", () => {
  it("swaps the program and declines resubmitting the same one", () => {
    const doc = withGraphic();
    const swapped = setGraphicProgram(doc, "g", OTHER, { tint: "#00ff00", speed: 2 });
    expect(graphic(swapped).presetId).toBe("inline." + OTHER.hash);
    expect(setGraphicProgram(swapped, "g", { ...OTHER }, { tint: "#00ff00", speed: 2 })).toBe(
      swapped,
    );
  });

  it("drops the program on a switch to an installed preset", () => {
    const next = setGraphicPreset(withGraphic(), "g", "com.cartcut.graphic.wave", {});
    expect("program" in graphic(next)).toBe(false);
    expect(graphic(next).presetId).toBe("com.cartcut.graphic.wave");
  });

  it("patches params and declines a no-op", () => {
    const doc = withGraphic();
    const next = setGraphicParams(doc, "g", { speed: 3 });
    expect(graphic(next).params).toEqual({ tint: "#ff8800", speed: 3 });
    expect(setGraphicParams(next, "g", { speed: 3 })).toBe(next);
    expect(setGraphicParams(doc, "missing", { speed: 3 })).toBe(doc);
  });

  it("renames, and declines an empty or unchanged name", () => {
    const doc = withGraphic();
    expect(graphic(setGraphicName(doc, "g", "Title")).name).toBe("Title");
    expect(setGraphicName(doc, "g", "  ")).toBe(doc);
    expect(setGraphicName(doc, "g", "Glow")).toBe(doc);
  });
});

describe("a graphic's keyframes", () => {
  it("keeps its fx tracks through a load", () => {
    const g = graphic(withGraphic());
    const keyed = {
      ...g,
      animation: { ...(g as any).animation, "fx:speed": { isActivate: true, x: [0], ax: [2] } },
    };
    expect((normalizeAnimation(keyed) as any).animation["fx:speed"]).toBeDefined();
  });

  it("takes back the last keyframe's value as its static value", () => {
    // Plant a keyframe, move its value, remove it again: the removal writes the
    // value into `params` through the shared fx path, which used to decline
    // anything that was not an effect.
    const planted = toggleKeyframe(withGraphic(), "g", "fx:speed", 1000, 30);
    expect((graphic(planted) as any).animation["fx:speed"].isActivate).toBe(true);
    const moved = moveKeyframe(planted, "g", "fx:speed", "x", 0, 1000, 2.5).doc;
    const removed = toggleKeyframe(moved, "g", "fx:speed", 1000, 30);
    expect(graphic(removed).params.speed).toBe(2.5);
  });
});

describe("a graphic's clock through a cut", () => {
  it("gives the right half the left's length as its head", () => {
    const split = splitClip(withGraphic(), "g", 1500, "r");
    expect(graphic(split, "g").clockTail).toBe(2500);
    expect("clockHead" in graphic(split, "g")).toBe(false);
    expect(graphic(split, "r").clockHead).toBe(1500);
    expect("clockTail" in graphic(split, "r")).toBe(false);
  });

  it("rejoins byte for byte", () => {
    const original = withGraphic();
    const split = splitClip(original, "g", 1500, "r");
    expect(canMergeClips(split, ["g", "r"])).toBe(true);
    const merged = mergeClips(split, ["g", "r"]);
    expect(graphic(merged)).toEqual(graphic(original));
  });

  it("will not join two graphics that run different programs", () => {
    const split = splitClip(withGraphic(), "g", 1500, "r");
    const changed = setGraphicProgram(split, "r", OTHER, { tint: "#ff8800", speed: 1 });
    expect(canMergeClips(changed, ["g", "r"])).toBe(false);
  });

  it("will not join halves whose clocks do not meet", () => {
    const split = splitClip(withGraphic(), "g", 1500, "r");
    const shifted = {
      ...split,
      elements: { ...split.elements, r: { ...graphic(split, "r"), clockHead: 900 } },
    };
    expect(canMergeClips(shifted, ["g", "r"])).toBe(false);
  });

  it("moves the head with a front trim and deletes it on the way back", () => {
    const trimmed = trimClipStart(withGraphic(), "g", 500);
    expect(graphic(trimmed).clockHead).toBe(500);
    const back = trimClipStart(trimmed, "g", -500);
    expect("clockHead" in graphic(back)).toBe(false);
  });
});
