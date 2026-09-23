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

/** The sentence the notice shows. Null when there is nothing to say. */
export function hostStateMessage(state: IHostStateStore): string | null {
  if (state.state === "ready" || state.state === "idle" || state.state === "starting") {
    return null;
  }
  if (state.state === "restarting") {
    return "Extensions stopped and are restarting" + (state.lastError == null ? "." : ": " + state.lastError);
  }
  if (state.state === "degraded") {
    return (
      "Extensions have stopped" +
      (state.lastError == null ? "." : ": " + state.lastError) +
      " Your project is untouched."
    );
  }
  return null;
}
