/**
 * What a track's numbers look like to a person.
 *
 * Every animatable property but one is stored in the unit it is read in:
 * `opacity` and `revealProgress` are 0-100 in the document and 0-100 in the
 * panel, `rotation` is degrees in both, `size` and `position` are pixels in
 * both. `scale` is the exception: it is stored in **tenths**, so 10 is
 * unscaled, and there is no changing that. The tenths are in every baked lane
 * of every saved project and in every entry of `presets.ts`, and `.ngt` load is
 * a compatibility check rather than a migrator, so moving the unit would mean
 * refusing to open the files it was supposed to help.
 *
 * So the conversion lives here, at the two places a person reads the number:
 * the sidebar's Scale row and the curve editor's value ruler. Both go through
 * this module so they cannot disagree, and neither the pure ops nor the
 * renderer ever sees a percent.
 *
 * Deliberately not in `keyframes.ts` next to `lanesOf` and `VECTOR_PROPERTIES`.
 * Those answer what a property *is*: how many lanes it has, whether it can
 * carry a track, and every consumer of them is structural. This answers how it
 * is *spelled*, and its only consumers are the two that draw a number.
 */

/** A property whose stored unit is not the unit it is shown in. */
const DISPLAY_FACTORS: Record<string, number> = {
  // Tenths stored, percent shown. 12 in the document is "120" in the panel and
  // "120" on the ruler.
  scale: 10,
};

/**
 * Multiply a stored value by this to get the number to show.
 *
 * `1` for everything but `scale`, including every property that does not exist:
 * an `fx:` parameter's unit is whatever its manifest says, and the panel that
 * draws those reads the manifest rather than asking here.
 */
export function displayFactorOf(property: string): number {
  return DISPLAY_FACTORS[property] ?? 1;
}

/** A stored track value, in the unit a person reads. */
export function toDisplay(property: string, value: number): number {
  return value * displayFactorOf(property);
}

/** The inverse of `toDisplay`: what a person typed, in the stored unit. */
export function fromDisplay(property: string, shown: number): number {
  return shown / displayFactorOf(property);
}
