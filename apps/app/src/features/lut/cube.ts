/**
 * The `.cube` reader.
 *
 * `.cube` — the Adobe/IRIDAS Cube LUT format — is what essentially every LUT
 * pack on earth ships in, so this file is where the promise "bring your own
 * LUT and it just works" is either kept or broken. It implements the published
 * specification rather than the subset a tidy file happens to use, because the
 * files that arrive are not tidy: they come out of Resolve, Premiere,
 * Lightroom, Photoshop, 3D LUT Creator, half a dozen free web converters and a
 * great many text editors on Windows.
 *
 * What that means concretely, and every item here is a case in `cube.test.ts`:
 *
 *  - `LUT_3D_SIZE` **and** `LUT_1D_SIZE`. A 1D LUT stays 1D — see
 *    `lutData.ts` for why widening it to a cube would lose precision.
 *  - `DOMAIN_MIN` / `DOMAIN_MAX`, and the legacy IRIDAS
 *    `LUT_{1D,3D}_INPUT_RANGE` spelling of the same idea.
 *  - `TITLE`, quoted or bare.
 *  - `#` comments on their own line or trailing a data line.
 *  - CRLF, lone CR, a UTF-8 BOM, tabs, runs of spaces, commas used as
 *    separators, leading `+`, and scientific notation.
 *  - Values outside 0-1, which are legal and are not clamped here.
 *  - The size directive appearing *after* the data, which the spec does not
 *    permit and which files in the wild nonetheless contain.
 *
 * Every failure is a `LutParseError` carrying the 1-based source line, because
 * the import toast has to be able to say *where* a stranger's file went wrong.
 * "Could not read this LUT" is not a bug report anyone can act on.
 */

import {
  DEFAULT_DOMAIN_MAX,
  DEFAULT_DOMAIN_MIN,
  type Lut1d,
  type Lut3d,
  type LutData,
  type LutTriple,
  LutParseError,
  assertSize1d,
  assertSize3d,
  entryCountOf,
} from "./lutData";

/**
 * Largest `.cube` text accepted, in characters.
 *
 * A 128³ cube written with generous precision is around 60 MB, and this is
 * comfortably above that. It exists so that a file that is not a LUT at all —
 * a mistakenly renamed video, say — is rejected instead of being tokenised.
 */
export const MAX_CUBE_CHARS = 96 * 1024 * 1024;

/** Splits on any run of whitespace or commas. */
const SEPARATOR = /[\s,]+/;

/** A float, as `.cube` may spell one. */
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function parseCube(text: string): LutData {
  if (text.length > MAX_CUBE_CHARS) {
    throw new LutParseError(
      `file is too large to be a LUT (${text.length} characters, limit ${MAX_CUBE_CHARS})`,
    );
  }

  // A BOM survives `readFile(…, "utf8")` and would otherwise make the first
  // keyword unrecognisable in a way that reads as "this file has no size".
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Lone CR is Classic-Mac line ending; it still turns up in files that have
  // been through an old converter.
  const lines = body.split(/\r\n|\n|\r/);

  let size3d: number | null = null;
  let size1d: number | null = null;
  let title: string | undefined;
  let domainMin: LutTriple = DEFAULT_DOMAIN_MIN;
  let domainMax: LutTriple = DEFAULT_DOMAIN_MAX;
  let sizeLine = 0;

  // Grown by doubling rather than sized up front, because the size directive
  // is allowed to arrive after the data.
  let values = new Float32Array(4096);
  let count = 0;
  const push = (v: number) => {
    if (count === values.length) {
      const grown = new Float32Array(values.length * 2);
      grown.set(values);
      values = grown;
    }
    values[count++] = v;
  };

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index]).trim();
    if (line === "") {
      continue;
    }

    const parts = line.split(SEPARATOR);
    const keyword = parts[0].toUpperCase();

    switch (keyword) {
      case "TITLE":
        title = readTitle(line);
        continue;

      case "LUT_3D_SIZE":
        if (size3d != null || size1d != null) {
          throw new LutParseError("the LUT declares its size twice", lineNumber);
        }
        size3d = readInt(parts[1], "LUT_3D_SIZE", lineNumber);
        assertSize3d(size3d, lineNumber);
        sizeLine = lineNumber;
        continue;

      case "LUT_1D_SIZE":
        if (size3d != null || size1d != null) {
          throw new LutParseError("the LUT declares its size twice", lineNumber);
        }
        size1d = readInt(parts[1], "LUT_1D_SIZE", lineNumber);
        assertSize1d(size1d, lineNumber);
        sizeLine = lineNumber;
        continue;

      case "DOMAIN_MIN":
        domainMin = readTriple(parts, "DOMAIN_MIN", lineNumber);
        continue;

      case "DOMAIN_MAX":
        domainMax = readTriple(parts, "DOMAIN_MAX", lineNumber);
        continue;

      // IRIDAS wrote the domain as a single pair applying to all three
      // channels. Same meaning, older spelling; files using it are still in
      // circulation and there is no reason to refuse them.
      case "LUT_1D_INPUT_RANGE":
      case "LUT_3D_INPUT_RANGE": {
        const lo = readFloat(parts[1], keyword, lineNumber);
        const hi = readFloat(parts[2], keyword, lineNumber);
        domainMin = [lo, lo, lo];
        domainMax = [hi, hi, hi];
        continue;
      }

      default:
        break;
    }

    // Not a keyword, so it must be a data row.
    if (!NUMBER.test(parts[0])) {
      throw new LutParseError(
        `expected three numbers or a LUT keyword, got "${truncate(parts[0])}"`,
        lineNumber,
      );
    }
    if (parts.length !== 3) {
      throw new LutParseError(
        `a data row must hold exactly three numbers, got ${parts.length}`,
        lineNumber,
      );
    }
    for (let c = 0; c < 3; c++) {
      push(readFloat(parts[c], "value", lineNumber));
    }
  }

  if (size3d == null && size1d == null) {
    throw new LutParseError(
      "no LUT_3D_SIZE or LUT_1D_SIZE — this does not look like a .cube file",
    );
  }
  if (count === 0) {
    throw new LutParseError("the LUT declares a size but holds no data", sizeLine);
  }

  if (size3d != null) {
    const expected = entryCountOf(size3d);
    assertCount(count, expected, size3d, "LUT_3D_SIZE", 3);
    return finish3d(size3d, values.slice(0, expected), title, domainMin, domainMax);
  }

  const size = size1d as number;
  const expected = size * 3;
  assertCount(count, expected, size, "LUT_1D_SIZE", 1);
  return finish1d(size, values.slice(0, expected), title, domainMin, domainMax);
}

function finish3d(
  size: number,
  data: Float32Array,
  title: string | undefined,
  domainMin: LutTriple,
  domainMax: LutTriple,
): Lut3d {
  return { kind: "3d", size, data, title, domainMin, domainMax };
}

function finish1d(
  size: number,
  data: Float32Array,
  title: string | undefined,
  domainMin: LutTriple,
  domainMax: LutTriple,
): Lut1d {
  return { kind: "1d", size, data, title, domainMin, domainMax };
}

function assertCount(
  got: number,
  expected: number,
  size: number,
  keyword: string,
  dimensions: number,
): void {
  if (got === expected) {
    return;
  }
  const rows = dimensions === 3 ? `${size}³` : `${size}`;
  throw new LutParseError(
    `${keyword} ${size} needs ${rows} = ${expected / 3} rows, but the file holds ${
      got / 3
    }`,
  );
}

/**
 * Remove a trailing comment.
 *
 * `#` starts a comment anywhere on a line except inside a quoted `TITLE` — the
 * spec only blesses whole-line comments, but trailing ones are common and
 * treating them as data would fail the file for no reason. A `#` inside quotes
 * is left alone so `TITLE "Kodak #4"` survives.
 */
function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "#" && !quoted) {
      return line.slice(0, i);
    }
  }
  return line;
}

function readTitle(line: string): string | undefined {
  const rest = line.slice("TITLE".length).trim();
  if (rest === "") {
    return undefined;
  }
  const quoted = rest.match(/^"(.*)"$/);
  return (quoted != null ? quoted[1] : rest).trim() || undefined;
}

function readInt(token: string | undefined, keyword: string, line: number): number {
  const value = readFloat(token, keyword, line);
  if (!Number.isInteger(value)) {
    throw new LutParseError(`${keyword} must be a whole number, got ${value}`, line);
  }
  return value;
}

function readFloat(
  token: string | undefined,
  keyword: string,
  line: number,
): number {
  if (token == null || !NUMBER.test(token)) {
    throw new LutParseError(
      `${keyword} expects a number, got "${truncate(token ?? "")}"`,
      line,
    );
  }
  const value = Number.parseFloat(token);
  if (!Number.isFinite(value)) {
    throw new LutParseError(`${keyword} is not a finite number`, line);
  }
  return value;
}

function readTriple(
  parts: string[],
  keyword: string,
  line: number,
): LutTriple {
  if (parts.length !== 4) {
    throw new LutParseError(
      `${keyword} expects three numbers, got ${parts.length - 1}`,
      line,
    );
  }
  return [
    readFloat(parts[1], keyword, line),
    readFloat(parts[2], keyword, line),
    readFloat(parts[3], keyword, line),
  ];
}

function truncate(token: string): string {
  return token.length > 24 ? `${token.slice(0, 24)}…` : token;
}

/**
 * Write a `LutData` back out as `.cube` text.
 *
 * The generator writes the shipped presets with this, and `cube.test.ts` uses
 * it to prove the reader and the writer are inverses — which is a stronger
 * statement about the reader than any single hand-written fixture, and it is
 * also what would let the app export a grade for use in another application.
 */
export function formatCube(lut: LutData, precision = 6): string {
  const out: string[] = [];
  if (lut.title != null) {
    out.push(`TITLE "${lut.title.replace(/"/g, "'")}"`);
  }
  out.push(lut.kind === "3d" ? `LUT_3D_SIZE ${lut.size}` : `LUT_1D_SIZE ${lut.size}`);
  if (
    lut.domainMin[0] !== 0 ||
    lut.domainMin[1] !== 0 ||
    lut.domainMin[2] !== 0 ||
    lut.domainMax[0] !== 1 ||
    lut.domainMax[1] !== 1 ||
    lut.domainMax[2] !== 1
  ) {
    out.push(`DOMAIN_MIN ${lut.domainMin.map((v) => fixed(v, precision)).join(" ")}`);
    out.push(`DOMAIN_MAX ${lut.domainMax.map((v) => fixed(v, precision)).join(" ")}`);
  }
  out.push("");
  for (let i = 0; i < lut.data.length; i += 3) {
    out.push(
      `${fixed(lut.data[i], precision)} ${fixed(lut.data[i + 1], precision)} ${fixed(
        lut.data[i + 2],
        precision,
      )}`,
    );
  }
  out.push("");
  return out.join("\n");
}

/**
 * `toFixed`, minus the negative zero.
 *
 * `(-1e-9).toFixed(6)` is `"-0.000000"`, which is a legal number and an ugly
 * one: it makes a generated file differ from an identical regenerated file
 * depending on which side of zero a rounding error fell, and the catalogue
 * suite compares those files byte for byte.
 */
function fixed(value: number, precision: number): string {
  const text = value.toFixed(precision);
  return text === `-${(0).toFixed(precision)}` ? (0).toFixed(precision) : text;
}
