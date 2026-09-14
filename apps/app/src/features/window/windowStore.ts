/**
 * The open windows, and how big each host region is.
 *
 * A vanilla zustand store in the shape `previewViewportStore.ts` uses: the
 * interface lists state and actions together, the bounds live in the pure
 * module rather than here, and components hold `getInitialState()` and
 * subscribe from `createRenderRoot`.
 *
 * It lives under `features/window/` rather than in `states/` because every
 * action is one line over `windowOps.ts` and splitting the two across
 * directories would put the store a long way from the rules it enforces.
 * `states/` holds the stores the whole app reads; this one has one caller.
 *
 * ## Every action returns `state` itself when its op declined
 *
 * zustand's `setState` skips the notification only when the updater returns the
 * **same object**, so a decline has to be `return state` and not `return {}`.
 * Returning an empty partial builds a fresh state object, and every subscriber
 * wakes for a write that changed nothing. That is not theoretical here: the
 * splitter resolves on `mousemove`, so at the display rate, and it spends most
 * of a drag clamped against a limit where `resolveWindowDrag` declines.
 */

import { createStore } from "zustand/vanilla";

import {
  layoutHost,
  type DockSide,
  type HostLayout,
  type Rect,
  type Size,
  type WindowPlacement,
  type WindowState,
} from "./windowLayout";
import {
  closeWindow,
  dockWindow,
  floatWindow,
  focusWindow,
  openWindow,
  setPlacement,
  windowsOfHost,
  type WindowSpec,
} from "./windowOps";

export interface IWindowStore {
  windows: WindowState[];
  /**
   * What each host region measures, in px, keyed by `hostId`.
   *
   * Written by `<window-host>`'s ResizeObserver and read by nothing else in the
   * store. It is here rather than on the component because `layoutHost` needs
   * it and the windows that consume the layout are the host's siblings in the
   * template, not its children.
   */
  hostSizes: Record<string, Size>;

  open: (spec: WindowSpec) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
  place: (id: string, placement: WindowPlacement) => void;
  dock: (id: string, side: DockSide) => void;
  float: (id: string, rect: Rect) => void;
  measureHost: (hostId: string, size: Size) => void;
}

export const windowStore = createStore<IWindowStore>((set) => ({
  windows: [],
  hostSizes: {},

  open: (spec) =>
    set((state) => {
      const windows = openWindow(state.windows, spec);
      return windows === state.windows ? state : { ...state, windows };
    }),

  close: (id) =>
    set((state) => {
      const windows = closeWindow(state.windows, id);
      return windows === state.windows ? state : { ...state, windows };
    }),

  focus: (id) =>
    set((state) => {
      const windows = focusWindow(state.windows, id);
      return windows === state.windows ? state : { ...state, windows };
    }),

  place: (id, placement) =>
    set((state) => {
      const windows = setPlacement(state.windows, id, placement);
      return windows === state.windows ? state : { ...state, windows };
    }),

  dock: (id, side) =>
    set((state) => {
      const windows = dockWindow(state.windows, id, side);
      return windows === state.windows ? state : { ...state, windows };
    }),

  float: (id, rect) =>
    set((state) => {
      const windows = floatWindow(state.windows, id, rect);
      return windows === state.windows ? state : { ...state, windows };
    }),

  measureHost: (hostId, size) =>
    set((state) => {
      const current = state.hostSizes[hostId];
      // A ResizeObserver fires on observation and on any layout pass that
      // touched the box, including ones that left it the same size. Without
      // this compare, every unrelated re-render of the preview column would
      // re-lay out every window in it.
      if (current != null && current.width === size.width && current.height === size.height) {
        return state;
      }
      return { ...state, hostSizes: { ...state.hostSizes, [hostId]: size } };
    }),
}));

/** The layout for one host, from whatever the store currently holds. */
export function hostLayout(state: IWindowStore, hostId: string): HostLayout {
  const size = state.hostSizes[hostId] ?? { width: 0, height: 0 };
  return layoutHost(size, windowsOfHost(state.windows, hostId));
}
