import { createStore } from "zustand/vanilla";
import {
  DEFAULT_EXPORT_SETTINGS,
  normalizeExportSettings,
  type ExportSettings,
} from "../features/export/settings";
import { coerceFps } from "../features/timeline/frames";

export type RenderOptions = {
  previewSize: {
    w: number;
    h: number;
  };
  /**
   * The project's frame rate.
   *
   * Whole frames per second, always — `coerceFps` is the only way a value
   * reaches this field, so no reader has to guard it. Sibling of `previewSize`
   * and `duration` rather than a member of `exportSettings`, because it is not
   * an encoder choice: it decides the timeline's snap grid, the ruler's ticks,
   * where a dragged clip lands, how finely animation is baked, and which frame
   * the preview shows — all of it long before anything is exported.
   */
  fps: number;
  duration: number;
  backgroundColor: string;
  exportSettings: ExportSettings;
};

/**
 * What `updateOptions` accepts.
 *
 * It is a whole-object setter and most of its call sites predate
 * `exportSettings`, so omitting the key has to mean "leave it alone" rather than
 * "clear it".
 */
export type RenderOptionsInput = Omit<RenderOptions, "exportSettings"> & {
  exportSettings?: Partial<ExportSettings>;
};

export interface IRenderOptionStore {
  options: RenderOptions;
  updateOptions: (options: RenderOptionsInput) => void;
  updateExportSettings: (patch: Partial<ExportSettings>) => void;
  setFps: (fps: number) => void;
}

export const renderOptionStore = createStore<IRenderOptionStore>((set) => ({
  options: {
    previewSize: {
      w: 1920,
      h: 1080,
    },
    fps: 60,
    duration: 10,
    backgroundColor: "#000000",
    exportSettings: DEFAULT_EXPORT_SETTINGS,
  },

  updateOptions: (options: RenderOptionsInput) =>
    set((state) => ({
      options: {
        ...options,
        // Validated here rather than at each call site, for the same reason
        // `exportSettings` is: this setter is what project load, the settings
        // panel and the e2e harness all go through, and a guard any one of them
        // can forget is a guard the store does not have.
        fps: coerceFps(options.fps),
        exportSettings: normalizeExportSettings(
          options.exportSettings ?? state.options.exportSettings,
        ),
      },
    })),

  /**
   * The coarse setter above is called with a mutated copy of the live object,
   * which cannot express "change one export field". This one merges and
   * re-normalizes, so an illegal codec/container/audio combination is
   * unrepresentable in the store.
   */
  updateExportSettings: (patch: Partial<ExportSettings>) =>
    set((state) => ({
      options: {
        ...state.options,
        exportSettings: normalizeExportSettings({
          ...state.options.exportSettings,
          ...patch,
        }),
      },
    })),

  /**
   * Change the project's frame rate and nothing else.
   *
   * `updateOptions` takes a whole object and its callers build that object by
   * mutating the live one, which cannot express "change this one field" — the
   * same gap `updateExportSettings` exists to fill.
   *
   * Only the store is touched here. Changing the frame rate also has to pull
   * the zoom back under its new ceiling and re-bake animation, and both of
   * those belong to the timeline store; `features/editor/frameRate.ts` is where
   * the three are sequenced.
   */
  setFps: (fps: number) =>
    set((state) => ({
      options: { ...state.options, fps: coerceFps(fps) },
    })),
}));
