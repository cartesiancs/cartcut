/**
 * What a LUT is, once it has been read off disk.
 *
 * One shape for every format the app accepts — `.cube`, `.3dl` and image-based
 * Hald CLUTs all normalise to this, so exactly one sampler, one GPU uploader
 * and one test oracle have to exist. Everything downstream of `parse.ts` knows
 * only this type.
 *
 * ## Why 1D is kept separate rather than widened to 3D
 *
 * A 1D LUT is three independent per-channel curves, and it is tempting to
 * expand one into an equivalent 3D table so there is a single code path. That
 * is exact under *trilinear* reconstruction and **not** exact under
 * *tetrahedral*, which is what we ship: trilinear factorises into a product of
 * three 1D interpolations, tetrahedral does not. Expanding would therefore
 * introduce error into the one case that could have been computed perfectly,
 * so the two stay separate all the way to the shader.
 *
 * ## Storage order
 *
 * `data` holds RGB triples with **red varying fastest**:
 *
 * ```
 * index(r, g, b) = ((b * size + g) * size + r) * 3
 * ```
 *
 * That is the order `.cube` files are written in, so a parser can push values
 * as it reads them. It is *not* the order ffmpeg uses internally (it stores
 * blue-fastest and remaps on read); the difference matters only if someone
 * ports code between the two, which is why it is stated here and pinned by a
 * hand-built 2³ table in `cube.test.ts`.
 *
 * ## Domain
 *
 * `domainMin`/`domainMax` come from the file and are usually `0,0,0` /
 * `1,1,1`. A log LUT may declare something else, and a LUT that declares a
 * domain and is sampled as though it were 0-1 is wrong in a way that looks
 * like a contrast error rather than like a bug — so the domain travels with
 * the data and `sample.ts` is the only place it is applied.
 *
 * Values themselves are deliberately **not** clamped to 0-1. HDR and
 * intermediate-space LUTs legitimately contain values outside it, and clamping
 * at parse time would silently change what the author wrote. Clamping happens
 * once, at the point the result is written into an 8-bit surface.
 */

/** Largest `LUT_3D_SIZE` accepted. Real LUTs are 17, 25, 32, 33, 64 or 65. */
export const MAX_LUT_3D_SIZE = 128;

/** Smallest table that can be interpolated at all. */
export const MIN_LUT_SIZE = 2;

/** Largest `LUT_1D_SIZE` accepted. */
export const MAX_LUT_1D_SIZE = 65536;

export type LutTriple = readonly [number, number, number];

type LutCommon = {
  /** From the file's `TITLE`, when it had one. Shown in the panel. */
  title?: string;
  domainMin: LutTriple;
  domainMax: LutTriple;
};

/** Three per-channel curves. `data` is `size * 3` floats. */
export type Lut1d = LutCommon & {
  kind: "1d";
  size: number;
  data: Float32Array;
};

/** A cube. `data` is `size ** 3 * 3` floats, red varying fastest. */
export type Lut3d = LutCommon & {
  kind: "3d";
  size: number;
  data: Float32Array;
};

export type LutData = Lut1d | Lut3d;

export const DEFAULT_DOMAIN_MIN: LutTriple = [0, 0, 0];
export const DEFAULT_DOMAIN_MAX: LutTriple = [1, 1, 1];

/**
 * Thrown by every reader, so a caller has one thing to catch.
 *
 * `line` is 1-based and refers to the source file, which is what makes the
 * import toast able to say *where* a stranger's LUT went wrong instead of only
 * that it did.
 */
export class LutParseError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line == null ? message : `line ${line}: ${message}`);
    this.name = "LutParseError";
  }
}

/** How many floats a cube of this size holds. */
export function entryCountOf(size: number): number {
  return size * size * size * 3;
}

/**
 * The offset of node `(r, g, b)` in a `Lut3d`'s `data`.
 *
 * Exported because the atlas builder and the tests both need it and neither
 * should re-derive the order — getting it wrong produces a picture that looks
 * plausible (a plausible *wrong* grade) rather than one that looks broken.
 */
export function nodeOffset(size: number, r: number, g: number, b: number): number {
  return ((b * size + g) * size + r) * 3;
}

/** An identity cube of `size`. The no-op, and the sharpest test in the suite. */
export function identityLut3d(size: number): Lut3d {
  assertSize3d(size);
  const data = new Float32Array(entryCountOf(size));
  const last = size - 1;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const at = nodeOffset(size, r, g, b);
        data[at] = r / last;
        data[at + 1] = g / last;
        data[at + 2] = b / last;
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

/** An identity 1D LUT of `size`. */
export function identityLut1d(size: number): Lut1d {
  assertSize1d(size);
  const data = new Float32Array(size * 3);
  const last = size - 1;
  for (let i = 0; i < size; i++) {
    const v = i / last;
    data[i * 3] = v;
    data[i * 3 + 1] = v;
    data[i * 3 + 2] = v;
  }
  return {
    kind: "1d",
    size,
    data,
    domainMin: DEFAULT_DOMAIN_MIN,
    domainMax: DEFAULT_DOMAIN_MAX,
  };
}

export function assertSize3d(size: number, line?: number): void {
  if (!Number.isInteger(size) || size < MIN_LUT_SIZE || size > MAX_LUT_3D_SIZE) {
    throw new LutParseError(
      `3D LUT size must be a whole number from ${MIN_LUT_SIZE} to ${MAX_LUT_3D_SIZE}, got ${size}`,
      line,
    );
  }
}

export function assertSize1d(size: number, line?: number): void {
  if (!Number.isInteger(size) || size < MIN_LUT_SIZE || size > MAX_LUT_1D_SIZE) {
    throw new LutParseError(
      `1D LUT size must be a whole number from ${MIN_LUT_SIZE} to ${MAX_LUT_1D_SIZE}, got ${size}`,
      line,
    );
  }
}

/**
 * Whether this LUT changes anything.
 *
 * Used to keep an identity LUT from costing a GPU pass, and by the catalogue
 * test to prove the shipped `identity` preset really is one.
 */
export function isIdentity(lut: LutData, epsilon = 1e-6): boolean {
  if (
    !tripleEquals(lut.domainMin, DEFAULT_DOMAIN_MIN, epsilon) ||
    !tripleEquals(lut.domainMax, DEFAULT_DOMAIN_MAX, epsilon)
  ) {
    return false;
  }
  const reference =
    lut.kind === "3d" ? identityLut3d(lut.size) : identityLut1d(lut.size);
  for (let i = 0; i < lut.data.length; i++) {
    if (Math.abs(lut.data[i] - reference.data[i]) > epsilon) {
      return false;
    }
  }
  return true;
}

function tripleEquals(a: LutTriple, b: LutTriple, epsilon: number): boolean {
  return (
    Math.abs(a[0] - b[0]) <= epsilon &&
    Math.abs(a[1] - b[1]) <= epsilon &&
    Math.abs(a[2] - b[2]) <= epsilon
  );
}
