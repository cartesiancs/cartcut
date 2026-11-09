import { describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { insetOnly, parseComputedShadows, roundedRectPath, shadowFilter } from "./snapshotShadows";

describe("parseComputedShadows", () => {
  it("reads what each engine's computed style writes", () => {
    // Blink and Gecko put the colour first; WebKit writes `color(srgb ...)` for color-mix.
    expect(parseComputedShadows("rgb(255, 0, 0) 0px 30px 0px, rgb(0, 255, 0) 0px -30px 2px")).toEqual([
      { color: "rgb(255, 0, 0)", x: 0, y: 30, blur: 0, spread: 0, inset: false },
      { color: "rgb(0, 255, 0)", x: 0, y: -30, blur: 2, spread: 0, inset: false },
    ]);
    expect(parseComputedShadows("color(srgb 1 0.333333 0 / 0.9896) 1.414214px 1.414214px 0px")[0]).toEqual({
      color: "color(srgb 1 0.333333 0 / 0.9896)",
      x: 1.414214,
      y: 1.414214,
      blur: 0,
      spread: 0,
      inset: false,
    });
    expect(parseComputedShadows("rgb(0, 255, 0) 0px 0px 0px 4px inset")[0]).toMatchObject({ spread: 4, inset: true });
  });

  it("answers nothing for none or anything unreadable", () => {
    expect(parseComputedShadows("none")).toEqual([]);
    expect(parseComputedShadows("red")).toEqual([]);
  });

  it("writes the inset layers back alone", () => {
    const layers = parseComputedShadows("rgb(1, 2, 3) 0px 4px 0px 0px, rgb(0, 255, 0) 0px 0px 0px 4px inset");
    expect(insetOnly(layers)).toBe("inset 0px 0px 0px 4px rgb(0, 255, 0)");
    expect(insetOnly(layers.slice(0, 1))).toBe("none");
  });
});

describe("roundedRectPath", () => {
  it("draws a plain rectangle with no radii", () => {
    expect(roundedRectPath({ width: 40, height: 20, radii: [[0, 0], [0, 0], [0, 0], [0, 0]] })).toBe(
      "M0 0H40V20H0V0Z",
    );
  });

  it("grows the box and its radii with a spread, never past half a side", () => {
    const path = roundedRectPath({ width: 40, height: 20, radii: [[30, 30], [0, 0], [0, 0], [0, 0]] }, 4);
    expect(path.startsWith("M-4 -4") || path.includes("A")).toBe(true);
    expect(path).toContain("A24 14 0 0 1");
  });
});

function wellFormed(markup: string): string[] {
  const errors: string[] = [];
  new DOMParser({
    errorHandler: { warning: () => undefined, error: (m: string) => errors.push(m), fatalError: (m: string) => errors.push(m) },
  }).parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${markup}</svg>`,
    "image/svg+xml",
  );
  return errors;
}

describe("shadowFilter", () => {
  const layers = parseComputedShadows("rgb(255, 0, 0) 0px 30px 6px 4px, rgb(0, 200, 0) 0px -30px 0px 0px");
  const box = { width: 40, height: 20, radii: [[8, 8], [8, 8], [8, 8], [8, 8]] } as const;

  it("is well-formed SVG for both kinds", () => {
    expect(wellFormed(shadowFilter("a", "text", layers)!)).toEqual([]);
    expect(wellFormed(shadowFilter("b", "box", layers, box as any)!)).toEqual([]);
  });

  it("writes a box filter in bounding-box units, a length as a fraction of its side", () => {
    const filter = shadowFilter("b", "box", layers, box as any)!;
    expect(filter).toContain('primitiveUnits="objectBoundingBox"');
    // 30px down on a 20px-tall box.
    expect(filter).toContain('dy="1.5"');
  });

  it("merges the last layer first and the element on top, as CSS paints them", () => {
    const filter = shadowFilter("a", "text", layers)!;
    const merge = filter.slice(filter.lastIndexOf("<feMerge>"));
    expect(merge.indexOf('in="s1"')).toBeLessThan(merge.indexOf('in="s0"'));
    expect(merge.indexOf('in="s0"')).toBeLessThan(merge.indexOf("SourceGraphic"));
  });

  it("leaves inset box shadows to CSS, and answers null when nothing is left", () => {
    const inset = parseComputedShadows("rgb(0, 255, 0) 0px 0px 0px 4px inset");
    expect(shadowFilter("c", "box", inset, box as any)).toBeNull();
    expect(shadowFilter("d", "box", layers, { width: 0, height: 20, radii: box.radii as any })).toBeNull();
  });
});
