/**
 * The `.3dl` reader — Autodesk Lustre / Flame.
 *
 * ## The trap
 *
 * **`.3dl` orders its rows blue-fastest; `.cube` orders them red-fastest.**
 * The two formats are otherwise so similar that it is natural to assume they
 * agree, and they do not. Getting it backwards does not produce a broken
 * picture — it produces a *plausible* one, a grade that is wrong in a way no
 * reviewer would spot without the original to compare against. That is the
 * single most important line in this file, it is pinned by a hand-built 2³
 * table in `lut3dl.test.ts`, and it is why the transpose happens here rather
 * than being left to whoever reads `LutData` next.
 *
 * ## The shape of the file
 *
 * An optional Flame-style header (`3DMESH`, `Mesh <in> <out>`), then a **mesh
 * line** — the input node positions, whose *count* is the LUT size and whose
 * largest value is the input bit depth — then `size³` rows of three integers.
 *
 * Neither bit depth is stated in a way that can be relied on, so both are
 * inferred: the input depth from the mesh line's top value, the output depth
 * from the largest value anywhere in the data, rounded up to the next of
 * 8/10/12/14/16 bits. That is the same guess every other implementation makes,
 * and it is only ever wrong for a LUT whose brightest output happens to sit
 * below the next depth's ceiling — a table with no value above 0.25 at 12 bits
 * would be read as 10-bit. `Mesh <in> <out>`, when present, is believed over
 * the guess.
 *
 * ## Non-uniform meshes
 *
 * Lustre permits a shaper: unevenly spaced input nodes. `LutData` has no
 * pre-LUT to carry one, and silently treating it as uniform would distort the
 * grade, so such a file is refused with a message telling the user to convert
 * it to `.cube`. Refusing loudly beats grading wrongly.
 */

import {
  DEFAULT_DOMAIN_MAX,
  DEFAULT_DOMAIN_MIN,
  type Lut3d,
  LutParseError,
  assertSize3d,
  entryCountOf,
  nodeOffset,
} from "./lutData";

export const MAX_3DL_CHARS = 96 * 1024 * 1024;

/** Depths a `.3dl` is written at, smallest first. */
const DEPTHS = [8, 10, 12, 14, 16];

/** How far a mesh node may sit from its uniform position, as a fraction. */
const MESH_TOLERANCE = 0.02;

const SEPARATOR = /[\s,]+/;
const INTEGER = /^[+-]?\d+$/;

export function parse3dl(text: string): Lut3d {
  if (text.length > MAX_3DL_CHARS) {
    throw new LutParseError(
      `file is too large to be a LUT (${text.length} characters, limit ${MAX_3DL_CHARS})`,
    );
  }

  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r\n|\n|\r/);

  let mesh: number[] | null = null;
  let declaredOutputDepth: number | null = null;
  const rows: number[] = [];
  let firstRowLine = 0;
  /** The first data-shaped line arrived before any mesh, so it may be one. */
  let sawAmbiguousFirst = false;

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index]).trim();
    if (line === "") {
      continue;
    }

    const parts = line.split(SEPARATOR);
    const keyword = parts[0].toUpperCase();

    if (keyword === "3DMESH") {
      continue;
    }
    if (keyword === "MESH") {
      // `Mesh <input exponent> <output bit depth>`: the first is a power of
      // two giving the node count, the second is the output depth outright.
      const declared = Number.parseInt(parts[2] ?? "", 10);
      if (DEPTHS.includes(declared)) {
        declaredOutputDepth = declared;
      }
      continue;
    }
    if (!INTEGER.test(parts[0])) {
      // Lustre files carry free-form comment lines without a `#`.
      continue;
    }

    const numbers = parts.map((token) => {
      if (!INTEGER.test(token)) {
        throw new LutParseError(
          `expected whole numbers, got "${token.slice(0, 24)}"`,
          lineNumber,
        );
      }
      return Number.parseInt(token, 10);
    });

    // The first all-integer line is the mesh whenever it does not have exactly
    // three entries. With three it is genuinely ambiguous — a 3-node mesh and
    // a data row are the same shape — so the decision is deferred and settled
    // below by arithmetic rather than by guessing: only one of the two
    // readings can leave a whole cube of rows.
    if (mesh == null && !sawAmbiguousFirst && numbers.length !== 3) {
      mesh = numbers;
      continue;
    }
    if (numbers.length !== 3) {
      throw new LutParseError(
        `a data row must hold exactly three numbers, got ${numbers.length}`,
        lineNumber,
      );
    }
    if (firstRowLine === 0) {
      firstRowLine = lineNumber;
      if (mesh == null) {
        sawAmbiguousFirst = true;
      }
    }
    rows.push(numbers[0], numbers[1], numbers[2]);
  }

  if (rows.length === 0) {
    throw new LutParseError("the file holds no LUT data");
  }

  // Settle the ambiguity. A 3-entry mesh means a 3³ LUT, so the file holds 28
  // all-integer rows: the mesh and 27 of data. Taking the first row as data
  // instead leaves 28, which is not a cube — so the two readings can never
  // both be valid, and this needs no heuristic.
  if (mesh == null && sawAmbiguousFirst && !isWholeCube(rows.length / 3)) {
    if (isWholeCube(rows.length / 3 - 1) && Math.cbrt(rows.length / 3 - 1) === 3) {
      mesh = [rows[0], rows[1], rows[2]];
      rows.splice(0, 3);
    }
  }

  const size = sizeOf(mesh, rows.length);
  assertSize3d(size);
  if (mesh != null) {
    assertUniform(mesh);
  }

  const expected = entryCountOf(size);
  if (rows.length !== expected) {
    throw new LutParseError(
      `a ${size}³ LUT needs ${expected / 3} rows, but the file holds ${
        rows.length / 3
      }`,
    );
  }

  const depth = declaredOutputDepth ?? inferOutputDepth(rows);
  const scale = 1 / ((1 << depth) - 1);

  // The transpose. Rows arrive blue-fastest; `LutData` stores red-fastest.
  const data = new Float32Array(expected);
  let at = 0;
  for (let r = 0; r < size; r++) {
    for (let g = 0; g < size; g++) {
      for (let b = 0; b < size; b++) {
        const to = nodeOffset(size, r, g, b);
        data[to] = rows[at] * scale;
        data[to + 1] = rows[at + 1] * scale;
        data[to + 2] = rows[at + 2] * scale;
        at += 3;
      }
    }
  }

  return {
    kind: "3d",
    size,
    data,
    domainMin: DEFAULT_DOMAIN_MIN,
    domainMax: DEFAULT_DOMAIN_MAX,
  };
}

/**
 * The node count.
 *
 * The mesh line states it directly. Without one, the cube root of the row
 * count is the only evidence there is — and it is good evidence, because a row
 * count that is not a perfect cube is not a 3D LUT at all.
 */
function isWholeCube(rows: number): boolean {
  if (!Number.isInteger(rows) || rows < 1) {
    return false;
  }
  const root = Math.round(Math.cbrt(rows));
  return root * root * root === rows;
}

function sizeOf(mesh: number[] | null, valueCount: number): number {
  if (mesh != null) {
    return mesh.length;
  }
  const rows = valueCount / 3;
  const root = Math.round(Math.cbrt(rows));
  if (root * root * root !== rows) {
    throw new LutParseError(
      `the file has no mesh line and its ${rows} rows are not a whole cube`,
    );
  }
  return root;
}

function assertUniform(mesh: number[]): void {
  const last = mesh.length - 1;
  const span = mesh[last] - mesh[0];
  if (span <= 0) {
    throw new LutParseError("the mesh line does not increase");
  }
  for (let i = 0; i <= last; i++) {
    const expected = mesh[0] + (span * i) / last;
    if (Math.abs(mesh[i] - expected) / span > MESH_TOLERANCE) {
      throw new LutParseError(
        "this .3dl uses an unevenly spaced input mesh, which Cartcut cannot " +
          "represent — re-export it as a .cube",
      );
    }
  }
}

function inferOutputDepth(rows: number[]): number {
  let max = 0;
  for (const value of rows) {
    if (value > max) {
      max = value;
    }
  }
  for (const depth of DEPTHS) {
    if (max <= (1 << depth) - 1) {
      return depth;
    }
  }
  throw new LutParseError(
    `output values reach ${max}, which is beyond the 16-bit range .3dl allows`,
  );
}

function stripComment(line: string): string {
  const at = line.indexOf("#");
  return at === -1 ? line : line.slice(0, at);
}
