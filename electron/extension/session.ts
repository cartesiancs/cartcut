/**
 * When the extension host restarts, when it gives up, and how long it waits.
 *
 * A pure reducer rather than flags on `host.ts`, for the reason
 * `features/project/autosaveSession.ts` is one: the interesting part is the
 * ordering, the ordering is what breaks, and a reducer can be driven through
 * every ordering in a test without an Electron process anywhere.
 *
 * The rule the whole file exists to enforce: **a crash loop must stop.** An
 * extension that faults during activation faults again on the next fork, and
 * without a budget the app would spend the rest of the session forking a
 * process that dies, at whatever rate the machine allows. So crashes inside a
 * window are counted, each restart waits longer than the last, and when the
 * budget is spent the host stays down until a person asks for it, with the
 * error in front of them.
 */

export type HostState = "idle" | "starting" | "ready" | "degraded" | "restarting" | "stopped";

export type HostSession = {
  state: HostState;
  /** Timestamps of crashes still inside the window. Older ones are dropped. */
  crashes: number[];
  lastError: string | null;
  /** What `host.ts` should wait before the next fork. Zero for a user restart. */
  restartDelayMs: number;
};

export type HostEvent =
  | { type: "fork"; at: number }
  | { type: "ready"; at: number }
  | { type: "exit"; at: number; code: number | null; error?: string }
  /** An unpacked extension changed on disk. Not a crash, so no backoff. */
  | { type: "reload"; at: number }
  /** A person pressed Restart. Clears the budget: they have seen the error. */
  | { type: "restart"; at: number }
  | { type: "stop"; at: number };

/** How long a crash counts against the budget. */
export const CRASH_WINDOW_MS = 5 * 60_000;
/** Crashes inside the window before the host stays down. */
export const CRASH_BUDGET = 3;
/**
 * Waits between automatic restarts, by how many crashes have happened.
 *
 * The first is short because the overwhelmingly likely cause is one bad
 * extension activating, and the user should see the host come back before
 * they notice it went. The last is long because by then the cause is probably
 * not transient and a tight loop would burn a core for nothing.
 */
export const BACKOFF_MS = [1_000, 5_000, 30_000];

export function initialHostSession(): HostSession {
  return { state: "idle", crashes: [], lastError: null, restartDelayMs: 0 };
}

export function reduceHost(session: HostSession, event: HostEvent): HostSession {
  switch (event.type) {
    case "fork": {
      if (session.state !== "idle" && session.state !== "restarting") {
        return session;
      }
      return { ...session, state: "starting" };
    }

    case "ready": {
      if (session.state !== "starting") {
        return session;
      }
      return { ...session, state: "ready", lastError: null, restartDelayMs: 0 };
    }

    case "exit": {
      // A process that exits after `stop` did what it was told. Counting that
      // as a crash would spend the budget every time the app quits, and the
      // next launch would open straight into a degraded host.
      if (session.state === "stopped" || session.state === "idle") {
        return session;
      }

      const crashes = [...session.crashes, event.at].filter(
        (at) => event.at - at < CRASH_WINDOW_MS,
      );
      const error = event.error ?? "extension host exited with code " + String(event.code);

      if (crashes.length > CRASH_BUDGET) {
        return { state: "degraded", crashes, lastError: error, restartDelayMs: 0 };
      }

      const delay = BACKOFF_MS[Math.min(crashes.length, BACKOFF_MS.length) - 1];
      return { state: "restarting", crashes, lastError: error, restartDelayMs: delay };
    }

    case "reload": {
      if (session.state === "stopped") {
        return session;
      }
      // Not a crash: the developer saved a file. Keeping the budget intact
      // means an afternoon of editing an unpacked extension cannot leave the
      // host degraded with no crash ever having happened.
      return { ...session, state: "restarting", restartDelayMs: 0, lastError: null };
    }

    case "restart": {
      if (session.state === "stopped") {
        return session;
      }
      return { state: "restarting", crashes: [], lastError: null, restartDelayMs: 0 };
    }

    case "stop": {
      if (session.state === "stopped") {
        return session;
      }
      return { ...session, state: "stopped", restartDelayMs: 0 };
    }

    default:
      return session;
  }
}

/** Whether the host is in a state where a request could be answered. */
export function isHostUsable(session: HostSession): boolean {
  return session.state === "ready";
}
