import { describe, expect, it } from "vitest";

import { LutParseError, nodeOffset } from "./lutData";
import { parse3dl } from "./lut3dl";

function node(
  lut: { size: number; data: Float32Array },
  r: number,
  g: number,
  b: number,
): number[] {
  const at = nodeOffset(lut.size, r, g, b);
  return [lut.data[at], lut.data[at + 1], lut.data[at + 2]];
}

function expectNode(actual: number[], expected: number[]): void {
  for (let i = 0; i < 3; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], 5);
  }
}

/**
 * A 2³ table whose eight rows are all distinct, written in `.3dl` order.
 *
 * Values are 0 or 1023 so that the output depth is unambiguously 10-bit — see
 * the depth tests below, which are the ones that exercise the guess.
 */
const ORDERED_2 = `0 1023
0 0 0
0 0 1023
0 1023 0
0 1023 1023
1023 0 0
1023 0 1023
1023 1023 0
1023 1023 1023
`;

/** The same eight rows at a dimmer level, for pinning the depth guess. */
const DIM_2 = ORDERED_2.replace(/1023 1023 1023\n$/, "100 100 100\n")
  .split("\n")
  .map((line, i) => (i === 0 ? line : line.replace(/1023/g, "100")))
  .join("\n");

describe("parse3dl — entry order", () => {
  // The trap. `.3dl` is blue-fastest and `.cube` is red-fastest, and reading
  // one as the other produces a plausible, wrong grade rather than a visible
  // failure. This assertion is written against the hand-authored rows above,
  // not against anything the parser produces.
  it("reads rows with blue varying fastest — the opposite of .cube", () => {
    const lut = parse3dl(ORDERED_2);
    expect(lut.size).toBe(2);
    const unit = 1;
    // Row 2 is the first change, and it is in blue.
    expectNode(node(lut, 0, 0, 1), [0, 0, unit]);
    // Row 3 is the first change in green.
    expectNode(node(lut, 0, 1, 0), [0, unit, 0]);
    // Row 5 is the first change in red.
    expectNode(node(lut, 1, 0, 0), [unit, 0, 0]);
    expectNode(node(lut, 1, 1, 1), [unit, unit, unit]);
  });
});

describe("parse3dl — size and depth", () => {
  it("takes the size from the mesh line's entry count", () => {
    const mesh = Array.from({ length: 3 }, (_, i) => i * 511).join(" ");
    const rows = Array.from({ length: 27 }, () => "0 0 0").join("\n");
    expect(parse3dl(`${mesh}\n${rows}\n`).size).toBe(3);
  });

  it("falls back to the cube root of the row count when there is no mesh", () => {
    const rows = Array.from({ length: 8 }, () => "0 0 0").join("\n");
    expect(parse3dl(rows).size).toBe(2);
  });

  it.each([
    [255, 8],
    [1023, 10],
    [4095, 12],
    [16383, 14],
    [65535, 16],
  ])("infers %i as full scale at %i bits", (max) => {
    const text = ORDERED_2.replace(/1023/g, String(max));
    expectNode(node(parse3dl(text), 1, 1, 1), [1, 1, 1]);
  });

  // The guess reads the *data*, not the mesh: Lustre's input and output depths
  // are allowed to differ, so a 10-bit mesh says nothing about the outputs.
  // The cost is that a table whose brightest output sits below the next
  // depth's ceiling reads one depth too low — which is why `Mesh` wins when it
  // is present, and why the shipped presets are `.cube`.
  it("takes the depth from the data maximum, not the mesh maximum", () => {
    expectNode(node(parse3dl(DIM_2), 1, 1, 1), [100 / 255, 100 / 255, 100 / 255]);
  });

  it("believes a Mesh header over the guess", () => {
    const text = `3DMESH\nMesh 1 12\n${DIM_2}`;
    expectNode(node(parse3dl(text), 1, 1, 1), [100 / 4095, 100 / 4095, 100 / 4095]);
  });
});

describe("parse3dl — how files are actually written", () => {
  it("survives CRLF, a BOM and blank lines", () => {
    const text = `﻿\r\n${ORDERED_2.replace(/\n/g, "\r\n")}\r\n`;
    expect(parse3dl(text).size).toBe(2);
  });

  it("ignores # comments and free-form Lustre header lines", () => {
    const text = `# Created by something\nSomething not a number\n${ORDERED_2}`;
    expect(parse3dl(text).size).toBe(2);
  });

  it("accepts the 3DMESH header", () => {
    expect(parse3dl(`3DMESH\n${ORDERED_2}`).size).toBe(2);
  });
});

describe("parse3dl — refusals", () => {
  it("refuses an unevenly spaced mesh rather than grading it wrongly", () => {
    // Lustre permits a shaper; `LutData` has no pre-LUT to carry one, and
    // pretending it is uniform would distort the result invisibly.
    const mesh = "0 100 1023";
    const rows = Array.from({ length: 27 }, () => "0 0 0").join("\n");
    expect(() => parse3dl(`${mesh}\n${rows}\n`)).toThrow(/unevenly spaced/);
  });

  it("refuses a row count that is not a whole cube", () => {
    const rows = Array.from({ length: 7 }, () => "0 0 0").join("\n");
    expect(() => parse3dl(rows)).toThrow(/not a whole cube/);
  });

  it("refuses a row count that disagrees with the mesh", () => {
    const rows = Array.from({ length: 7 }, () => "0 0 0").join("\n");
    expect(() => parse3dl(`0 1023\n${rows}\n`)).toThrow(/needs 8 rows/);
  });

  it("refuses an empty file", () => {
    expect(() => parse3dl("# nothing here\n")).toThrow(LutParseError);
  });

  it("names the offending line for a bad row", () => {
    expect(() => parse3dl("0 1023\n0 0 0\n0 0 nope\n")).toThrow(/line 3:/);
  });
});
