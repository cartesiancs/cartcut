import { createStore } from "zustand/vanilla";

/**
 * How far each pane may be dragged.
 *
 * The three columns are percentages of the window and always sum to 100, so a
 * limit on one is a limit on its neighbours: the mins below add up to 55, which
 * leaves 45 for a drag to move around and makes it impossible for any column to
 * be squeezed out. `preview` needs no max — with both siblings at their min it
 * can only reach 70.
 */
export const HORIZONTAL_LIMITS = {
  panel: { min: 15, max: 40 },
  preview: { min: 25 },
  option: { min: 15, max: 40 },
};

/** The timeline's share of the window height; the preview keeps the rest. */
export const VERTICAL_LIMITS = { bottom: { min: 20, max: 70 } };

/** Track-header width, in px — this one is not a percentage. */
export const TIMELINE_LEFT_OPTION_LIMITS = { min: 120, max: 400 };

/** Px of timeline canvas the headers may never eat into. */
const TIMELINE_CANVAS_MIN_WIDTH = 240;

/**
 * `min` wins when the bounds cross, so a pane pinned at its minimum stays
 * visible even if the state it is clamped against is out of range.
 */
const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

export interface IUIStore {
  resize: {
    chatSidebar: number;

    vertical: {
      top: number;
      bottom: number;
    };
    horizontal: {
      panel: number;
      preview: number;
      option: number;
    };
    timelineVertical: {
      leftOption: number;
    };
  };
  topBarTitle: string;
  /**
   * Whether the option column has a panel to show.
   *
   * False until the first clip is selected, which is the state the app opens
   * in: every panel hides itself in its constructor and nothing shows one
   * until `optionGroup.showOption` runs. The column is drawn either way — this
   * only decides whether it shows its panels or the "nothing selected yet"
   * placeholder, so the layout never shifts under the user.
   *
   * `optionGroup` is the only writer, since it is the only thing that knows
   * whether a panel actually made it onto the screen.
   */
  isOptionPanelActive: boolean;
  /** `viewportWidth` caps the headers on a narrow window; px, both of them. */
  updateTimelineVertical: (px: number, viewportWidth?: number) => void;
  setChatSidebar: (width: number) => void;
  updateVertical: (criteria: number) => void;
  updateHorizontal: (criteria: number, panel: "panel" | "preview") => void;
  setTopBarTitle: (topBarTitle: string) => void;
  setOptionPanelActive: (isOptionPanelActive: boolean) => void;
}

export const uiStore = createStore<IUIStore>((set) => ({
  resize: {
    chatSidebar: 10,
    vertical: {
      top: 60,
      bottom: 40,
    },
    horizontal: {
      panel: 30,
      preview: 50,
      option: 20,
    },
    timelineVertical: {
      leftOption: 170,
    },
  },
  topBarTitle: "CartCut",
  isOptionPanelActive: false,

  setOptionPanelActive: (isOptionPanelActive) =>
    set(() => ({ isOptionPanelActive })),

  setChatSidebar: (width) =>
    set((state) => ({
      resize: {
        chatSidebar: width,
        vertical: { ...state.resize.vertical },
        horizontal: { ...state.resize.horizontal },
        timelineVertical: {
          leftOption: state.resize.timelineVertical.leftOption,
        },
      },
    })),

  setTopBarTitle: (topBarTitle) =>
    set((state) => ({
      topBarTitle: topBarTitle,
    })),

  updateTimelineVertical: (px, viewportWidth = Infinity) =>
    set((state) => ({
      resize: {
        chatSidebar: state.resize.chatSidebar,
        vertical: { ...state.resize.vertical },
        horizontal: { ...state.resize.horizontal },
        timelineVertical: {
          leftOption: clamp(
            px,
            TIMELINE_LEFT_OPTION_LIMITS.min,
            Math.min(
              TIMELINE_LEFT_OPTION_LIMITS.max,
              viewportWidth - TIMELINE_CANVAS_MIN_WIDTH,
            ),
          ),
        },
      },
    })),

  updateVertical: (criteria) =>
    set((state) => {
      const bottom = clamp(
        criteria,
        VERTICAL_LIMITS.bottom.min,
        VERTICAL_LIMITS.bottom.max,
      );

      return {
        resize: {
          chatSidebar: state.resize.chatSidebar,

          vertical: { top: 100 - bottom, bottom: bottom },
          horizontal: { ...state.resize.horizontal },
          timelineVertical: { ...state.resize.timelineVertical },
        },
      };
    }),

  updateHorizontal: (criteria, panel: "panel" | "preview") =>
    set((state) => {
      if (panel == "panel") {
        // `criteria` is the first divider: everything left of it is the panel.
        // The option column is untouched by this drag, so the preview absorbs
        // the whole difference — which is why the panel may only grow until the
        // preview reaches its min.
        const optionPer = state.resize.horizontal.option;
        const panelPer = clamp(
          criteria,
          HORIZONTAL_LIMITS.panel.min,
          Math.min(
            HORIZONTAL_LIMITS.panel.max,
            100 - optionPer - HORIZONTAL_LIMITS.preview.min,
          ),
        );

        return {
          resize: {
            chatSidebar: state.resize.chatSidebar,

            vertical: { ...state.resize.vertical },
            horizontal: {
              panel: panelPer,
              preview: 100 - (optionPer + panelPer),
              option: optionPer,
            },
            timelineVertical: { ...state.resize.timelineVertical },
          },
        };
      }

      if (panel == "preview") {
        // `criteria` is the second divider: the option column is everything to
        // its right, and the preview is what is left between the two dividers.
        const panelPer = state.resize.horizontal.panel;
        const divider = clamp(
          criteria,
          Math.max(
            panelPer + HORIZONTAL_LIMITS.preview.min,
            100 - HORIZONTAL_LIMITS.option.max,
          ),
          100 - HORIZONTAL_LIMITS.option.min,
        );

        return {
          resize: {
            chatSidebar: state.resize.chatSidebar,

            vertical: { ...state.resize.vertical },
            horizontal: {
              panel: panelPer,
              preview: divider - panelPer,
              option: 100 - divider,
            },
            timelineVertical: { ...state.resize.timelineVertical },
          },
        };
      }

      return {
        ...state,
      };
    }),
}));
