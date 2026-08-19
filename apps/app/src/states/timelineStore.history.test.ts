import { describe, it, expect, beforeEach } from "vitest";
import { HISTORY_LIMIT, useTimelineStore } from "./timelineStore";
import {
  SCHEMA_VERSION,
  appendTrackOfKind,
  createTrack,
  type TimelineDocument,
} from "../features/timeline/tracks";
import { imageElement } from "../features/renderer/testing";

const store = () => useTimelineStore.getState();

function reset() {
  useTimelineStore.setState({
    timeline: {},
    tracks: [],
    history: { timelineHistory: [], historyNow: -1 },
  });
}

function docWith(elements: Record<string, any>): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("t0", "video", 0)],
    elements,
  };
}

describe("timelineStore history", () => {
  beforeEach(reset);

  it("records a step only when the transform changes something", () => {
    // The pure ops return their input untouched when they decline, so an
    // out-of-bounds split must not burn an undo step.
    store().withCheckpoint(() => docWith({ a: imageElement({ trackId: "t0" }) }));
    expect(store().history.timelineHistory).toHaveLength(1);

    store().withCheckpoint((doc) => doc);
    expect(store().history.timelineHistory).toHaveLength(1);
  });

  it("steps back and forward through edits", () => {
    store().withCheckpoint(() => docWith({ a: imageElement({ trackId: "t0" }) }));
    store().withCheckpoint(() =>
      docWith({
        a: imageElement({ trackId: "t0" }),
        b: imageElement({ trackId: "t0", startTime: 1000 }),
      }),
    );

    expect(Object.keys(store().timeline).sort()).toEqual(["a", "b"]);

    store().rollbackTimelineFromCheckPoint(-1);
    expect(Object.keys(store().timeline)).toEqual(["a"]);

    store().rollbackTimelineFromCheckPoint(1);
    expect(Object.keys(store().timeline).sort()).toEqual(["a", "b"]);
  });

  it("drops the redo branch once you edit after undoing", () => {
    // Pushing used to append without truncating, leaving an abandoned future
    // that redo would happily walk back into.
    store().withCheckpoint(() => docWith({ a: imageElement({ trackId: "t0" }) }));
    store().withCheckpoint(() => docWith({ b: imageElement({ trackId: "t0" }) }));
    store().rollbackTimelineFromCheckPoint(-1);

    store().withCheckpoint(() => docWith({ c: imageElement({ trackId: "t0" }) }));

    expect(store().history.timelineHistory).toHaveLength(2);
    expect(store().history.historyNow).toBe(1);

    // Redo must not resurrect "b".
    store().rollbackTimelineFromCheckPoint(1);
    expect(Object.keys(store().timeline)).toEqual(["c"]);
  });

  it("refuses to step past either end", () => {
    store().withCheckpoint(() => docWith({ a: imageElement({ trackId: "t0" }) }));

    store().rollbackTimelineFromCheckPoint(-1);
    expect(store().history.historyNow).toBe(0);
    expect(Object.keys(store().timeline)).toEqual(["a"]);

    store().rollbackTimelineFromCheckPoint(1);
    expect(store().history.historyNow).toBe(0);
  });

  it("keeps historyNow consistent when the cap overflows", () => {
    // `shift()` used to drop the oldest entry without moving `historyNow`, so
    // every later undo silently landed one step off.
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      store().withCheckpoint(() =>
        docWith({ [`e${i}`]: imageElement({ trackId: "t0" }) }),
      );
    }

    const { timelineHistory, historyNow } = store().history;
    expect(timelineHistory).toHaveLength(HISTORY_LIMIT);
    expect(historyNow).toBe(HISTORY_LIMIT - 1);

    // The entry under the cursor is still the latest edit.
    expect(Object.keys(timelineHistory[historyNow].elements)).toEqual([
      `e${HISTORY_LIMIT + 4}`,
    ]);

    store().rollbackTimelineFromCheckPoint(-1);
    expect(Object.keys(store().timeline)).toEqual([`e${HISTORY_LIMIT + 3}`]);
  });

  it("restores the tracks along with the clips", () => {
    // Undoing a move between tracks has to bring the row back too.
    store().withCheckpoint((doc) => appendTrackOfKind(doc, "video", "v1"));
    store().withCheckpoint((doc) => appendTrackOfKind(doc, "text", "t1"));
    expect(store().tracks).toHaveLength(2);

    store().rollbackTimelineFromCheckPoint(-1);
    expect(store().tracks.map((t) => t.id)).toEqual(["v1"]);
  });

  it("does not let a later edit rewrite an earlier snapshot", () => {
    // The old `removeTimeline` deleted straight out of the live object, which
    // every history entry shared.
    store().withCheckpoint(() =>
      docWith({
        a: imageElement({ trackId: "t0" }),
        b: imageElement({ trackId: "t0", startTime: 1000 }),
      }),
    );
    const snapshot = store().history.timelineHistory[0];

    store().removeTimeline("a");

    expect(Object.keys(snapshot.elements).sort()).toEqual(["a", "b"]);
    expect(Object.keys(store().timeline)).toEqual(["b"]);
  });

  it("re-derives priorities on every recorded edit", () => {
    store().withCheckpoint(() => ({
      schemaVersion: SCHEMA_VERSION,
      tracks: [
        createTrack("front", "video", 0),
        createTrack("back", "video", 1),
      ],
      elements: {
        onTop: imageElement({ trackId: "front", priority: 999 }),
        behind: imageElement({ trackId: "back", priority: 1 }),
      },
    }));

    // Top row is front, so it must sort last for the compositor.
    expect(store().timeline.behind.priority).toBe(1);
    expect(store().timeline.onTop.priority).toBe(2);
  });

  it("clears history along with the timeline", () => {
    store().withCheckpoint(() => docWith({ a: imageElement({ trackId: "t0" }) }));
    store().clearTimeline();

    expect(store().history).toEqual({ timelineHistory: [], historyNow: -1 });
    expect(store().tracks).toEqual([]);
  });
});

describe("timelineStore track operations", () => {
  beforeEach(reset);

  it("adds tracks and names them bottom-up", () => {
    store().addTrack("video", "v1");
    store().addTrack("video", "v2");
    expect(store().tracks.map((t) => t.name)).toEqual(["V2", "V1"]);
  });

  it("refuses to delete a track that still holds clips", () => {
    store().addTrack("video", "v1");
    store().patchTimeline({ a: imageElement({ trackId: "v1" }) });

    store().removeTrackById("v1");
    expect(store().tracks).toHaveLength(1);
  });

  it("deletes a track with its clips when asked explicitly", () => {
    // What the track menu's Delete does. The refusing default is right for
    // programmatic callers, but a user who picked "Delete track and 1 clip"
    // has said what they meant, and a button that quietly does nothing reads
    // as broken.
    store().addTrack("video", "v1");
    store().addTrack("video", "v2");
    store().patchTimeline({
      doomed: imageElement({ trackId: "v1" }),
      kept: imageElement({ trackId: "v2" }),
    });

    store().removeTrackById("v1", "delete-clips");

    expect(store().tracks.map((t) => t.id)).toEqual(["v2"]);
    expect(Object.keys(store().timeline)).toEqual(["kept"]);
  });

  it("undoes a track deletion and its clips as one step", () => {
    store().addTrack("video", "v1");
    // Through a checkpoint, the way a real drop or paste arrives — the clip
    // has to be in the recorded history for undo to have anything to restore.
    store().withCheckpoint((doc) => ({
      ...doc,
      elements: { a: imageElement({ trackId: "v1" }) },
    }));

    store().removeTrackById("v1", "delete-clips");
    expect(store().tracks).toHaveLength(0);

    store().rollbackTimelineFromCheckPoint(-1);

    // Both halves come back together, or undo would leave a clip stranded on
    // a track that no longer exists.
    expect(store().tracks.map((t) => t.id)).toEqual(["v1"]);
    expect(store().timeline.a?.trackId).toBe("v1");
  });

  it("reorders tracks, which reorders the composite", () => {
    store().addTrack("video", "v1");
    store().addTrack("video", "v2");
    store().patchTimeline({
      top: imageElement({ trackId: "v2" }),
      bottom: imageElement({ trackId: "v1" }),
    });
    expect(store().timeline.top.priority).toBeGreaterThan(
      store().timeline.bottom.priority,
    );

    store().moveTrackTo("v2", 1);
    expect(store().timeline.top.priority).toBeLessThan(
      store().timeline.bottom.priority,
    );
  });

  it("leaves priority alone until tracks exist", () => {
    // Every pre-existing caller of patchTimeline expects a plain replace.
    store().patchTimeline({ a: imageElement({ priority: 7 }) });
    expect(store().timeline.a.priority).toBe(7);
  });
});
