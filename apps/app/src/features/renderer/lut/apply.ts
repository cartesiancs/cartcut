/**
 * Where a clip's LUT is turned into pixels.
 *
 * Two things are injected here rather than imported, and for the two reasons
 * this codebase already states elsewhere:
 *
 *  - **The resolver**, `presetId -> LutData`. Looking a LUT up means reaching
 *    the preset registry, which reads the disk. `renderer/element.ts` runs
 *    under `environment: "node"` in half a dozen suites and must not acquire a
 *    dependency on either. The same argument `runtime.ts` makes for the whole
 *    `FxRuntime` bag.
 *  - **The applier**, which does the arithmetic. The shipping one is WebGL;
 *    the fallback is `ImageData`. Sniffing for a global and quietly taking a
 *    different path in tests would mean the graded code was never the code that
 *    ships, so instead the *fallback itself* is what the node suites exercise —
 *    it is a real path a real user hits when a context cannot be created, and
 *    it is checked pixel for pixel against `sampleLut`.
 *
 * ## The default is chosen, not sniffed
 *
 * On first use the GPU applier is attempted. If a WebGL context cannot be made
 * — no `document`, a blocklisted driver, a context lost and not restored — the
 * CPU applier takes over permanently. Nothing has to ask which environment it
 * is in.
 */

import type { LutRef } from "../../../@types/timeline";
import type { LutData } from "../../lut/lutData";
import { isLutActive, lutOf } from "../lut";
import type { Surface } from "../surface";
import { createCpuLutApplier } from "./cpu";
import { createGpuLutApplier } from "./gpu";

/** Grade a surface in place. `false` means it could not, so nothing changed. */
export type LutApplier = {
  /**
   * `key` identifies the LUT for caching — a GPU applier uploads one texture
   * per key and keeps it. It is the preset id, and it must change whenever the
   * data behind it does.
   */
  apply(surface: Surface, key: string, lut: LutData, amount: number): boolean;
  dispose(): void;
};

export type LutResolver = (presetId: string) => LutData | null;

/** Nothing installed yet: every LUT is "not installed", so nothing grades. */
const NO_LUTS: LutResolver = () => null;

let resolver: LutResolver = NO_LUTS;

/**
 * Install the lookup from preset id to LUT data.
 *
 * Called once at startup by `features/lut/lutRegistry.ts`. Returns the previous
 * resolver so a test can put one back.
 */
export function setLutResolver(next: LutResolver): LutResolver {
  const previous = resolver;
  resolver = next;
  return previous;
}

let applier: LutApplier | null = null;
let applierChosen = false;
let blocking = false;

/**
 * Install a specific applier, or `null` to fall back to the default choice.
 *
 * Only tests should need this. Returns the previous one.
 */
export function setLutApplier(next: LutApplier | null): LutApplier | null {
  const previous = applier;
  applier = next;
  applierChosen = next != null;
  return previous;
}

/**
 * Whether the applier must wait for the GPU before returning.
 *
 * Export reads the 2D canvas back with `getImageData` on the next line, and
 * that read has to see the graded result. The preview does not care and should
 * not pay for the stall — the same split `renderVideoWithWait` and
 * `renderVideoWithoutWait` make, and the same one `CompositorOptions.blocking`
 * makes for effects.
 */
export function setLutBlocking(value: boolean): void {
  blocking = value;
}

export function lutBlocking(): boolean {
  return blocking;
}

function currentApplier(): LutApplier | null {
  if (applierChosen) {
    return applier;
  }
  applierChosen = true;
  applier = createGpuLutApplier() ?? createCpuLutApplier();
  return applier;
}

/** Test-only: forget the chosen applier so the next call picks again. */
export function resetLutApplier(): void {
  applier?.dispose();
  applier = null;
  applierChosen = false;
}

/**
 * What `renderElement` needs in order to grade one clip.
 *
 * Resolved *before* the fast-path decision, because a clip whose LUT is not
 * installed must keep the untouched code path rather than allocating a layer
 * to do nothing to. Absent means "draw this clip exactly as a build without
 * the feature would", which is the whole missing-preset contract.
 */
export type LutGrade = {
  key: string;
  lut: LutData;
  /** 0-1. */
  amount: number;
};

/**
 * Resolve a clip's grade, or `null` if it will not change anything.
 *
 * `null` for: no LUT, an intensity of zero, a preset that is not installed, or
 * no applier at all. All four render identically, and all four cost nothing.
 */
export function prepareLutGrade(ref: LutRef | null): LutGrade | null {
  if (!isLutActive(ref) || ref == null) {
    return null;
  }
  const lut = resolver(ref.presetId);
  if (lut == null) {
    return null;
  }
  if (currentApplier() == null) {
    return null;
  }
  return { key: ref.presetId, lut, amount: ref.intensity / 100 };
}

/**
 * A grade from a table the caller already has, rather than from a preset id.
 *
 * The colour adjustments' way in: their table is baked from the clip's own
 * settings (`adjust/bake.ts`), so there is nothing for the resolver to look
 * up. `key` must name the table's contents exactly — the GPU applier caches a
 * texture per key. `null` when there is no applier, the same answer
 * `prepareLutGrade` gives, so the caller keeps the fast path.
 */
export function directLutGrade(
  key: string,
  lut: LutData,
  amount: number,
): LutGrade | null {
  if (!(amount > 0) || currentApplier() == null) {
    return null;
  }
  return { key, lut, amount: Math.min(1, amount) };
}

/** `prepareLutGrade` straight from an element. The paint loop's entry point. */
export function lutGradeFor(
  element: Parameters<typeof lutOf>[0],
): LutGrade | null {
  return prepareLutGrade(lutOf(element));
}

/**
 * Grade a finished, isolated clip layer in place.
 *
 * Returns whether it happened. A `false` here is not an error: it means the
 * clip is composited ungraded, which is exactly what a build without the
 * feature would have drawn.
 */
export function applyLutGrade(surface: Surface, grade: LutGrade): boolean {
  const active = currentApplier();
  if (active == null) {
    return false;
  }
  return active.apply(surface, grade.key, grade.lut, grade.amount);
}
