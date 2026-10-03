import { describe, expect, it } from "vitest";

import { hostNotice, type HostStateName, type IHostStateStore } from "./hostState";

function at(state: HostStateName, lastError: string | null = null): IHostStateStore {
  return { state, crashes: 0, lastError, report: () => {} };
}

describe("hostNotice", () => {
  it("says nothing while the host is fine or deliberately stopped", () => {
    for (const state of ["idle", "starting", "ready", "stopped"] as const) {
      expect(hostNotice(at(state, "old error"))).toBeNull();
    }
  });

  it("offers no restart while one is already under way", () => {
    expect(hostNotice(at("restarting", "exit code 1"))).toEqual({
      label: "Restarting",
      detail: "exit code 1",
      restartable: false,
    });
  });

  it("offers a restart once main has given up", () => {
    expect(hostNotice(at("degraded"))).toEqual({
      label: "Stopped",
      detail: null,
      restartable: true,
    });
  });
});
