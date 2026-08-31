/**
 * Our LUT sampler against FFmpeg's, on the same files.
 *
 * Every other test in this feature checks the implementation against *itself*
 * at one remove: `sample.test.ts` against properties, `glsl.test.ts` against
 * `sample.ts`, `lut.spec.ts` against arithmetic restated in the spec. All of
 * those would agree with a wrong-but-consistent idea of what a LUT is — a
 * transposed axis, an off-by-one on the grid, an interpolation that is not the
 * one the format expects.
 *
 * This one cannot. It runs the **bundled ffmpeg**'s `lut3d` filter — the
 * reference implementation everybody else's LUT tooling is checked against —
 * over a grid of colours, and compares its output to `sampleLut` on the same
 * `.cube`. Two independently written implementations agreeing to within one
 * 8-bit step is a statement about the format, not about our code.
 *
 * ## Why it is worth the second or so it costs
 *
 * A LUT that is subtly wrong does not look broken. It looks like a slightly
 * different grade — which is exactly what a LUT is supposed to be — so nothing
 * downstream would ever report it, and a user comparing Cartcut's output to
 * Resolve's would find a difference they could not explain. There is no other
 * check in this repository that would catch it.
 *
 * ## Two things about the comparison
 *
 * **No codec anywhere.** Raw `rgb24` in and raw `rgb24` out, so every value is
 * exact and the only difference that can appear is arithmetic.
 *
 * **Both interpolation schemes.** Tetrahedral is what ships, and trilinear is
 * a completely separate code path in *both* implementations — so agreeing on
 * both is much stronger evidence that the node indexing is right than agreeing
 * on either alone. A transposed axis would survive one scheme matching by
 * coincidence; it does not survive two.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseCube } from "./cube";
import { sampleLut, type Interpolation } from "./sample";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

/**
 * The bundled binary for this machine.
 *
 * `electron/lib/ffmpeg.ts` picks the same directory from `process.arch`; this
 * repeats the rule rather than importing it, because that module reaches
 * Electron and cannot be loaded here.
 */
function ffmpegPath(): string | null {
  const dir =
    process.platform === "win32"
      ? "win32-x64"
      : process.arch === "arm64"
        ? "darwin-arm64"
        : "darwin-x64";
  const binary = path.join(
    REPO_ROOT,
    "bin",
    dir,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  return fs.existsSync(binary) ? binary : null;
}

const FFMPEG = ffmpegPath();

/**
 * 4,096 colours: a 16³ grid, as a 64×64 image.
 *
 * **Two of them**, and the second is the one that earns its place. The obvious
 * grid — multiples of 17 — turns out to land very close to the nodes of a 17³
 * table for most of its values, so on its own it mostly exercises *lookup*.
 * Measured directly: a 17³ gamma curve reconstructs to 0.3/255 on that grid and
 * to 21/255 over all 256 values. A parity check that only sampled near the
 * nodes would be much weaker than it looked.
 *
 * So the second grid is offset by half a cell of a 17³ table, which puts every
 * sample in the middle of the cell it falls in — where the two implementations
 * have to agree about *interpolation* rather than about which node to read.
 */
const W = 64;
const H = 64;

function colourGrid(offset: number): Buffer {
  const buffer = Buffer.alloc(W * H * 3);
  let i = 0;
  const value = (n: number) => Math.min(255, n * 17 + offset);
  for (let b = 0; b < 16; b++) {
    for (let g = 0; g < 16; g++) {
      for (let r = 0; r < 16; r++) {
        buffer[i++] = value(r);
        buffer[i++] = value(g);
        buffer[i++] = value(b);
      }
    }
  }
  return buffer;
}

/** On the nodes, and half a cell off them. Both are compared, every time. */
const GRIDS: Array<[string, Buffer]> = [
  ["on-grid", colourGrid(0)],
  ["mid-cell", colourGrid(8)],
];

/** A neutral sweep of every 8-bit value, for measuring the format's own error. */
const RAMP_W = 256;
const RAMP_H = 1;
const RAMP = (() => {
  const buffer = Buffer.alloc(RAMP_W * RAMP_H * 3);
  for (let i = 0; i < RAMP_W; i++) {
    buffer[i * 3] = i;
    buffer[i * 3 + 1] = i;
    buffer[i * 3 + 2] = i;
  }
  return buffer;
})();

let tmp = "";

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cartcut-lut-parity-"));
  for (const [name, grid] of GRIDS) {
    fs.writeFileSync(path.join(tmp, `${name}.raw`), grid);
  }
  fs.writeFileSync(path.join(tmp, "ramp.raw"), RAMP);
});

afterAll(() => {
  if (tmp !== "") {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** Run one image through ffmpeg's `lut3d` and hand back the raw result. */
function throughFfmpeg(
  cubeText: string,
  interp: Interpolation,
  input: string,
  width: number,
  height: number,
): Buffer {
  const cube = path.join(tmp, "table.cube");
  const out = path.join(tmp, "out.raw");
  fs.writeFileSync(cube, cubeText, "utf8");
  execFileSync(FFMPEG as string, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-s",
    `${width}x${height}`,
    "-i",
    path.join(tmp, `${input}.raw`),
    "-vf",
    `lut3d=file=${cube}:interp=${interp}`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    out,
  ]);
  return fs.readFileSync(out);
}

type Divergence = { worst: number; where: string; mean: number };

/** Compare both grids at once, and report the worse of the two. */
function compare(cubeText: string, interp: Interpolation): Divergence {
  const lut = parseCube(cubeText);
  let worst = 0;
  let where = "";
  let total = 0;
  let count = 0;

  for (const [name, grid] of GRIDS) {
    const theirs = throughFfmpeg(cubeText, interp, name, W, H);
    for (let p = 0; p < W * H; p++) {
      const r = grid[p * 3];
      const g = grid[p * 3 + 1];
      const b = grid[p * 3 + 2];
      const mine = sampleLut(lut, r / 255, g / 255, b / 255, interp);
      const expected = [mine.r, mine.g, mine.b].map((v) =>
        Math.round(Math.min(1, Math.max(0, v)) * 255),
      );
      for (let c = 0; c < 3; c++) {
        const delta = Math.abs(theirs[p * 3 + c] - expected[c]);
        total += delta;
        count++;
        if (delta > worst) {
          worst = delta;
          where = `${name} rgb(${r},${g},${b}) channel ${c}: ffmpeg ${
            theirs[p * 3 + c]
          }, ours ${expected[c]}`;
        }
      }
    }
  }
  return { worst, where, mean: total / count };
}

/**
 * One 8-bit step.
 *
 * Not zero, and the reason is rounding rather than disagreement: ffmpeg
 * quantises its float result to a byte with its own rule, and a value landing
 * exactly on .5 can go either way. The *mean* difference is around half a step
 * across the whole grid, which is the signature of a rounding tie rather than
 * of an arithmetic difference — a real one would show a mean far above that and
 * a worst far above this.
 */
const TOLERANCE = 1;

/** Build a cube by evaluating `f` at every node. Written in file order. */
function cubeText(
  size: number,
  f: (r: number, g: number, b: number) => [number, number, number],
  header: string[] = [],
): string {
  const rows = [...header, `LUT_3D_SIZE ${size}`, ""];
  const last = size - 1;
  // Red fastest, which is the format's order and the thing most likely to be
  // got wrong. Written out here rather than generated by `formatCube`, so this
  // file does not inherit our idea of the ordering from the code under test.
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        rows.push(
          f(r / last, g / last, b / last)
            .map((v) => v.toFixed(6))
            .join(" "),
        );
      }
    }
  }
  return `${rows.join("\n")}\n`;
}

const describeIf = FFMPEG == null ? describe.skip : describe;

if (FFMPEG == null) {
  // Not silent: a skipped parity check should be visible, because the whole
  // point of it is that nothing else covers what it covers.
  console.warn(
    "lut parity: no bundled ffmpeg for this platform, skipping the check against it",
  );
}

describeIf("our sampler against ffmpeg's lut3d — shipped tables", () => {
  /** A spread across the catalogue: gentle, extreme, monochrome and a log one. */
  const SLUGS = [
    "identity",
    "mono-neutral",
    "teal-orange",
    "print-2383",
    "matte-faded",
    "neon-pop",
    "rec709-legal",
    "slog3-rec709",
  ];

  it.each(SLUGS)("%s agrees, tetrahedrally", (slug) => {
    const file = path.join(REPO_ROOT, "assets/presets/luts", slug, "lut.cube");
    const result = compare(fs.readFileSync(file, "utf8"), "tetrahedral");
    expect(result.worst, `${slug}: ${result.where}`).toBeLessThanOrEqual(TOLERANCE);
  });

  it.each(SLUGS)("%s agrees under trilinear too", (slug) => {
    // A separate code path in both implementations. Agreeing on both is what
    // rules out an axis transposition that one scheme could hide.
    const file = path.join(REPO_ROOT, "assets/presets/luts", slug, "lut.cube");
    const result = compare(fs.readFileSync(file, "utf8"), "trilinear");
    expect(result.worst, `${slug}: ${result.where}`).toBeLessThanOrEqual(TOLERANCE);
  });
});

describeIf("our sampler against ffmpeg's lut3d — tables built for this test", () => {
  const CASES: Array<[string, string]> = [
    // The ordering check, at the smallest size there is: with two nodes per
    // axis every value is interpolated, and a transposed axis is a completely
    // different picture.
    ["a 2³ channel swap", cubeText(2, (r, g, b) => [b, g, r])],
    ["a 2³ inversion", cubeText(2, (r, g, b) => [1 - r, 1 - g, 1 - b])],
    // Separable and nonlinear: the case where tetrahedral and trilinear
    // genuinely differ, so agreeing on both says something.
    [
      "a 33³ gamma curve",
      cubeText(33, (r, g, b) => [r ** 2.2, g ** 2.2, b ** 2.2]),
    ],
    // Cross-channel and not multilinear — nothing about this is reproduced
    // exactly by either scheme, so both must be interpolating the same way.
    [
      "a 17³ cross-channel grade",
      cubeText(17, (r, g, b) => [
        Math.min(1, Math.sqrt(r * 0.7 + g * 0.3)),
        Math.min(1, g ** 1.4),
        Math.min(1, b * 0.5 + r * 0.4),
      ]),
    ],
    // An odd size, and one where 16-step inputs never land on a node.
    ["a 9³ table", cubeText(9, (r, g, b) => [g, b, r])],
    // The header forms real files carry.
    [
      "a table with a TITLE and comments",
      cubeText(2, (r, g, b) => [b, g, r], [
        'TITLE "Parity Check"',
        "# written by a test",
      ]),
    ],
    [
      "a table stating the default domain explicitly",
      cubeText(2, (r, g, b) => [b, g, r], [
        "DOMAIN_MIN 0.0 0.0 0.0",
        "DOMAIN_MAX 1.0 1.0 1.0",
      ]),
    ],
  ];

  it.each(CASES)("%s agrees, tetrahedrally", (_name, text) => {
    const result = compare(text, "tetrahedral");
    expect(result.worst, result.where).toBeLessThanOrEqual(TOLERANCE);
  });

  it.each(CASES)("%s agrees under trilinear", (_name, text) => {
    const result = compare(text, "trilinear");
    expect(result.worst, result.where).toBeLessThanOrEqual(TOLERANCE);
  });

  it("survives CRLF line endings, as a file written on Windows would", () => {
    const text = cubeText(2, (r, g, b) => [b, g, r]).replace(/\n/g, "\r\n");
    const result = compare(text, "tetrahedral");
    expect(result.worst, result.where).toBeLessThanOrEqual(TOLERANCE);
  });
});

describeIf("the comparison itself is worth something", () => {
  /**
   * The anti-tautology guard.
   *
   * Everything above passes trivially if `compare` is broken, if ffmpeg is
   * ignoring the file, or if the grid is one colour. So: hand ffmpeg one table
   * and our sampler a *different* one, and require the comparison to fail
   * loudly. Without this the whole suite could be green while measuring
   * nothing.
   */
  it("reports a large divergence when the two are given different tables", () => {
    const theirs = throughFfmpeg(
      cubeText(2, (r, g, b) => [b, g, r]),
      "tetrahedral",
      "on-grid",
      W,
      H,
    );
    const INPUT = GRIDS[0][1];
    const ours = parseCube(cubeText(2, (r, g, b) => [r, g, b]));
    let worst = 0;
    for (let p = 0; p < W * H; p++) {
      const [r, g, b] = [INPUT[p * 3], INPUT[p * 3 + 1], INPUT[p * 3 + 2]];
      const mine = sampleLut(ours, r / 255, g / 255, b / 255);
      const expected = Math.round(mine.r * 255);
      worst = Math.max(worst, Math.abs(theirs[p * 3] - expected));
    }
    expect(worst).toBeGreaterThan(200);
  });

  it("is measuring a table ffmpeg actually applied", () => {
    // A `lut3d` that silently did nothing would make every table look like an
    // identity, and an identity table would still pass. This one must change
    // the picture.
    const theirs = throughFfmpeg(
      cubeText(2, (r, g, b) => [1 - r, 1 - g, 1 - b]),
      "tetrahedral",
      "on-grid",
      W,
      H,
    );
    expect(theirs.equals(GRIDS[0][1])).toBe(false);
    expect(Math.abs(theirs[0] - 255)).toBeLessThanOrEqual(1);
  });

  it("covers the whole cube twice, on the nodes and between them", () => {
    for (const [name, grid] of GRIDS) {
      const seen = new Set<string>();
      for (let p = 0; p < W * H; p++) {
        seen.add(`${grid[p * 3]},${grid[p * 3 + 1]},${grid[p * 3 + 2]}`);
      }
      expect(seen.size, name).toBe(4096);
    }
    // And the two grids are genuinely different samples of it.
    expect(GRIDS[0][1].equals(GRIDS[1][1])).toBe(false);
  });
});

describeIf("what a 17³ table costs, and who pays it", () => {
  /**
   * Not a parity check — a measurement, and the honest answer to "how accurate
   * is a 17³ LUT?"
   *
   * ffmpeg gets the same table we do, so this compares *both* of us against the
   * closed form the table was built from. What it separates is the error the
   * **format** carries from any error an implementation adds: the first is
   * large and shared, the second is a rounding step.
   *
   * A neutral sweep of all 256 values rather than the cube grids, because that
   * is where the error lives. `gamma 0.45` is steep near black, and a 17-node
   * table cannot follow it there — which is exactly the case the shipped
   * catalogue is held to a *median* for rather than to zero.
   */
  it("is the format's error, and both implementations carry the same one", () => {
    const f = (v: number) => Math.pow(v, 0.45);
    const text = cubeText(17, (r, g, b) => [f(r), f(g), f(b)]);
    const theirs = throughFfmpeg(text, "tetrahedral", "ramp", RAMP_W, RAMP_H);
    const lut = parseCube(text);

    let againstExact = 0;
    let betweenUs = 0;
    for (let i = 0; i < RAMP_W; i++) {
      const exact = Math.round(f(i / 255) * 255);
      const mine = Math.round(sampleLut(lut, i / 255, i / 255, i / 255).r * 255);
      againstExact = Math.max(againstExact, Math.abs(theirs[i * 3] - exact));
      betweenUs = Math.max(betweenUs, Math.abs(theirs[i * 3] - mine));
    }

    // The table really cannot represent this curve exactly...
    expect(againstExact).toBeGreaterThan(4);
    // ...and we and ffmpeg are wrong in precisely the same way, which is the
    // only kind of "wrong" a LUT implementation is allowed to be.
    expect(betweenUs).toBeLessThanOrEqual(TOLERANCE);
  });

  it("shrinks as the table grows, for both of us together", () => {
    // The other half of the same statement: the error is the grid's, so a
    // finer grid removes it — and removes it for ffmpeg and for us alike.
    const f = (v: number) => Math.pow(v, 0.45);
    const errors = [17, 33, 65].map((size) => {
      const text = cubeText(size, (r, g, b) => [f(r), f(g), f(b)]);
      const theirs = throughFfmpeg(text, "tetrahedral", "ramp", RAMP_W, RAMP_H);
      const lut = parseCube(text);
      let againstExact = 0;
      let betweenUs = 0;
      for (let i = 0; i < RAMP_W; i++) {
        const exact = Math.round(f(i / 255) * 255);
        const mine = Math.round(sampleLut(lut, i / 255, i / 255, i / 255).r * 255);
        againstExact = Math.max(againstExact, Math.abs(theirs[i * 3] - exact));
        betweenUs = Math.max(betweenUs, Math.abs(theirs[i * 3] - mine));
      }
      return { size, againstExact, betweenUs };
    });

    expect(errors[0].againstExact).toBeGreaterThan(errors[1].againstExact);
    expect(errors[1].againstExact).toBeGreaterThan(errors[2].againstExact);
    for (const { size, betweenUs } of errors) {
      expect(betweenUs, `${size}³`).toBeLessThanOrEqual(TOLERANCE);
    }
  });
});
