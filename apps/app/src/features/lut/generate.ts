/**
 * Turning a recipe into the two files a preset folder holds.
 *
 * Pure — no `fs`, no clock, no randomness — so `lutCatalogue.test.ts` can
 * regenerate a table in memory and compare it byte for byte with what is
 * checked in. That comparison is the whole reason this is separate from
 * `scripts/generateLuts.ts`, which is the thin filesystem wrapper around it:
 * the recipes and the shipped files cannot drift apart if the test can rebuild
 * one from the other.
 *
 * ## Why 17³
 *
 * 4,913 nodes, about 90 KB of text, ~7 MB for the whole catalogue. Every recipe
 * is a smooth function — no hard keys, no posterisation — and a smooth function
 * is reconstructed by tetrahedral interpolation on a 17-node grid to well
 * inside an 8-bit step, which `lutCatalogue.test.ts` measures rather than
 * assumes. A 33³ set would be eight times the disk for a difference nothing can
 * see.
 */

import { formatCube } from "./cube";
import { type Lut3d, identityLut3d, nodeOffset } from "./lutData";
import { gradeWith, type LutRecipe } from "./recipes";

/** Nodes per axis. See the header. */
export const BUILTIN_LUT_SIZE = 17;

/** Decimal places in the written file. */
export const BUILTIN_LUT_PRECISION = 6;

export type GeneratedLut = {
  slug: string;
  manifest: string;
  cube: string;
};

/** Evaluate one recipe over a whole cube. */
export function buildRecipeLut(recipe: LutRecipe, size = BUILTIN_LUT_SIZE): Lut3d {
  const lut = identityLut3d(size);
  lut.title = recipe.name;
  const last = size - 1;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const at = nodeOffset(size, r, g, b);
        const [x, y, z] = gradeWith(recipe, [r / last, g / last, b / last]);
        lut.data[at] = x;
        lut.data[at + 1] = y;
        lut.data[at + 2] = z;
      }
    }
  }
  return lut;
}

/** The preset id a slug becomes. The `lut.` segment keeps it clear of the effects. */
export function lutPresetId(slug: string): string {
  return `com.cartcut.lut.${slug}`;
}

/**
 * The two files one preset folder holds.
 *
 * The manifest is written with a two-space indent and a trailing newline,
 * because that is what every other manifest under `assets/presets/` looks like
 * and a diff that reformats eighty files is a diff nobody reads.
 */
export function generateLut(recipe: LutRecipe): GeneratedLut {
  const manifest = {
    schema: 1,
    id: lutPresetId(recipe.slug),
    kind: "lut",
    name: recipe.name,
    category: recipe.category,
    author: "Cartcut",
    version: "1.0.0",
    note: recipe.note,
    render: { type: "lut", source: "lut.cube" },
  };
  return {
    slug: recipe.slug,
    manifest: `${JSON.stringify(manifest, null, 2)}\n`,
    cube: formatCube(buildRecipeLut(recipe), BUILTIN_LUT_PRECISION),
  };
}
