import { describe, expect, it } from "vitest";
import {
  base64Of,
  embedPlan,
  familyNames,
  fontKind,
  harvestCodepoints,
  parseFontSrc,
  parseUnicodeRange,
  rangeHits,
  sfntTables,
  WHOLE_FACE_MAX_BYTES,
} from "./fontPlan";

function sfnt(version: number, tags: string[], size: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 12 + tags.length * 16));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, version);
  view.setUint16(4, tags.length);
  tags.forEach((tag, i) => {
    for (let k = 0; k < 4; k++) bytes[12 + i * 16 + k] = tag.charCodeAt(k);
  });
  return bytes;
}

describe("familyNames", () => {
  it("unquotes, lowercases and drops generic families", () => {
    expect(familyNames(`"Anton", notosanskr, 'Noto Sans KR', sans-serif`)).toEqual([
      "anton",
      "notosanskr",
      "noto sans kr",
    ]);
    expect(familyNames("system-ui, -apple-system")).toEqual([]);
  });
});

describe("unicode-range", () => {
  it("reads single points, ranges and wildcards", () => {
    expect(parseUnicodeRange("U+0025-00FF, u+4??, U+20AC")).toEqual([
      [0x25, 0xff],
      [0x400, 0x4ff],
      [0x20ac, 0x20ac],
    ]);
  });

  it("hits when any code point falls in a range, and always with no range", () => {
    const ranges = parseUnicodeRange("U+AC00-D7A3");
    expect(rangeHits(ranges, [0x41])).toBe(false);
    expect(rangeHits(ranges, [0x41, 0xd55c])).toBe(true);
    expect(rangeHits([], [0x41])).toBe(true);
  });
});

describe("parseFontSrc", () => {
  it("reads url and local sources with their formats", () => {
    expect(
      parseFontSrc(`local("Anton Regular"), url("../a.woff2") format("woff2"), url(b.otf)`),
    ).toEqual([
      { local: "Anton Regular" },
      { url: "../a.woff2", format: "woff2" },
      { url: "b.otf", format: null },
    ]);
  });
});

describe("harvestCodepoints", () => {
  it("adds both cases in the graphic's language, and what layout adds by itself", () => {
    const cps = harvestCodepoints(["Hi i"], "tr");
    const has = (ch: string) => cps.includes(ch.codePointAt(0)!);
    expect(has("H") && has("h") && has("i")).toBe(true);
    // Turkish uppercases i to dotted capital I.
    expect(has("İ")).toBe(true);
    expect(has("…") && has("0") && has("9") && has(" ")).toBe(true);
  });

  it("is sorted and unique, so equal sets give equal keys", () => {
    expect(harvestCodepoints(["ba"], "")).toEqual(harvestCodepoints(["ab", "a"], ""));
  });
});

describe("embedPlan", () => {
  it("carries small faces and anything not an sfnt whole", () => {
    expect(embedPlan(sfnt(0x00010000, ["glyf"], 1000))).toEqual({ kind: "whole" });
    const woff2 = new Uint8Array(WHOLE_FACE_MAX_BYTES * 4);
    woff2.set([0x77, 0x4f, 0x46, 0x32]);
    expect(embedPlan(woff2)).toEqual({ kind: "whole" });
  });

  it("subsets a large face, keeping glyph ids when a table HarfBuzz passes through names them", () => {
    expect(embedPlan(sfnt(0x4f54544f, ["CFF ", "GPOS"], WHOLE_FACE_MAX_BYTES + 1))).toEqual({
      kind: "subset",
      retainGids: false,
    });
    expect(embedPlan(sfnt(0x00010000, ["glyf", "kern"], WHOLE_FACE_MAX_BYTES + 1))).toEqual({
      kind: "subset",
      retainGids: true,
    });
  });

  it("reads the table directory", () => {
    expect(sfntTables(sfnt(0x00010000, ["cmap", "glyf"], 0))).toEqual(["cmap", "glyf"]);
    expect(sfntTables(new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});

describe("fontKind and base64Of", () => {
  it("names the format by its signature", () => {
    expect(fontKind(new Uint8Array([0x4f, 0x54, 0x54, 0x4f])).format).toBe("opentype");
    expect(fontKind(new Uint8Array([0, 1, 0, 0])).mime).toBe("font/ttf");
    expect(fontKind(new Uint8Array([0x77, 0x4f, 0x46, 0x32])).mime).toBe("font/woff2");
  });

  it("encodes past the argument-stack limit", () => {
    const big = new Uint8Array(200_000).map((_, i) => i % 251);
    expect(Buffer.from(base64Of(big), "base64").equals(Buffer.from(big))).toBe(true);
  });
});
