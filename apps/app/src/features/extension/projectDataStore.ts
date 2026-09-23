/**
 * Per-project extension data, while the project is open.
 *
 * A store of its own rather than a field on `TimelineDocument`, because it is
 * not part of the edit: changing it is not undoable, and an undo that reverted
 * an extension's bookkeeping alongside a clip move would be surprising in both
 * directions. It is saved with the project and it makes the project dirty,
 * which is the whole of its relationship to the document.
 *
 * Vanilla zustand in the shape the rest of `states/` uses, including the rule
 * that a write which changes nothing returns `state` by identity: Auto Save
 * subscribes to this, and a no-op write would re-arm its timers.
 */

import { createStore } from "zustand/vanilla";

import { serializeExtensionsEntry, withProjectData, type ProjectExtensionData } from "./projectData";
import type { JsonValue } from "../../@types/timeline";

export interface IProjectDataStore {
  data: ProjectExtensionData;
  /** Load: replaces everything, for a project that was just opened. */
  replace: (data: ProjectExtensionData) => void;
  set: (extId: string, value: JsonValue | null) => { ok: boolean; reason?: string };
}

export const projectDataStore = createStore<IProjectDataStore>((set, get) => ({
  data: {},

  replace: (data) =>
    set((state) => {
      if (JSON.stringify(state.data) === JSON.stringify(data)) {
        return state;
      }
      return { ...state, data };
    }),

  set: (extId, value) => {
    const result = withProjectData(get().data, extId, value);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    set((state) => (result.data === state.data ? state : { ...state, data: result.data }));
    return { ok: true };
  },
}));

/** The `.ngt` entry, or `null` when no extension has stored anything. */
export function extensionsEntryText(): string | null {
  return serializeExtensionsEntry(projectDataStore.getState().data);
}

/** What the save path passes to `buildNgtBlob`. Empty when there is nothing. */
export function extensionsExtraEntries(): Record<string, string> {
  const text = extensionsEntryText();
  return text == null ? {} : { "extensions.json": text };
}
