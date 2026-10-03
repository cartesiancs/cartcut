import { createStore } from "zustand/vanilla";

/**
 * Which bottom sheet the phone layout is showing.
 *
 * A phone has room for one panel at a time, so the desktop's two side columns
 * become sheets over the timeline: `panel` is the left column on one of its
 * tabs, `option` is the right column, the selected clip's inspector. Opening
 * one closes the other.
 *
 * View state only. Nothing here is saved, undone or read below the UI.
 */
export type MobileSheet =
  | null
  | { kind: "panel"; pane: string; title: string }
  | { kind: "option" };

export interface IMobileStore {
  sheet: MobileSheet;
  open: (sheet: Exclude<MobileSheet, null>) => void;
  close: () => void;
}

export const mobileStore = createStore<IMobileStore>((set) => ({
  sheet: null,
  open: (sheet) => set({ sheet }),
  close: () => set((state) => (state.sheet == null ? state : { sheet: null })),
}));
