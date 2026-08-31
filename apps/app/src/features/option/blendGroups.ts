/**
 * The blend-mode dropdown's contents: what each mode is called, and which
 * heading it sits under.
 *
 * Its own module rather than a const inside `controlBlendMode.ts`, so it can be
 * tested under `environment: "node"`. Importing that file runs
 * `@customElement`, which needs a `customElements` registry the node
 * environment does not have — the list would then be pinned by no test at all,
 * which is exactly the pair that can silently go out of step with
 * `BLEND_MODES`.
 */

import type { BlendMode } from "../../@types/timeline";

/**
 * The seventeen modes, grouped the way a compositing app presents them.
 *
 * The groups are the standard ones — what a mode does to the picture beneath
 * decides which heading it sits under — and they matter at this length: a flat
 * list of seventeen is a scroll rather than a choice.
 *
 * Labels are English, matching the blend dropdown `optionEffect.ts` already
 * ships. That panel keeps its own shorter list on purpose and is deliberately
 * **not** rebuilt from this one: its header says the six it offers are the
 * modes whose Canvas2D fast path is pinned against a GLSL equivalent, so
 * widening it would offer an overlay preset modes the shader side cannot match.
 *
 * The first group is deliberately unlabelled, so `Normal` renders as a bare
 * `<option>` above the headings rather than as a category of one.
 */
export const BLEND_GROUPS: ReadonlyArray<{
  label: string;
  modes: ReadonlyArray<{ value: BlendMode; label: string }>;
}> = [
  {
    label: "",
    modes: [{ value: "source-over", label: "Normal" }],
  },
  {
    label: "Darken",
    modes: [
      { value: "darken", label: "Darken" },
      { value: "multiply", label: "Multiply" },
      { value: "color-burn", label: "Color Burn" },
    ],
  },
  {
    label: "Lighten",
    modes: [
      { value: "lighten", label: "Lighten" },
      { value: "screen", label: "Screen" },
      { value: "color-dodge", label: "Color Dodge" },
      { value: "lighter", label: "Add" },
    ],
  },
  {
    label: "Contrast",
    modes: [
      { value: "overlay", label: "Overlay" },
      { value: "soft-light", label: "Soft Light" },
      { value: "hard-light", label: "Hard Light" },
    ],
  },
  {
    label: "Comparative",
    modes: [
      { value: "difference", label: "Difference" },
      { value: "exclusion", label: "Exclusion" },
    ],
  },
  {
    label: "Component",
    modes: [
      { value: "hue", label: "Hue" },
      { value: "saturation", label: "Saturation" },
      { value: "color", label: "Color" },
      { value: "luminosity", label: "Luminosity" },
    ],
  },
];

/** Every offered mode, flat. `blendGroups.test.ts` pins it against `BLEND_MODES`. */
export const BLEND_GROUP_MODES: readonly BlendMode[] = BLEND_GROUPS.flatMap(
  (group) => group.modes.map((mode) => mode.value),
);
