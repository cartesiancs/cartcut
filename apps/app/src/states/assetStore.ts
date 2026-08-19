import { createStore } from "zustand/vanilla";

export type AssetShowType = "grid" | "list";

export interface IAssetStore {
  showType: AssetShowType;
  setShowType: (showType: AssetShowType) => void;
  toggleShowType: () => void;
}

export const assetStore = createStore<IAssetStore>((set) => ({
  showType: "grid",

  setShowType: (showType) => set(() => ({ showType: showType })),

  toggleShowType: () =>
    set((state) => ({ showType: state.showType == "grid" ? "list" : "grid" })),
}));
