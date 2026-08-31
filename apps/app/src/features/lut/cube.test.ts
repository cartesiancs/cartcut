import { describe, expect, it } from "vitest";

import { formatCube, parseCube } from "./cube";
import {
  LutParseError,
  type Lut1d,
  type Lut3d,
  identityLut3d,
  nodeOffset,
} from "./lutData";

function cube(text: string): Lut3d {
  const lut = parseCube(text);
  if (lut.kind !== "3d") {
    throw new Error("expected a 3D LUT");
  }
  return lut;
}

function oneD(text: string): Lut1d {
  const lut = parseCube(text);
  if (lut.kind !== "1d") {
    throw new Error("expected a 1D LUT");
  }
  return lut;
}

function node(lut: Lut3d, r: number, g: number, b: number): number[] {
  const at = nodeOffset(lut.size, r, g, b);
  return [lut.data[at], lut.data[at + 1], lut.data[at + 2]];
}

/**
 * `data` is a `Float32Array`, so `0.1` comes back as `0.10000000149011612`.
 * Every node assertion therefore compares to single-precision tolerance rather
 * than exactly — the exception being the round-trip tests, which compare two
 * `Float32Array`s to each other and can be exact.
 */
function expectNode(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(3);
  for (let i = 0; i < 3; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], 6);
  }
}

/**
 * A 2³ cube whose eight rows are all distinguishable from one another.
 *
 * Written out by hand, in file order, so that the ordering assertion below is
 * an independent statement about the format rather than a restatement of what
 * the parser happens to do.
 */
const ORDERED_2 = `LUT_3D_SIZE 2
0.00 0.00 0.00
0.10 0.00 0.00
0.00 0.10 0.00
0.10 0.10 0.00
0.00 0.00 0.10
0.10 0.00 0.10
0.00 0.10 0.10
0.10 0.10 0.10
`;

describe("parseCube — entry order", () => {
  // The single most consequential fact about the format. Reversed, every LUT
  // still renders a picture; it is simply the wrong picture, and nothing about
  // it looks like a bug.
  it("reads rows with red varying fastest", () => {
    const lut = cube(ORDERED_2);
    expect(lut.size).toBe(2);
    // Row 2 differs from row 1 in red only.
    expectNode(node(lut, 1, 0, 0), [0.1, 0, 0]);
    // Row 3 is the first change in green.
    expectNode(node(lut, 0, 1, 0), [0, 0.1, 0]);
    // Row 5 is the first change in blue.
    expectNode(node(lut, 0, 0, 1), [0, 0, 0.1]);
    // And the last row is the far corner.
    expectNode(node(lut, 1, 1, 1), [0.1, 0.1, 0.1]);
  });

  it("round-trips a 3³ identity through the writer", () => {
    const original = identityLut3d(3);
    const reread = cube(formatCube(original));
    expect(reread.size).toBe(3);
    expect(Array.from(reread.data)).toEqual(Array.from(original.data));
  });
});

describe("parseCube — the header", () => {
  it("reads a quoted TITLE", () => {
    expect(cube(`TITLE "Kodak 2383"\n${ORDERED_2}`).title).toBe("Kodak 2383");
  });

  it("reads a bare TITLE", () => {
    expect(cube(`TITLE Kodak 2383\n${ORDERED_2}`).title).toBe("Kodak 2383");
  });

  it("keeps a # inside a quoted TITLE rather than treating it as a comment", () => {
    expect(cube(`TITLE "Print #4"\n${ORDERED_2}`).title).toBe("Print #4");
  });

  it("treats an empty TITLE as absent", () => {
    expect(cube(`TITLE\n${ORDERED_2}`).title).toBeUndefined();
  });

  it("reads DOMAIN_MIN and DOMAIN_MAX", () => {
    const lut = cube(
      `DOMAIN_MIN 0 0 0\nDOMAIN_MAX 4 4 4\n${ORDERED_2}`,
    );
    expect(lut.domainMin).toEqual([0, 0, 0]);
    expect(lut.domainMax).toEqual([4, 4, 4]);
  });

  it("defaults the domain to 0..1 when the file does not say", () => {
    const lut = cube(ORDERED_2);
    expect(lut.domainMin).toEqual([0, 0, 0]);
    expect(lut.domainMax).toEqual([1, 1, 1]);
  });

  // The IRIDAS spelling. Same meaning, one pair for all three channels.
  it("accepts the legacy LUT_3D_INPUT_RANGE", () => {
    const lut = cube(`LUT_3D_INPUT_RANGE -0.5 2.5\n${ORDERED_2}`);
    expect(lut.domainMin).toEqual([-0.5, -0.5, -0.5]);
    expect(lut.domainMax).toEqual([2.5, 2.5, 2.5]);
  });

  it("accepts lower-case keywords", () => {
    expect(cube(ORDERED_2.replace("LUT_3D_SIZE", "lut_3d_size")).size).toBe(2);
  });
});

describe("parseCube — how files are actually written", () => {
  it("survives CRLF", () => {
    expect(cube(ORDERED_2.replace(/\n/g, "\r\n")).size).toBe(2);
  });

  it("survives a lone CR", () => {
    expect(cube(ORDERED_2.replace(/\n/g, "\r")).size).toBe(2);
  });

  it("survives a UTF-8 BOM", () => {
    expect(cube(`﻿${ORDERED_2}`).size).toBe(2);
  });

  it("survives tabs and runs of spaces", () => {
    const text = ORDERED_2.replace(/ /g, "\t \t");
    expectNode(node(cube(text), 1, 1, 1), [0.1, 0.1, 0.1]);
  });

  it("survives commas between values", () => {
    const text = ORDERED_2.replace(/(\d) (\d)/g, "$1, $2");
    expectNode(node(cube(text), 1, 1, 1), [0.1, 0.1, 0.1]);
  });

  it("ignores blank lines and whole-line comments", () => {
    const text = `# made by something\n\nLUT_3D_SIZE 2\n\n# data follows\n${ORDERED_2.split("\n").slice(1).join("\n")}`;
    expect(cube(text).size).toBe(2);
  });

  it("ignores a comment trailing a data row", () => {
    const text = ORDERED_2.replace("0.10 0.10 0.10", "0.10 0.10 0.10 # last");
    expectNode(node(cube(text), 1, 1, 1), [0.1, 0.1, 0.1]);
  });

  it("reads scientific notation and a leading plus", () => {
    const text = ORDERED_2.replace("0.10 0.00 0.00", "+1e-1 0.0 0.");
    expectNode(node(cube(text), 1, 0, 0), [0.1, 0, 0]);
  });

  // Not permitted by the spec, and present in files anyway.
  it("accepts the size directive after the data", () => {
    const rows = ORDERED_2.split("\n").slice(1).join("\n");
    expect(cube(`${rows}\nLUT_3D_SIZE 2\n`).size).toBe(2);
  });

  it("tolerates trailing whitespace and a trailing blank line", () => {
    expect(cube(`${ORDERED_2.replace(/\n/g, "   \n")}\n\n`).size).toBe(2);
  });

  // Legal, and clamping here would silently rewrite what the author meant.
  it("keeps values outside 0..1", () => {
    const text = ORDERED_2.replace("0.10 0.10 0.10", "1.85 -0.02 0.10");
    const [r, g, b] = node(cube(text), 1, 1, 1);
    expect(r).toBeCloseTo(1.85, 6);
    expect(g).toBeCloseTo(-0.02, 6);
    expect(b).toBeCloseTo(0.1, 6);
  });
});

describe("parseCube — 1D", () => {
  const ONE_D = `LUT_1D_SIZE 3
0.0 0.0 0.0
0.25 0.5 0.75
1.0 1.0 1.0
`;

  it("reads a 1D LUT and keeps it 1D", () => {
    const lut = oneD(ONE_D);
    expect(lut.size).toBe(3);
    expectNode(Array.from(lut.data.slice(3, 6)), [0.25, 0.5, 0.75]);
  });

  it("round-trips through the writer", () => {
    const again = oneD(formatCube(oneD(ONE_D)));
    expect(Array.from(again.data)).toEqual(Array.from(oneD(ONE_D).data));
  });
});

describe("parseCube — refusals", () => {
  const cases: Array<[string, string, RegExp]> = [
    [
      "no size directive",
      "0.0 0.0 0.0\n1.0 1.0 1.0\n",
      /does not look like a \.cube/,
    ],
    ["size but no data", "LUT_3D_SIZE 2\n", /holds no data/],
    ["too few rows", "LUT_3D_SIZE 2\n0 0 0\n", /needs 2³ = 8 rows/],
    [
      "too many rows",
      `${ORDERED_2}0.5 0.5 0.5\n`,
      /needs 2³ = 8 rows, but the file holds 9/,
    ],
    ["a two-number row", "LUT_3D_SIZE 2\n0 0\n", /exactly three numbers/],
    ["a four-number row", "LUT_3D_SIZE 2\n0 0 0 0\n", /exactly three numbers/],
    ["a non-numeric row", "LUT_3D_SIZE 2\nnope nope nope\n", /or a LUT keyword/],
    ["a fractional size", "LUT_3D_SIZE 2.5\n", /whole number/],
    ["a size of 1", "LUT_3D_SIZE 1\n0 0 0\n", /from 2 to 128/],
    ["a size beyond the cap", "LUT_3D_SIZE 200\n", /from 2 to 128/],
    ["two size directives", `${ORDERED_2}LUT_3D_SIZE 2\n`, /size twice/],
    [
      "both 1D and 3D sizes",
      "LUT_3D_SIZE 2\nLUT_1D_SIZE 2\n",
      /size twice/,
    ],
    ["a two-value DOMAIN_MIN", "DOMAIN_MIN 0 0\nLUT_3D_SIZE 2\n", /three numbers/],
  ];

  for (const [name, text, message] of cases) {
    it(`refuses ${name}`, () => {
      expect(() => parseCube(text)).toThrow(LutParseError);
      expect(() => parseCube(text)).toThrow(message);
    });
  }

  // The whole point of carrying a line number: an import failure has to tell
  // the user where to look in a file they did not write.
  it("names the offending line", () => {
    expect(() => parseCube("LUT_3D_SIZE 2\n0 0 0\nbroken\n")).toThrow(/line 3:/);
  });
});
