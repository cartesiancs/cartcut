import { describe, expect, it } from "vitest";

import {
  describeLutError,
  extensionOf,
  isImageLutFilename,
  isLutFilename,
  parseLut,
  parseLutText,
  sniffLutFormat,
} from "./parse";
import { LutParseError, nodeOffset } from "./lutData";

const CUBE = `LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

/** The same identity cube written the `.3dl` way: blue fastest, 10-bit. */
const THREE_DL = `0 1023
0 0 0
0 0 1023
0 1023 0
0 1023 1023
1023 0 0
1023 0 1023
1023 1023 0
1023 1023 1023
`;

describe("extensionOf / isLutFilename", () => {
  it("lower-cases and drops the dot", () => {
    expect(extensionOf("Kodak.CUBE")).toBe("cube");
    expect(extensionOf("no-extension")).toBe("");
  });

  it("accepts the three formats and nothing else", () => {
    expect(isLutFilename("a.cube")).toBe(true);
    expect(isLutFilename("a.3dl")).toBe(true);
    expect(isLutFilename("a.png")).toBe(true);
    expect(isLutFilename("a.mp4")).toBe(false);
    // JPEG would be a LUT that has been through lossy compression, which is
    // not a LUT any more.
    expect(isLutFilename("a.jpg")).toBe(false);
  });

  it("knows which need decoding first", () => {
    expect(isImageLutFilename("a.png")).toBe(true);
    expect(isImageLutFilename("a.cube")).toBe(false);
  });
});

describe("sniffLutFormat", () => {
  it("recognises a .cube by its size keyword", () => {
    expect(sniffLutFormat(CUBE)).toBe("cube");
    expect(sniffLutFormat("LUT_1D_SIZE 4\n")).toBe("cube");
  });

  it("recognises a .3dl by its mesh line", () => {
    expect(sniffLutFormat(THREE_DL)).toBe("3dl");
  });

  it("recognises a .3dl by its header", () => {
    expect(sniffLutFormat("3DMESH\n0 0 0\n")).toBe("3dl");
  });

  it("falls back to cube for something that is not a LUT", () => {
    expect(sniffLutFormat("hello\n")).toBe("cube");
  });
});

describe("parseLutText — the extension is a hint, not the answer", () => {
  it("reads a .cube named .3dl as a .cube", () => {
    // LUTs get renamed constantly. Content that names its own format wins.
    const lut = parseLutText(CUBE, "renamed.3dl");
    expect(lut.kind).toBe("3d");
    expect(lut.size).toBe(2);
    // Red-fastest ordering, so row 2 is the red corner.
    const at = nodeOffset(2, 1, 0, 0);
    expect(lut.data[at]).toBe(1);
    expect(lut.data[at + 1]).toBe(0);
  });

  it("reads a .3dl named .cube as a .3dl", () => {
    const lut = parseLutText(THREE_DL, "renamed.cube");
    expect(lut.size).toBe(2);
    // Blue-fastest ordering, so row 2 is the blue corner.
    const at = nodeOffset(2, 0, 0, 1);
    expect(lut.data[at + 2]).toBe(1);
    expect(lut.data[at]).toBe(0);
  });

  it("reads a .cube with no extension at all", () => {
    expect(parseLutText(CUBE).size).toBe(2);
  });

  it("reads a .txt that is really a .cube", () => {
    expect(parseLutText(CUBE, "grade.txt").size).toBe(2);
  });

  // The error a user is shown has to point at the format the file looked like.
  // Reporting the .3dl reader's complaint about a broken .cube would send them
  // hunting for a mesh line their file was never supposed to have.
  it("reports the failure of the format the file looked most like", () => {
    const broken = "LUT_3D_SIZE 2\n0 0 0\n";
    expect(() => parseLutText(broken, "a.cube")).toThrow(/needs 2³ = 8 rows/);
  });

  it("refuses a file that is not a LUT in any format", () => {
    expect(() => parseLutText("this is a text file\n", "a.cube")).toThrow(
      LutParseError,
    );
  });
});

describe("parseLut", () => {
  it("dispatches text", () => {
    expect(parseLut({ kind: "text", text: CUBE, filename: "a.cube" }).size).toBe(2);
  });

  it("dispatches images", () => {
    const size = 16;
    const width = 64;
    const data = new Uint8ClampedArray(width * width * 4);
    for (let i = 0; i < size * size * size; i++) {
      const r = i % size;
      const g = Math.floor(i / size) % size;
      const b = Math.floor(i / (size * size));
      data[i * 4] = Math.round((r / (size - 1)) * 255);
      data[i * 4 + 1] = Math.round((g / (size - 1)) * 255);
      data[i * 4 + 2] = Math.round((b / (size - 1)) * 255);
      data[i * 4 + 3] = 255;
    }
    const lut = parseLut({ kind: "image", image: { width, height: width, data } });
    expect(lut.size).toBe(16);
  });
});

describe("describeLutError", () => {
  it("keeps the line number a parse error carries", () => {
    expect(describeLutError(new LutParseError("bad", 7))).toBe("line 7: bad");
  });

  it("survives being handed something that is not an Error", () => {
    expect(describeLutError("boom")).toBe("boom");
  });
});
