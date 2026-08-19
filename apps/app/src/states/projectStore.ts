import { createStore } from "zustand/vanilla";

export interface IProjectStore {
  /**
   * The chosen project root — where renders and exports are written.
   *
   * Not the asset panel's browse cursor: clicking into a subfolder moves
   * `assetStore.nowDirectory` and deliberately leaves this alone, so the output
   * location does not follow the user around the file tree.
   */
  projectFolder: string;
  updateProjectFolder: (projectFolder: string) => void;
}

export const projectStore = createStore<IProjectStore>((set) => ({
  projectFolder: "",

  updateProjectFolder: (projectFolder: string) =>
    set(() => ({ projectFolder: projectFolder })),
}));
