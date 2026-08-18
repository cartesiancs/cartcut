import { createStore } from "zustand/vanilla";
import {
  clampZoom,
  fitViewport,
  type Viewport,
} from "../features/preview/viewport";

/**
 * Pan/zoom of the preview surface.
 *
 * Session-only on purpose: this is where the user is looking, not part of the
 * project, so `functions/project.ts` deliberately does not serialise it into
 * the `.ngt` file.
 */
export interface IPreviewViewportStore {
  viewport: Viewport;
  setViewport: (viewport: Viewport) => void;
  /** Re-zoom about the viewport centre. */
  setZoom: (zoom: number) => void;
  /** Slide the view by a world-space delta. */
  panByWorld: (dx: number, dy: number) => void;
  /** Whole frame visible, centred. */
  fit: (frameW: number, frameH: number) => void;
}

export const previewViewportStore = createStore<IPreviewViewportStore>(
  (set) => ({
    viewport: fitViewport(1920, 1080),

    setViewport: (viewport: Viewport) => set(() => ({ viewport })),

    setZoom: (zoom: number) =>
      set((state) => ({
        viewport: { ...state.viewport, zoom: clampZoom(zoom) },
      })),

    panByWorld: (dx: number, dy: number) =>
      set((state) => ({
        viewport: {
          zoom: state.viewport.zoom,
          center: {
            x: state.viewport.center.x + dx,
            y: state.viewport.center.y + dy,
          },
        },
      })),

    fit: (frameW: number, frameH: number) =>
      set(() => ({ viewport: fitViewport(frameW, frameH) })),
  }),
);
