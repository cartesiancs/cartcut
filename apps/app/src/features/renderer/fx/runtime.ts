/**
 * What `renderTimelineAtTime` needs in order to draw effects and transitions.
 *
 * A bag of dependencies rather than direct imports, for one reason: the paint
 * loop is shared by the preview, the in-app export and the offscreen export
 * window, and they differ in every one of these. The preview must not block on
 * the GPU; the export must. The preview reads overlay frames from the live
 * `<video>` handles; a headless renderer would not have them. Passing them in
 * keeps `renderer/timeline.ts` free of the asset store and the preset registry,
 * and keeps it testable with `fx` set to `null`.
 */

import type { EffectElementType } from "../../../@types/timeline";
import type { FxPreset } from "../../fx/presetTypes";
import type { LutData } from "../../lut/lutData";
import type { FxCompositor } from "./compositor";
import type { PresetMode } from "./planFrame";

export type FxRuntime = {
  compositor: FxCompositor;
  /**
   * The project frame rate.
   *
   * Load-bearing: `progressOf` snaps the playhead to this grid before deriving
   * a transition's `progress`, which is what makes the preview and the export
   * produce the same number. See `transitionGeometry.ts#progressOf`.
   */
  fps: number;
  /** How a preset runs, or `null` when it is not installed. */
  modeOf: (presetId: string) => PresetMode | null;
  /** The preset itself, or `null` when it is not installed. */
  presetOf: (presetId: string) => FxPreset | null;
  /**
   * The colour table behind a LUT preset, or `null` when it is not ready.
   *
   * Injected for the same reason everything else here is: resolving one means
   * reading a file, and `renderer/timeline.ts` must stay free of both the
   * registry and the disk. `null` covers "not installed", "not read yet" and
   * "unreadable" alike — all three draw the frame ungraded, which is the same
   * pass-through a missing shader preset gets.
   */
  lutFor: (presetId: string) => LutData | null;
  /**
   * The current frame of an overlay effect's looping media.
   *
   * `null` while it is still decoding, which draws nothing this frame rather
   * than stalling the loop — the same contract `renderer/video.ts` has for a
   * clip whose handle has not loaded.
   */
  overlayFrameFor: (
    elementId: string,
    element: EffectElementType,
    timeInMs: number,
  ) => CanvasImageSource | null;
};
