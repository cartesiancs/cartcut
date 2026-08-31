/**
 * LUTs that arrive as pictures.
 *
 * Two conventions are in circulation and this reads both:
 *
 *  - a **Hald CLUT**, ImageMagick's layout — a square image of side `level³`
 *    holding a cube of side `level²`, whose pixels in plain row-major order
 *    *are* the cube in red-fastest order. A level-8 Hald is 512×512 and holds
 *    a 64³ cube.
 *  - a **tile strip**, the layout mobile and web filter apps ship — the cube's
 *    blue slices laid out as a grid of `size`×`size` tiles, `x` running red and
 *    `y` running green inside each tile. 512×512 as 8×8 tiles of 64, or
 *    1024×32 as 32 tiles in a row, are the two everyone uses.
 *
 * ## The ambiguity, and how it is settled
 *
 * A 512×512 image is a *valid reading* under both conventions, and they are
 * not the same picture. Nothing in the file says which one it is; tools in the
 * wild rely on filenames or on the user knowing. Refusing the file would be
 * unhelpful and guessing by size would be wrong half the time.
 *
 * So it is settled by **content**: both readings are scored against identity
 * and the closer one wins. This works because a LUT is a *grade* — a
 * perturbation of identity, usually a modest one — while the wrong reading
 * transposes the axes and lands nowhere near it. The margin in practice is two
 * orders of magnitude, not a photo finish. A synthetic image that is equally
 * far from identity under both readings is not a LUT anybody made.
 *
 * ## Precision
 *
 * An image LUT is 8 bits per channel by construction, so a node value carries
 * an error of up to 1/510. That is half a step of the 8-bit output the
 * renderer writes, and it is a property of the format rather than of this
 * reader — a `.cube` of the same grade is strictly better. Worth knowing when
 * a user asks why their PNG LUT bands slightly and their `.cube` does not.
 */

import {
  DEFAULT_DOMAIN_MAX,
  DEFAULT_DOMAIN_MIN,
  type Lut3d,
  LutParseError,
  assertSize3d,
  entryCountOf,
  identityLut3d,
  nodeOffset,
} from "./lutData";

/** The pixels of a decoded image. Structurally `ImageData`. */
export type ImagePixels = {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, row-major. */
  data: Uint8ClampedArray | Uint8Array;
};

export type ImageLutLayout =
  | { kind: "hald"; size: number; level: number }
  | { kind: "strip"; size: number; cols: number; rows: number };

export function parseImageLut(image: ImagePixels): Lut3d {
  const layouts = candidateLayouts(image.width, image.height);
  if (layouts.length === 0) {
    throw new LutParseError(
      `a ${image.width}×${image.height} image is not a LUT in any layout ` +
        "Cartcut knows — expected a Hald CLUT or a square-tile strip",
    );
  }

  let best: { lut: Lut3d; error: number } | null = null;
  for (const layout of layouts) {
    const lut = readLayout(image, layout);
    const error = distanceFromIdentity(lut);
    if (best == null || error < best.error) {
      best = { lut, error };
    }
  }
  return (best as { lut: Lut3d }).lut;
}

/**
 * Which readings the image's dimensions permit.
 *
 * Exported for the test, which asserts that 512×512 yields both and that
 * 1024×32 yields only the strip — the two facts the content heuristic above
 * rests on.
 */
export function candidateLayouts(
  width: number,
  height: number,
): ImageLutLayout[] {
  const out: ImageLutLayout[] = [];
  const pixels = width * height;
  if (pixels <= 0) {
    return out;
  }

  if (width === height) {
    const level = Math.round(Math.cbrt(width));
    const size = level * level;
    if (
      level >= 2 &&
      level * level * level === width &&
      size * size * size === pixels
    ) {
      out.push({ kind: "hald", size, level });
    }
  }

  const size = Math.round(Math.cbrt(pixels));
  if (
    size * size * size === pixels &&
    size >= 2 &&
    width % size === 0 &&
    height % size === 0 &&
    (width / size) * (height / size) === size
  ) {
    out.push({ kind: "strip", size, cols: width / size, rows: height / size });
  }

  return out.filter((layout) => {
    try {
      assertSize3d(layout.size);
      return true;
    } catch {
      return false;
    }
  });
}

function readLayout(image: ImagePixels, layout: ImageLutLayout): Lut3d {
  const { size } = layout;
  const data = new Float32Array(entryCountOf(size));
  const { width, data: px } = image;

  if (layout.kind === "hald") {
    // Row-major pixel order *is* red-fastest cube order. Nothing to transpose.
    for (let i = 0; i < size * size * size; i++) {
      const from = i * 4;
      const to = i * 3;
      data[to] = px[from] / 255;
      data[to + 1] = px[from + 1] / 255;
      data[to + 2] = px[from + 2] / 255;
    }
  } else {
    for (let b = 0; b < size; b++) {
      const tileX = (b % layout.cols) * size;
      const tileY = Math.floor(b / layout.cols) * size;
      for (let g = 0; g < size; g++) {
        for (let r = 0; r < size; r++) {
          const from = ((tileY + g) * width + tileX + r) * 4;
          const to = nodeOffset(size, r, g, b);
          data[to] = px[from] / 255;
          data[to + 1] = px[from + 1] / 255;
          data[to + 2] = px[from + 2] / 255;
        }
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

/** Mean absolute deviation from the identity cube of the same size. */
function distanceFromIdentity(lut: Lut3d): number {
  const reference = identityLut3d(lut.size);
  let total = 0;
  for (let i = 0; i < lut.data.length; i++) {
    total += Math.abs(lut.data[i] - reference.data[i]);
  }
  return total / lut.data.length;
}
