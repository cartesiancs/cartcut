/**
 * Whether the extension host is running, as the editor sees it.
 *
 * A mirror of main's session state rather than a second copy of the rules:
 * `electron/extension/session.ts` decides when to restart and when to give up,
 * and this holds whatever it last said so the UI can draw it. Nothing here
 * decides anything, which is why there is no reducer.
 */

import { createStore } from "zustand/vanilla";

export type HostStateName =
  | "idle"
  | "starting"
  | "ready"
  | "degraded"
  | "restarting"
  | "stopped";

export interface IHostStateStore {
  state: HostStateName;
  crashes: number;
  lastError: string | null;
  report: (state: string, crashes: number, lastError: string | null) => void;
}

export const hostStateStore = createStore<IHostStateStore>((set) => ({
  state: "idle",
  crashes: 0,
  lastError: null,

  report: (state, crashes, lastError) =>
    set((current) => {
      // Identity on no change, the rule every store here follows: the state is
      // republished on every page load and on every transition, and most of
      // those transitions say the same thing twice.
      if (current.state === state && current.crashes === crashes && current.lastError === lastError) {
        return current;
      }
      return { ...current, state: state as HostStateName, crashes, lastError };
    }),
}));

export interface HostNotice {
  /** One word: what the host is doing. */
  label: string;
  /** Why, when main said. */
  detail: string | null;
  /** Whether a restart button belongs beside it: not while one is under way. */
  restartable: boolean;
}

/** What the Extensions panel's notice shows. Null when there is nothing to say. */
export function hostNotice(state: IHostStateStore): HostNotice | null {
  if (state.state === "restarting") {
    return { label: "Restarting", detail: state.lastError, restartable: false };
  }
  if (state.state === "degraded") {
    return { label: "Stopped", detail: state.lastError, restartable: true };
  }
  return null;
}
