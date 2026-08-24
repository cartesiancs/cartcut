import { createStore } from "zustand/vanilla";
import {
  DEFAULT_EXPORT_SETTINGS,
  normalizeExportSettings,
  type ExportSettings,
} from "../features/export/settings";

export type RenderOptions = {
  previewSize: {
    w: number;
    h: number;
  };
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
}));
