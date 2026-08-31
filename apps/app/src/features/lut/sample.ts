/**
 * Looking a colour up in a LUT. The reference implementation.
 *
 * Everything that grades a pixel is checked against this function: the CPU
 * applier calls it directly, the GPU shader restates it in GLSL and
 * `atlas.test.ts` pins the two together node by node, and the end-to-end spec
 * restates it a *third* time, independently, so a wrong shared idea of what a
 * LUT means cannot agree with itself and pass.
 *
 * ## Tetrahedral, not trilinear
 *
 * Both are implemented; only tetrahedral ships. It is the default in DaVinci
 * Resolve, in Premiere's Lumetri and in `ffmpeg -vf lut3d`, so it is what a
 * LUT's author was looking at when they decided the LUT was finished. The
 * difference is not academic on a coarse grid: trilinear interpolates over a
 * cube and pulls the neutral axis off grey, tetrahedral splits the cube into
 * six tetrahedra whose shared edge *is* the neutral axis, so greys stay grey.
 *
 * Trilinear is kept because it is the cross-check. The two agree **exactly**
 * at grid nodes and differ only between them, which is a property strong
 * enough to catch an off-by-one in the index arithmetic that either scheme
 * alone would hide.
 *
 * ## The barycentric form
 *
 * The tetrahedral arithmetic below is written as a convex combination of four
 * corners — the same form ffmpeg's `interp_tetrahedral` uses — rather than as
 * a base plus three deltas. Algebraically identical; numerically better
 * behaved, and it makes the invariant obvious: the weights sum to one, so the
 * result is always inside the hull of the four corners it was built from and
 * an interpolation bug cannot produce an out-of-range colour on an in-range
 * table.
 */

import {
  type Lut1d,
  type Lut3d,
  type LutData,
  type LutTriple,
  nodeOffset,
} from "./lutData";

export type Interpolation = "tetrahedral" | "trilinear";

/** What ships. See the header. */
export const DEFAULT_INTERPOLATION: Interpolation = "tetrahedral";

/** Reused across calls so a per-pixel loop allocates nothing. */
export type Rgb = { r: number; g: number; b: number };

/**
 * Grade one colour.
 *
 * `out` is written in place and returned, so the hot loop in `cpu.ts` can pass
 * the same object two million times without allocating. Pass nothing and a
 * fresh object comes back, which is what every test does.
 *
 * Inputs outside the LUT's domain are clamped to it, not extrapolated —
 * extrapolating off the end of a table is how a highlight rolls into a colour
 * the author never chose.
 */
export function sampleLut(
  lut: LutData,
  r: number,
  g: number,
  b: number,
  interpolation: Interpolation = DEFAULT_INTERPOLATION,
  out: Rgb = { r: 0, g: 0, b: 0 },
): Rgb {
  if (lut.kind === "1d") {
    return sample1d(lut, r, g, b, out);
  }
  return interpolation === "trilinear"
    ? trilinear(lut, r, g, b, out)
    : tetrahedral(lut, r, g, b, out);
}

/**
 * Where in the table a channel value lands.
 *
 * Returned as the low node index and the fraction past it. The clamp on `i` is
 * to `size - 2` rather than `size - 1` so that `i + 1` is always a real node:
 * at exactly the top of the domain that yields `i = size - 2, f = 1`, which
 * interpolates to the last node exactly.
 */
function locate(
  value: number,
  size: number,
  domainMin: number,
  domainMax: number,
): { i: number; f: number } {
  const span = domainMax - domainMin;
  // A degenerate domain would divide by zero. Treat it as "everything maps to
  // the bottom of the table", which is the only answer that is defined.
  const normalized = span === 0 ? 0 : (value - domainMin) / span;
  const clamped = normalized < 0 ? 0 : normalized > 1 ? 1 : normalized;
  const x = clamped * (size - 1);
  let i = Math.floor(x);
  if (i > size - 2) {
    i = size - 2;
  }
  if (i < 0) {
    i = 0;
  }
  return { i, f: x - i };
}

function sample1d(lut: Lut1d, r: number, g: number, b: number, out: Rgb): Rgb {
  const { data, size, domainMin, domainMax } = lut;
  const values: LutTriple = [r, g, b];
  const results = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const { i, f } = locate(values[c], size, domainMin[c], domainMax[c]);
    const lo = data[i * 3 + c];
    const hi = data[(i + 1) * 3 + c];
    results[c] = lo + (hi - lo) * f;
  }
  out.r = results[0];
  out.g = results[1];
  out.b = results[2];
  return out;
}

function tetrahedral(lut: Lut3d, r: number, g: number, b: number, out: Rgb): Rgb {
  const { data, size, domainMin, domainMax } = lut;
  const lr = locate(r, size, domainMin[0], domainMax[0]);
  const lg = locate(g, size, domainMin[1], domainMax[1]);
  const lb = locate(b, size, domainMin[2], domainMax[2]);

  const fx = lr.f;
  const fy = lg.f;
  const fz = lb.f;

  // Subscripts are (red, green, blue), each 0 for the low node and 1 for the
  // high one — so `c100` is one step along red and `c111` is the far corner.
  const c000 = nodeOffset(size, lr.i, lg.i, lb.i);
  const c111 = nodeOffset(size, lr.i + 1, lg.i + 1, lb.i + 1);

  let w0 = 0;
  let o1 = 0;
  let w1 = 0;
  let o2 = 0;
  let w2 = 0;
  let w3 = 0;

  if (fx > fy) {
    if (fy > fz) {
      // fx > fy > fz
      w0 = 1 - fx;
      o1 = nodeOffset(size, lr.i + 1, lg.i, lb.i);
      w1 = fx - fy;
      o2 = nodeOffset(size, lr.i + 1, lg.i + 1, lb.i);
      w2 = fy - fz;
      w3 = fz;
    } else if (fx > fz) {
      // fx > fz >= fy
      w0 = 1 - fx;
      o1 = nodeOffset(size, lr.i + 1, lg.i, lb.i);
      w1 = fx - fz;
      o2 = nodeOffset(size, lr.i + 1, lg.i, lb.i + 1);
      w2 = fz - fy;
      w3 = fy;
    } else {
      // fz >= fx > fy
      w0 = 1 - fz;
      o1 = nodeOffset(size, lr.i, lg.i, lb.i + 1);
      w1 = fz - fx;
      o2 = nodeOffset(size, lr.i + 1, lg.i, lb.i + 1);
      w2 = fx - fy;
      w3 = fy;
    }
  } else {
    if (fz > fy) {
      // fz > fy >= fx
      w0 = 1 - fz;
      o1 = nodeOffset(size, lr.i, lg.i, lb.i + 1);
      w1 = fz - fy;
      o2 = nodeOffset(size, lr.i, lg.i + 1, lb.i + 1);
      w2 = fy - fx;
      w3 = fx;
    } else if (fz > fx) {
      // fy >= fz > fx
      w0 = 1 - fy;
      o1 = nodeOffset(size, lr.i, lg.i + 1, lb.i);
      w1 = fy - fz;
      o2 = nodeOffset(size, lr.i, lg.i + 1, lb.i + 1);
      w2 = fz - fx;
      w3 = fx;
    } else {
      // fy >= fx >= fz
      w0 = 1 - fy;
      o1 = nodeOffset(size, lr.i, lg.i + 1, lb.i);
      w1 = fy - fx;
      o2 = nodeOffset(size, lr.i + 1, lg.i + 1, lb.i);
      w2 = fx - fz;
      w3 = fz;
    }
  }

  out.r = w0 * data[c000] + w1 * data[o1] + w2 * data[o2] + w3 * data[c111];
  out.g =
    w0 * data[c000 + 1] + w1 * data[o1 + 1] + w2 * data[o2 + 1] + w3 * data[c111 + 1];
  out.b =
    w0 * data[c000 + 2] + w1 * data[o1 + 2] + w2 * data[o2 + 2] + w3 * data[c111 + 2];
  return out;
}

function trilinear(lut: Lut3d, r: number, g: number, b: number, out: Rgb): Rgb {
  const { data, size, domainMin, domainMax } = lut;
  const lr = locate(r, size, domainMin[0], domainMax[0]);
  const lg = locate(g, size, domainMin[1], domainMax[1]);
  const lb = locate(b, size, domainMin[2], domainMax[2]);

  const wr = [1 - lr.f, lr.f];
  const wg = [1 - lg.f, lg.f];
  const wb = [1 - lb.f, lb.f];

  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let bi = 0; bi < 2; bi++) {
    for (let gi = 0; gi < 2; gi++) {
      for (let ri = 0; ri < 2; ri++) {
        const w = wr[ri] * wg[gi] * wb[bi];
        if (w === 0) {
          continue;
        }
        const at = nodeOffset(size, lr.i + ri, lg.i + gi, lb.i + bi);
        sr += w * data[at];
        sg += w * data[at + 1];
        sb += w * data[at + 2];
      }
    }
  }

  out.r = sr;
  out.g = sg;
  out.b = sb;
  return out;
}
