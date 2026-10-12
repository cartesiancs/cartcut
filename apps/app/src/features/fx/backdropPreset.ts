/**
 * Which presets a shape's backdrop may carry, and how each one runs.
 *
 * A pure function of a preset already in hand, so the writer (which has the
 * registry), `planFrame` (which is handed a lookup) and the inspector (which
 * lists the choices) all ask the same question of the same code.
 *
 * `createRuntime.ts#modeOfResolved` is not enough on its own. It never reads
 * `kind`, and answers `"shader"` for an HTML graphic and for a transition alike;
 * `FxCompositor#programFor` then picks its samplers by kind, so a transition
 * id stored on a backdrop would bind `from` and `to` where the effect wrapper
 * expects `source` and `original`, and draw a region of transparent black.
 */

import type { FxPreset } from "./presetTypes";

/** How a backdrop's preset is executed. An overlay is never one. */
export type BackdropMode = "shader" | "lut";

/**
 * How `preset` runs as a backdrop, or `null` when it cannot be one.
 *
 * Two kinds and two only: an effect whose render is a shader, and a LUT, which
 * ships as `kind: "lut"` rather than as an effect (`presetTypes.ts` says why it
 * is a kind of its own). An effect clip takes a LUT preset the same way, which
 * is how a LUT dropped on empty timeline becomes an adjustment layer.
 */
export function backdropModeOf(preset: FxPreset | null | undefined): BackdropMode | null {
  if (preset == null) {
    return null;
  }
  if (preset.kind === "effect" && preset.render.type === "shader") {
    return "shader";
  }
  if (preset.kind === "lut" && preset.render.type === "lut") {
    return "lut";
  }
  return null;
}
