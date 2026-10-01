import { beforeEach, describe, expect, it } from "vitest";
import {
  effectiveTrackHeights,
  timelineViewEntryText,
  timelineViewExtraEntries,
  trackHeightStore,
} from "./trackHeightStore";
import { TIMELINE_VIEW_ENTRY } from "../features/project/timelineView";
import { MAX_TRACK_HEIGHT } from "../features/timeline/trackHeights";

const store = () => trackHeightStore.getState();
const TRACKS = [{ id: "v1" }, { id: "v2" }];

/** Counts notifications, so a no-op write can be shown to wake nobody. */
function notifications(): { count: () => number; stop: () => void } {
  let n = 0;
  const stop = trackHeightStore.subscribe(() => {
    n++;
  });
  return { count: () => n, stop };
}

beforeEach(() => {
  trackHeightStore.setState(trackHeightStore.getInitialState(), true);
});

describe("trackHeightStore", () => {
  it("draws a preview without keeping it", () => {
    store().preview("v1", 90);
    expect(store().live).toEqual({ trackId: "v1", px: 90 });
    expect(store().heights).toEqual({});
    expect(effectiveTrackHeights()).toEqual({ v1: 90 });
  });

  it("keeps the preview on commit", () => {
    store().preview("v1", 90);
    store().commit();
    expect(store().live).toBeNull();
    expect(store().heights).toEqual({ v1: 90 });
  });

  it("drops the preview on cancel", () => {
    store().preview("v1", 90);
    store().cancel();
    expect(store().live).toBeNull();
    expect(store().heights).toEqual({});
    expect(effectiveTrackHeights()).toEqual({});
  });

  it("clamps what it is given", () => {
    store().preview("v1", 9999);
    expect(store().live?.px).toBe(MAX_TRACK_HEIGHT);
  });

  it("notifies nobody for a write that changes nothing", () => {
    store().preview("v1", 90);
    const seen = notifications();
    store().preview("v1", 90);
    store().preview("v1", 90.3);
    seen.stop();
    store().cancel();

    const idle = notifications();
    store().cancel();
    store().commit();
    store().reset("v2");
    store().replace({});
    idle.stop();

    expect(seen.count()).toBe(0);
    expect(idle.count()).toBe(0);
  });

  it("keeps `heights` by identity when a resize ends where it began", () => {
    // Auto Save gates on this identity: a drag that went nowhere is no change.
    store().replace({ v1: 70 });
    const before = store().heights;
    store().preview("v1", 120);
    store().preview("v1", 70);
    store().commit();
    expect(store().heights).toBe(before);
  });

  it("resets a row to the default by deleting its entry", () => {
    store().replace({ v1: 70, v2: 90 });
    store().reset("v1");
    expect(store().heights).toEqual({ v2: 90 });
  });

  it("drops a preview of the row being reset", () => {
    store().preview("v1", 90);
    store().reset("v1");
    expect(store().live).toBeNull();
  });

  it("replaces everything on load, the preview included", () => {
    store().replace({ v1: 70 });
    store().preview("v2", 90);
    store().replace({ x: 60 });
    expect(store().heights).toEqual({ x: 60 });
    expect(store().live).toBeNull();
  });

  it("hands the layout the same object while nothing changes", () => {
    store().preview("v1", 90);
    const first = effectiveTrackHeights();
    expect(effectiveTrackHeights()).toBe(first);
    store().preview("v1", 91);
    expect(effectiveTrackHeights()).not.toBe(first);
  });
});

describe("the .ngt entry", () => {
  it("never writes a preview", () => {
    store().preview("v1", 90);
    expect(timelineViewEntryText(TRACKS)).toBeNull();
    expect(timelineViewExtraEntries(TRACKS)).toEqual({});
  });

  it("writes kept heights for rows that exist", () => {
    store().replace({ v1: 90, orphan: 60 });
    const extra = timelineViewExtraEntries(TRACKS);
    expect(Object.keys(extra)).toEqual([TIMELINE_VIEW_ENTRY]);
    expect(JSON.parse(extra[TIMELINE_VIEW_ENTRY]).trackHeights).toEqual({
      v1: 90,
    });
  });

  it("keeps a deleted row's height in memory, so undoing the delete restores it", () => {
    store().replace({ v1: 90 });
    // The row is gone from the timeline: nothing to save...
    expect(timelineViewEntryText([{ id: "v2" }])).toBeNull();
    // ...and once undo brings it back, its height is still there.
    expect(timelineViewEntryText(TRACKS)).not.toBeNull();
    expect(store().heights).toEqual({ v1: 90 });
  });
});
