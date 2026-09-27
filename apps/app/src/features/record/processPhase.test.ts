import { describe, it, expect } from "vitest";
import { advances, processView, IDLE, type ProcessStage } from "./processPhase";

describe("processView", () => {
  it("is closed only when there is nothing happening", () => {
    expect(processView(IDLE).open).toBe(false);
    for (const stage of ["finishing", "reading", "planning", "placing", "failed"] as const) {
      expect(processView({ stage }).open).toBe(true);
    }
  });

  it("spins rather than lying about the mux", () => {
    // FFmpeg is copying a stream whose length nobody measured, so any number would
    // be invented.
    expect(processView({ stage: "finishing" }).percent).toBeNull();
    expect(processView({ stage: "reading" }).percent).toBeGreaterThan(0);
  });

  it("never moves the bar backwards", () => {
    const order: ProcessStage[] = ["reading", "planning", "placing", "done"];
    let previous = -1;
    for (const stage of order) {
      const percent = processView({ stage }).percent ?? 0;
      expect(percent).toBeGreaterThan(previous);
      previous = percent;
    }
  });

  it("offers a way out only while there is something to abandon", () => {
    // Not during the mux: the recording is still being written.
    expect(processView({ stage: "finishing" }).cancellable).toBe(false);
    expect(processView({ stage: "reading" }).cancellable).toBe(true);
    // ...and not once the edit is being committed, which would leave half of it.
    expect(processView({ stage: "placing" }).cancellable).toBe(false);
  });

  it("prefers a real failure message to the generic line", () => {
    const view = processView({ stage: "failed", message: "The input log was empty." });
    expect(view.detail).toBe("The input log was empty.");
    expect(view.failed).toBe(true);

    expect(processView({ stage: "failed" }).detail.length).toBeGreaterThan(0);
  });
});

describe("advances", () => {
  // Two producers that are not ordered against each other: main pushes the mux
  // notice, the editor drives the rest. A `complete` that overtakes its own notice
  // must not walk the dialog back to the start and leave it open forever.
  it("moves forward and refuses to move back", () => {
    expect(advances("finishing", "reading")).toBe(true);
    expect(advances("reading", "placing")).toBe(true);
    expect(advances("placing", "finishing")).toBe(false);
    expect(advances("planning", "reading")).toBe(false);
  });

  it("refuses to stand still", () => {
    for (const stage of ["finishing", "reading", "planning", "placing"] as const) {
      expect(advances(stage, stage)).toBe(false);
    }
  });

  it("lets anything unfinished fail, and nothing finished", () => {
    expect(advances("planning", "failed")).toBe(true);
    expect(advances("done", "failed")).toBe(false);
  });

  it("lets a new recording start after a failure, but not resume mid-way", () => {
    expect(advances("failed", "finishing")).toBe(true);
    expect(advances("failed", "done")).toBe(true);
    expect(advances("failed", "planning")).toBe(false);
  });
});
