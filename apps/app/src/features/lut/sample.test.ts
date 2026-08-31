import { describe, expect, it } from "vitest";

import {
  type Lut1d,
  type Lut3d,
  identityLut1d,
  identityLut3d,
  nodeOffset,
} from "./lutData";
import { sampleLut } from "./sample";

/** Build a cube by evaluating `f` at every node. */
function cubeFrom(
  size: number,
  f: (r: number, g: number, b: number) => [number, number, number],
): Lut3d {
  const lut = identityLut3d(size);
  const last = size - 1;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const at = nodeOffset(size, r, g, b);
        const [x, y, z] = f(r / last, g / last, b / last);
        lut.data[at] = x;
        lut.data[at + 1] = y;
        lut.data[at + 2] = z;
      }
    }
  }
  return lut;
}

/** A deterministic spread of points in the unit cube. No RNG, no seed to lose. */
function* gridPoints(steps: number): Generator<[number, number, number]> {
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      for (let k = 0; k <= steps; k++) {
        yield [i / steps, j / steps, k / steps];
      }
    }
  }
}

describe("sampleLut — identity", () => {
  // The sharpest test there is: whatever the interpolation does between nodes,
  // it must do nothing at all to a table that says "leave this alone".
  it("is exactly the input for every 8-bit value on every channel", () => {
    for (const size of [2, 3, 17, 33]) {
      const lut = identityLut3d(size);
      for (let i = 0; i < 256; i++) {
        const v = i / 255;
        const out = sampleLut(lut, v, v, v);
        expect(out.r).toBeCloseTo(v, 5);
        expect(out.g).toBeCloseTo(v, 5);
        expect(out.b).toBeCloseTo(v, 5);
      }
    }
  });

  it("leaves off-neutral colours alone too", () => {
    const lut = identityLut3d(17);
    for (const [r, g, b] of gridPoints(12)) {
      const out = sampleLut(lut, r, g, b);
      expect(out.r).toBeCloseTo(r, 5);
      expect(out.g).toBeCloseTo(g, 5);
      expect(out.b).toBeCloseTo(b, 5);
    }
  });

  it("is exact for a 1D identity as well", () => {
    const lut = identityLut1d(64);
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      const out = sampleLut(lut, v, 1 - v, 0.5);
      expect(out.r).toBeCloseTo(v, 5);
      expect(out.g).toBeCloseTo(1 - v, 5);
      expect(out.b).toBeCloseTo(0.5, 5);
    }
  });
});

describe("sampleLut — the two schemes against each other", () => {
  // Deliberately **not** multilinear and not separable. Trilinear reproduces
  // any multilinear function exactly — a matrix, a saturation change, even a
  // product like `r*g*b` — and tetrahedral reproduces any function that is
  // affine per tetrahedron, which covers all of those too. So a table built
  // from any of them makes the two schemes agree everywhere and the
  // "they differ" assertion below would be vacuous. The square root and the
  // variable exponent are what break that.
  const lut = cubeFrom(9, (r, g, b) => [
    Math.min(1, Math.sqrt(r * r * 0.8 + g * g * 0.2)),
    Math.min(1, Math.pow(g, 1 + 0.5 * b)),
    Math.min(1, Math.sqrt(b) * 0.9 + r * g * 0.1),
  ]);

  // Both schemes reconstruct the table exactly where the table is defined.
  // Anything that indexes a node wrongly breaks this, and it breaks it for one
  // scheme and not the other — which is the whole reason both exist.
  it("agree exactly at every grid node", () => {
    const last = lut.size - 1;
    for (let b = 0; b < lut.size; b++) {
      for (let g = 0; g < lut.size; g++) {
        for (let r = 0; r < lut.size; r++) {
          const at = nodeOffset(lut.size, r, g, b);
          const tet = sampleLut(lut, r / last, g / last, b / last, "tetrahedral");
          const tri = sampleLut(lut, r / last, g / last, b / last, "trilinear");
          expect(tet.r).toBeCloseTo(lut.data[at], 6);
          expect(tet.g).toBeCloseTo(lut.data[at + 1], 6);
          expect(tet.b).toBeCloseTo(lut.data[at + 2], 6);
          expect(tri.r).toBeCloseTo(lut.data[at], 6);
          expect(tri.g).toBeCloseTo(lut.data[at + 1], 6);
          expect(tri.b).toBeCloseTo(lut.data[at + 2], 6);
        }
      }
    }
  });

  it("differ between nodes, which is what makes the agreement above mean something", () => {
    let differences = 0;
    for (const [r, g, b] of gridPoints(11)) {
      const tet = sampleLut(lut, r, g, b, "tetrahedral");
      const tri = sampleLut(lut, r, g, b, "trilinear");
      if (Math.abs(tet.r - tri.r) > 1e-4) {
        differences++;
      }
    }
    expect(differences).toBeGreaterThan(50);
  });

  it("stay within the hull of the nodes they interpolate", () => {
    // The barycentric form makes this structural: the weights sum to one, so a
    // table inside 0..1 can never produce a value outside it.
    for (const [r, g, b] of gridPoints(15)) {
      const out = sampleLut(lut, r, g, b, "tetrahedral");
      expect(out.r).toBeGreaterThanOrEqual(-1e-6);
      expect(out.r).toBeLessThanOrEqual(1 + 1e-6);
      expect(out.g).toBeGreaterThanOrEqual(-1e-6);
      expect(out.g).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});

describe("sampleLut — tetrahedral keeps greys grey", () => {
  // The reason tetrahedral is the industry default. A LUT that maps the
  // neutral axis to itself must leave greys neutral no matter how coarse the
  // grid is; trilinear pulls them off-axis wherever the cube's corners are
  // unbalanced, and on a 3-node grid the error is plainly visible.
  const lut = cubeFrom(3, (r, g, b) => [
    // A grade that leaves the neutral axis alone but is not itself neutral.
    Math.min(1, r * 1.3),
    g,
    Math.max(0, b * 0.7),
  ]);
  // Force the neutral axis to be exactly identity.
  const size = 3;
  for (let i = 0; i < size; i++) {
    const at = nodeOffset(size, i, i, i);
    lut.data[at] = i / (size - 1);
    lut.data[at + 1] = i / (size - 1);
    lut.data[at + 2] = i / (size - 1);
  }

  it("returns grey for grey", () => {
    for (const v of [0.1, 0.25, 0.4, 0.6, 0.75, 0.9]) {
      const out = sampleLut(lut, v, v, v, "tetrahedral");
      expect(out.r).toBeCloseTo(v, 5);
      expect(out.g).toBeCloseTo(v, 5);
      expect(out.b).toBeCloseTo(v, 5);
    }
  });

  it("and trilinear does not, which is why it is not what ships", () => {
    const out = sampleLut(lut, 0.25, 0.25, 0.25, "trilinear");
    expect(Math.abs(out.r - 0.25)).toBeGreaterThan(1e-3);
  });
});

describe("sampleLut — the domain", () => {
  it("maps a declared domain onto the table", () => {
    const lut = identityLut3d(2);
    const shifted: Lut3d = { ...lut, domainMin: [0, 0, 0], domainMax: [4, 4, 4] };
    // Half way up a 0..4 domain is the middle of the table, which for an
    // identity table is 0.5 — not 2.
    const out = sampleLut(shifted, 2, 2, 2);
    expect(out.r).toBeCloseTo(0.5, 5);
  });

  it("clamps rather than extrapolating past the ends", () => {
    const lut = identityLut3d(4);
    expect(sampleLut(lut, 5, -3, 0.5).r).toBeCloseTo(1, 5);
    expect(sampleLut(lut, 5, -3, 0.5).g).toBeCloseTo(0, 5);
  });

  it("does not divide by zero on a degenerate domain", () => {
    const lut = identityLut3d(4);
    const degenerate: Lut3d = { ...lut, domainMin: [1, 1, 1], domainMax: [1, 1, 1] };
    const out = sampleLut(degenerate, 0.5, 0.5, 0.5);
    expect(Number.isFinite(out.r)).toBe(true);
  });

  it("applies a per-channel domain to 1D LUTs", () => {
    const base = identityLut1d(2);
    const lut: Lut1d = { ...base, domainMin: [0, 0, 0], domainMax: [2, 1, 1] };
    expect(sampleLut(lut, 1, 1, 1).r).toBeCloseTo(0.5, 5);
    expect(sampleLut(lut, 1, 1, 1).g).toBeCloseTo(1, 5);
  });
});

describe("sampleLut — a known analytic transform", () => {
  // An independent oracle: the closed form of the function the table was built
  // from. On a 33-node grid a smooth curve is reconstructed to well inside an
  // 8-bit step, which is the standard the shipped presets are held to.
  it("reproduces gamma 2.2 to better than one 8-bit step", () => {
    const lut = cubeFrom(33, (r, g, b) => [
      Math.pow(r, 2.2),
      Math.pow(g, 2.2),
      Math.pow(b, 2.2),
    ]);
    let worst = 0;
    for (let i = 0; i <= 255; i++) {
      const v = i / 255;
      const out = sampleLut(lut, v, v, v);
      worst = Math.max(worst, Math.abs(out.r - Math.pow(v, 2.2)));
    }
    expect(worst).toBeLessThan(1 / 255);
  });
});

describe("sampleLut — the out parameter", () => {
  it("writes in place and returns the same object", () => {
    const lut = identityLut3d(2);
    const out = { r: 0, g: 0, b: 0 };
    expect(sampleLut(lut, 0.5, 0.5, 0.5, "tetrahedral", out)).toBe(out);
    expect(out.r).toBeCloseTo(0.5, 5);
  });
});
