import { describe, expect, it } from "vitest";

import {
  BACKOFF_MS,
  CRASH_BUDGET,
  CRASH_WINDOW_MS,
  initialHostSession,
  isHostUsable,
  reduceHost,
  type HostEvent,
  type HostSession,
} from "./session";

function run(events: HostEvent[], from: HostSession = initialHostSession()): HostSession {
  return events.reduce(reduceHost, from);
}

describe("reduceHost", () => {
  it("walks idle to ready", () => {
    const session = run([
      { type: "fork", at: 0 },
      { type: "ready", at: 10 },
    ]);
    expect(session.state).toBe("ready");
    expect(isHostUsable(session)).toBe(true);
  });

  it("restarts with a growing wait as crashes repeat", () => {
    let session = run([
      { type: "fork", at: 0 },
      { type: "ready", at: 1 },
    ]);
    const delays: number[] = [];

    for (let crash = 0; crash < BACKOFF_MS.length; crash += 1) {
      session = reduceHost(session, { type: "exit", at: 100 + crash, code: 1 });
      delays.push(session.restartDelayMs);
      expect(session.state).toBe("restarting");
      session = run(
        [
          { type: "fork", at: 200 + crash },
          { type: "ready", at: 201 + crash },
        ],
        session,
      );
    }

    expect(delays).toEqual(BACKOFF_MS);
  });

  it("stays down once the budget is spent", () => {
    let session = run([
      { type: "fork", at: 0 },
      { type: "ready", at: 1 },
    ]);
    for (let crash = 0; crash <= CRASH_BUDGET; crash += 1) {
      session = reduceHost(session, { type: "exit", at: 100 + crash, code: 1, error: "boom" });
      if (session.state === "restarting") {
        session = run([{ type: "fork", at: 150 + crash }, { type: "ready", at: 151 + crash }], session);
      }
    }
    expect(session.state).toBe("degraded");
    expect(session.lastError).toBe("boom");
  });

  it("forgets a crash that has aged out of the window", () => {
    let session = run([{ type: "fork", at: 0 }, { type: "ready", at: 1 }]);
    session = reduceHost(session, { type: "exit", at: 1_000, code: 1 });
    session = run([{ type: "fork", at: 1_100 }, { type: "ready", at: 1_101 }], session);

    const later = CRASH_WINDOW_MS + 2_000;
    session = reduceHost(session, { type: "exit", at: later, code: 1 });

    // One crash, not two: the first is older than the window, so the wait is
    // the first backoff again rather than the second.
    expect(session.crashes).toHaveLength(1);
    expect(session.restartDelayMs).toBe(BACKOFF_MS[0]);
  });

  it("does not count the exit that follows a stop", () => {
    // Otherwise every quit spends a crash and the next launch opens degraded.
    const session = run([
      { type: "fork", at: 0 },
      { type: "ready", at: 1 },
      { type: "stop", at: 2 },
      { type: "exit", at: 3, code: 0 },
    ]);
    expect(session.state).toBe("stopped");
    expect(session.crashes).toHaveLength(0);
  });

  it("treats a dev reload as free", () => {
    let session = run([{ type: "fork", at: 0 }, { type: "ready", at: 1 }]);
    for (let i = 0; i < 10; i += 1) {
      session = reduceHost(session, { type: "reload", at: 100 + i });
      session = run([{ type: "fork", at: 200 + i }, { type: "ready", at: 201 + i }], session);
    }
    expect(session.state).toBe("ready");
    expect(session.crashes).toHaveLength(0);
  });

  it("clears the budget when a person presses Restart", () => {
    let session = run([{ type: "fork", at: 0 }, { type: "ready", at: 1 }]);
    for (let crash = 0; crash <= CRASH_BUDGET; crash += 1) {
      session = reduceHost(session, { type: "exit", at: 100 + crash, code: 1 });
      if (session.state === "restarting") {
        session = run([{ type: "fork", at: 150 + crash }, { type: "ready", at: 151 + crash }], session);
      }
    }
    expect(session.state).toBe("degraded");

    session = reduceHost(session, { type: "restart", at: 900 });
    expect(session.state).toBe("restarting");
    expect(session.crashes).toHaveLength(0);
    expect(session.restartDelayMs).toBe(0);
  });

  it("declines by identity when an event does not apply", () => {
    const ready = run([{ type: "fork", at: 0 }, { type: "ready", at: 1 }]);
    // A second `ready` is not a state change, and returning a fresh object
    // would wake every subscriber of whatever holds this.
    expect(reduceHost(ready, { type: "ready", at: 2 })).toBe(ready);
    expect(reduceHost(ready, { type: "fork", at: 3 })).toBe(ready);
  });

  it("stops from every state", () => {
    const states: HostSession[] = [
      initialHostSession(),
      run([{ type: "fork", at: 0 }]),
      run([{ type: "fork", at: 0 }, { type: "ready", at: 1 }]),
      run([{ type: "fork", at: 0 }, { type: "ready", at: 1 }, { type: "exit", at: 2, code: 1 }]),
    ];
    for (const session of states) {
      expect(reduceHost(session, { type: "stop", at: 99 }).state).toBe("stopped");
    }
  });
});
