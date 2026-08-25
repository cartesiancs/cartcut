/**
 * What is selected on the timeline, and what was last copied from it.
 *
 * Both of these used to be plain fields on `element-timeline-canvas` — the
 * selection a public `targetId`, the clipboard a private one. That worked while
 * the canvas was the only thing that edited, but nothing else could *watch*
 * them: a toolbar cannot grey out "merge" when a plain property changes, and
 * the agent's `select_clips` had to reach through the DOM and then call
 * `drawCanvas()` by hand because writing the field notified no one.
 *
 * They live here so there is one answer to "what is selected", shared by the
 * canvas, the toolbar, and the agent bridge. The canvas keeps its `targetId`
 * name as an accessor onto this store, so the forty-odd call sites inside it —
 * and the two agent commands that reach for it — read exactly as they did.
 *
 * The clipboard is deliberately app-internal and not `navigator.clipboard`:
 * these are live element objects with ids, trims and parent links, not text,
 * and `pasteClips` remaps all of that on the way back in.
 */

import { createStore } from "zustand/vanilla";
import type { TimelineElement } from "../@types/timeline";

export interface ISelectionStore {
  /** Element ids the user has selected, in the order they were picked. */
  ids: string[];

  /**
   * The last cut or copied clips, keyed by their *original* id.
   *
   * `pasteClips` uses those keys to rebuild `parentId` links between clips that
   * were copied together, so they are not dead weight.
   */
  clipboard: Record<string, TimelineElement>;

  setIds: (ids: string[]) => void;
  clear: () => void;
  setClipboard: (clipboard: Record<string, TimelineElement>) => void;
}

/**
 * Whether two selections name the same clips in the same order.
 *
 * The canvas reassigns `targetId` on every hit-test, including the ones a drag
 * produces at pointer rate, and most of those land on the clip that was already
 * selected. Without this guard each of them would wake every subscriber and
 * repaint the canvas — the store would be doing the churning that moving drags
 * onto `previewDocument` was meant to stop.
 */
function sameIds(a: string[], b: string[]): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  return a.every((id, index) => id === b[index]);
}

export const selectionStore = createStore<ISelectionStore>((set, get) => ({
  ids: [],
  clipboard: {},

  // Both writers check before calling `set` rather than returning an empty
  // partial from it. Zustand treats `{}` as a state change — it merges into a
  // fresh object and notifies — so returning `{}` would repaint on every
  // no-op, which is the whole thing these guards exist to prevent.
  setIds: (ids) => {
    if (sameIds(get().ids, ids)) {
      return;
    }
    set({ ids: [...ids] });
  },

  clear: () => {
    if (get().ids.length === 0) {
      return;
    }
    set({ ids: [] });
  },

  setClipboard: (clipboard) => set({ clipboard }),
}));
