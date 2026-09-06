import { createStore } from "zustand/vanilla";

type ActiveStringType =
  | "record"
  | ""
  | "audioRecord"
  | "automaticCaption"
  | "ytDownload"
  | "proxy";

export interface IControlPanelStore {
  /** Panels with a tab in the preview top bar, in the order they were opened. */
  active: ActiveStringType[];
  /** The one panel the preview area shows; `""` is the preview itself. */
  nowActive: ActiveStringType;

  openPanel: (panel: ActiveStringType) => void;
  closePanel: (panel: ActiveStringType) => void;
  setActivePanel: (nowActive: ActiveStringType) => void;
}

export const controlPanelStore = createStore<IControlPanelStore>((set) => ({
  active: [],
  nowActive: "",

  /**
   * Opening a panel that is already open focuses its existing tab instead of
   * appending a second one — a utility button is a "show me this", not a
   * "make me another".
   */
  openPanel: (panel: ActiveStringType) =>
    set((state) => ({
      active: state.active.includes(panel)
        ? state.active
        : [...state.active, panel],
      nowActive: panel,
    })),

  /**
   * Closing the focused panel falls back to the preview. Closing a background
   * one leaves the focus where it is, so tidying up tabs never yanks the user
   * out of what they are looking at.
   */
  closePanel: (panel: ActiveStringType) =>
    set((state) => {
      if (!state.active.includes(panel)) {
        return state;
      }

      return {
        active: state.active.filter((item) => item != panel),
        nowActive: state.nowActive == panel ? "" : state.nowActive,
      };
    }),

  setActivePanel: (nowActive: ActiveStringType) => set(() => ({ nowActive })),
}));
