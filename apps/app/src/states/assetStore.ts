import { createStore } from "zustand/vanilla";

export type AssetShowType = "grid" | "list";

export interface IAssetStore {
  showType: AssetShowType;
  setShowType: (showType: AssetShowType) => void;
  toggleShowType: () => void;

  /**
   * The browse cursor — which folder the asset panel is currently showing.
   *
   * Distinct from `projectStore.projectFolder`, which is the chosen project
   * root and decides where renders and exports are written. Clicking into a
   * subfolder moves this and leaves that alone.
   *
   * "" means no folder has been picked yet.
   */
  nowDirectory: string;

  /**
   * Bumped on every `setDirectory`, including one that names the folder already
   * open. `<asset-browser>` reloads when this changes rather than when the path
   * does, so re-picking the current folder still refreshes it.
   */
  directoryRevision: number;

  setDirectory: (dir: string) => void;
}

export const assetStore = createStore<IAssetStore>((set) => ({
  showType: "grid",

  setShowType: (showType) => set(() => ({ showType: showType })),

  toggleShowType: () =>
    set((state) => ({ showType: state.showType == "grid" ? "list" : "grid" })),

  nowDirectory: "",
  directoryRevision: 0,

  setDirectory: (dir) =>
    set((state) => ({
      nowDirectory: dir,
      directoryRevision: state.directoryRevision + 1,
    })),
}));
