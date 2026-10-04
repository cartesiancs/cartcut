import { describe, expect, it } from "vitest";
import type { GraphicElementType } from "../../@types/timeline";
import type { FxPreset } from "../fx/presetTypes";
import {
  bleedInBox,
  cssNumber,
  cssVariablesFor,
  isStaticHtml,
  layoutBoxOf,
  seedOf,
  textSlotsFor,
} from "./htmlContract";

function preset(over: Partial<FxPreset> = {}, sources: Record<string, string> = {}): FxPreset {
  return {
    schema: 1,
    id: "p",
    kind: "graphic",
    name: "P",
    category: "layout",
    thumbnailPath: null,
    render: { type: "html", source: "index.html", styles: ["style.css"] },
    params: [
      { key: "title", label: "T", type: "text", default: "Hello", maxLength: 3 },
      { key: "size", label: "S", type: "number", default: 40, min: 10, max: 100, uniform: "size" },
      { key: "on", label: "O", type: "bool", default: true, uniform: "on" },
      { key: "tint", label: "C", type: "color", default: "#ff8800", uniform: "tint" },
      { key: "at", label: "A", type: "point", default: [0.5, 0.25], min: 0, max: 1, uniform: "at" },
      { key: "face", label: "F", type: "font", default: "default" },
      { key: "photo", label: "P", type: "image", default: "" },
    ],
    origin: "inline",
    sources: { "index.html": "<h1 data-param=\"title\"></h1>", "style.css": "h1{}", ...sources },
    assets: {},
    ...over,
  };
}

const RESOLVERS = {
  fontFamilyOf: (value: string) => `"${value}", sans-serif`,
  imageUrlOf: (path: string) => "file://" + path,
};

const TIME = { tMs: 1500, durMs: 4000, progress: 0.375, localMs: 1500 };

describe("cssVariablesFor", () => {
  it("writes the host's clock and box and every non-text parameter", () => {
    const vars = cssVariablesFor(
      preset(),
      { size: 500, tint: "00ff00", at: [2, -1], photo: "/a/b.png" },
      TIME,
      { width: 640, height: 360 },
      RESOLVERS,
    );
    expect(vars).toEqual({
      "--t": "1.5",
      "--progress": "0.375",
      "--dur": "4",
      "--w": "640px",
      "--h": "360px",
      "--seed": "0",
      "--size": "100",
      "--on": "1",
      "--tint": "#00ff00",
      "--at-x": "1",
      "--at-y": "0",
      "--face": '"default", sans-serif',
      "--photo": 'url("file:///a/b.png")',
    });
  });

  it("writes numbers the same way everywhere", () => {
    expect(cssNumber(1 / 3)).toBe("0.333333");
    expect(cssNumber(-0)).toBe("0");
    expect(cssNumber(Number.NaN)).toBe("0");
  });
});

describe("textSlotsFor and seedOf", () => {
  it("cuts text to the declared length and falls back to the default", () => {
    expect(textSlotsFor(preset(), { title: "Longer" })).toEqual({ title: "Lon" });
    expect(textSlotsFor(preset(), {})).toEqual({ title: "Hel" });
  });

  it("reads a numeric seed and ignores anything else", () => {
    expect(seedOf({ seed: 3.6 })).toBe(4);
    expect(seedOf({ seed: "x" })).toBe(0);
  });
});

describe("isStaticHtml", () => {
  const element = { animation: {} } as unknown as GraphicElementType;
  it("is static with no animation, no clock and no keyed parameter", () => {
    expect(isStaticHtml(preset(), element)).toBe(true);
  });
  it("is not when CSS animates, reads the clock, or SMIL runs", () => {
    expect(isStaticHtml(preset({}, { "style.css": "@keyframes a{} h1{animation:a 1s}" }), element)).toBe(false);
    expect(isStaticHtml(preset({}, { "style.css": "h1{opacity:calc(var(--t) * 2)}" }), element)).toBe(false);
    expect(isStaticHtml(preset({}, { "index.html": '<svg><animate attributeName="x"/></svg>' }), element)).toBe(false);
  });
  it("is not when a parameter is keyframed", () => {
    const keyed = { animation: { "fx:size": { isActivate: true } } } as unknown as GraphicElementType;
    expect(isStaticHtml(preset(), keyed)).toBe(false);
  });
});

describe("layoutBoxOf and bleedInBox", () => {
  it("lays out at the box for reflow and at the design size for scale", () => {
    expect(layoutBoxOf(preset(), { width: 300, height: 100 })).toEqual({ width: 300, height: 100 });
    const scaled = preset({
      render: { type: "html", source: "index.html", layout: "scale", designSize: { width: 600, height: 200 }, bleed: 20 },
    });
    expect(layoutBoxOf(scaled, { width: 300, height: 100 })).toEqual({ width: 600, height: 200 });
    // 20 layout px at half scale is 10 box px.
    expect(bleedInBox(scaled, { width: 300, height: 100 })).toBe(10);
  });
});
