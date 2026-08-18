import { describe, it, expect, beforeEach } from "vitest";
import { useTimelineStore } from "./timelineStore";

describe("timelineStore.updateTimeline", () => {
  beforeEach(() => {
    useTimelineStore.getState().patchTimeline({
      v1: {
        filetype: "video",
        priority: 1,
        trim: { startTime: 0, endTime: 1000 },
        location: { x: 10, y: 20 },
      },
    });
  });

  it("updates a nested leaf immutably", () => {
    const before = useTimelineStore.getState().timeline;
    useTimelineStore.getState().updateTimeline("v1", ["trim", "endTime"], 500);
    const after = useTimelineStore.getState().timeline;

    expect(after.v1.trim.endTime).toBe(500);
    // new references along the changed path
    expect(after).not.toBe(before);
    expect(after.v1).not.toBe(before.v1);
    expect(after.v1.trim).not.toBe(before.v1.trim);
  });

  it("preserves sibling references not on the changed path", () => {
    const before = useTimelineStore.getState().timeline;
    const locationRef = before.v1.location;
    useTimelineStore.getState().updateTimeline("v1", ["trim", "endTime"], 500);
    const after = useTimelineStore.getState().timeline;

    // untouched nested object keeps identity — the old reducer broke this
    expect(after.v1.location).toBe(locationRef);
  });

  it("does not mutate the previous snapshot (safe undo history)", () => {
    const before = useTimelineStore.getState().timeline;
    useTimelineStore.getState().updateTimeline("v1", ["trim", "endTime"], 500);
    // the captured prior snapshot is unchanged
    expect(before.v1.trim.endTime).toBe(1000);
  });
});
