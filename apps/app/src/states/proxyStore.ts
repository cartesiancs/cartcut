/**
 * Which sources have a proxy, and whether the preview should be using them.
 *
 * Deliberately a **side table keyed by `localpath`**, never a field on the
 * element. That is the same rule the relative-path feature follows and for the
 * same reason: a path on the element would enter `normalizeDocument`, every
 * undo snapshot and the agent serializer, and would go stale the moment
 * `localpath` changed. It also has no business in a `.ngt` — a proxy is derived
 * media that any machine can regenerate, and both Final Cut and Resolve treat
 * derived media as regenerable rather than as part of the project.
 *
 * The mode follows Final Cut's three-way switch rather than a checkbox, because
 * "use proxies" and "tell me when one is missing" are different questions:
 *
 *   - **`off`** — always decode the original.
 *   - **`prefer`** — use a proxy where one exists, fall back to the original
 *     silently. This is the default and the one people want.
 *
 * FCP's third position, *Proxy Only*, is deliberately not offered: its purpose
 * is working with the originals disconnected, and this app has no relink flow
 * to recover from the placeholder it would show.
 */

import { createStore } from "zustand/vanilla";

export type ProxyEntry = {
  source: string;
  proxy: string;
  width: number;
  height: number;
  fps: number;
};

export type ProxyMode = "off" | "prefer";

export type ProxyProgress = {
  source: string;
  fraction: number | null;
  index: number;
  total: number;
};

export interface IProxyStore {
  mode: ProxyMode;
  /** Absolute source path → the proxy standing in for it. */
  bySource: Record<string, ProxyEntry>;
  /** Non-null while a generation pass is running. */
  progress: ProxyProgress | null;

  setMode: (mode: ProxyMode) => void;
  setEntries: (bySource: Record<string, ProxyEntry>) => void;
  setProgress: (progress: ProxyProgress | null) => void;
}

export const proxyStore = createStore<IProxyStore>((set, get) => ({
  mode: "prefer",
  bySource: {},
  progress: null,

  // Guarded before `set`, like `selectionStore` — every subscriber to this
  // store repaints, and re-selecting the mode already in force is a no-op the
  // user can produce by clicking the same menu item twice.
  setMode: (mode) => {
    if (get().mode === mode) {
      return;
    }
    set({ mode });
  },

  setEntries: (bySource) => set({ bySource }),

  setProgress: (progress) => {
    const current = get().progress;
    if (
      current?.source === progress?.source &&
      current?.fraction === progress?.fraction
    ) {
      return;
    }
    set({ progress });
  },
}));

/**
 * The file the preview should decode for this source.
 *
 * The **only** place the substitution is decided. Returns `localpath` unchanged
 * whenever proxies are off, or none exists for this source — which is the same
 * contract a missing LUT has, and it is what makes the feature impossible to
 * half-apply: nothing downstream needs to know a proxy was involved.
 */
export function playbackPathFor(localpath: string): string {
  const state = proxyStore.getState();
  if (state.mode === "off") {
    return localpath;
  }
  return state.bySource[localpath]?.proxy ?? localpath;
}
