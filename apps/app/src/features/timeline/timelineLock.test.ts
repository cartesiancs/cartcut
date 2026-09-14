import { beforeEach, describe, expect, it } from "vitest";
import { commit as agentCommit } from "../agent/commit";
import {
  deleteSelection,
  redo,
  splitSelection,
  undo,
} from "../editor/actions";
import { refusesEdit } from "../editor/timelineLock";
import { videoElement } from "../renderer/testing";
import { selectionStore } from "../../states/selectionStore";
import { timelineLockStore } from "../../states/timelineLockStore";
import { useTimelineStore } from "../../states/timelineStore";
import { SCHEMA_VERSION, createTrack, normalizeDocument } from "./tracks";

/**
 * The lock, asserted across every gate rather than at each one.
 *
 * `templateLock.test.ts` is the shape: one rule, many modules that have to
 * keep it, and a suite that fails if any of them stops. The difference is that
 * a template's lock is a property of a clip and this one is a property of the
 * app, so the gates are commands rather than pure ops.
 */

function seed() {
  const doc = normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements: {
      clip: videoElement({
        trackId: "v1",
        startTime: 0,
        duration: 10_000,
        trim: { startTime: 0, endTime: 10_000 },
        sourceDuration: 10_000,
      }),
      other: videoElement({
        trackId: "v1",
        startTime: 12_000,
        duration: 3_000,
        trim: { startTime: 0, endTime: 3_000 },
        sourceDuration: 3_000,
      }),
    },
  });
  useTimelineStore.setState({
    timeline: doc.elements,
    tracks: doc.tracks,
    cursor: 5_000,
    history: { timelineHistory: [], historyNow: -1 },
  });
  selectionStore.getState().setIds(["clip"]);
}

const elementIds = () => Object.keys(useTimelineStore.getState().timeline).sort();
const historyLength = () =>
  useTimelineStore.getState().history.timelineHistory.length;

beforeEach(() => {
  timelineLockStore.getState().unlock();
  // The notice fires once per lock, and the memory is module-local, so it has
  // to be cleared between cases or the second one asserts about the first.
  refusesEdit();
  seed();
});

describe("timelineLockStore", () => {
  it("is open until somebody takes it", () => {
    expect(timelineLockStore.getState().reason).toBeNull();
    expect(refusesEdit()).toBe(false);
  });

  it("names who holds it", () => {
    timelineLockStore.getState().lock("captionSession");
    expect(timelineLockStore.getState().reason).toBe("captionSession");
    expect(refusesEdit()).toBe(true);
  });

  it("declines a write of the value it already holds", () => {
    let woken = 0;
    const stop = timelineLockStore.subscribe(() => {
      woken += 1;
    });
    timelineLockStore.getState().lock("captionSession");
    timelineLockStore.getState().lock("captionSession");
    timelineLockStore.getState().unlock();
    timelineLockStore.getState().unlock();
    stop();
    expect(woken).toBe(2);
  });
});

describe("the editor's commands", () => {
  it("splits when the timeline is free", () => {
    splitSelection();
    expect(elementIds().length).toBe(3);
  });

  it("refuses a split while it is locked", () => {
    timelineLockStore.getState().lock("captionSession");
    splitSelection();
    expect(elementIds()).toEqual(["clip", "other"]);
    expect(historyLength()).toBe(0);
  });

  it("refuses a delete while it is locked", () => {
    timelineLockStore.getState().lock("captionSession");
    deleteSelection();
    expect(elementIds()).toContain("clip");
  });

  // The session's own writes record no history, so an undo would jump past the
  // whole session to whatever came before it and leave a provisional document
  // on screen at a history position that has nothing to do with it.
  it("refuses undo and redo while it is locked", () => {
    // A baseline first, because `withCheckpoint` records the state *after* an
    // edit: with one entry there is nothing behind it to go back to, which is
    // the store's own known limitation and not what this case is about.
    useTimelineStore.getState().checkPointTimeline();
    splitSelection();
    const after = elementIds();
    expect(historyLength()).toBe(2);

    timelineLockStore.getState().lock("captionSession");
    undo();
    expect(elementIds()).toEqual(after);
    redo();
    expect(elementIds()).toEqual(after);

    timelineLockStore.getState().unlock();
    undo();
    expect(elementIds()).toEqual(["clip", "other"]);
  });
});

describe("the agent's commands", () => {
  it("commits when the timeline is free", () => {
    const result = agentCommit(
      (doc) => ({
        ...doc,
        elements: { ...doc.elements, extra: doc.elements.other },
      }),
      "nothing to do",
    );
    expect(result.ok).toBe(true);
  });

  // "That does nothing" and "not while the caption panel is open" are different
  // answers, and an agent that cannot tell them apart will report the wrong one.
  it("refuses while it is locked, and says why rather than declining", () => {
    timelineLockStore.getState().lock("captionSession");
    const result = agentCommit(
      (doc) => ({
        ...doc,
        elements: { ...doc.elements, extra: doc.elements.other },
      }),
      "nothing to do",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).not.toBe("nothing to do");
    expect(result.reason).toMatch(/caption/i);
    expect(elementIds()).toEqual(["clip", "other"]);
  });
});

describe("what the lock does not take", () => {
  // The user is meant to go on watching the edit the session is making.
  it("leaves the playhead alone", () => {
    timelineLockStore.getState().lock("captionSession");
    useTimelineStore.getState().setCursor(7_000);
    expect(useTimelineStore.getState().cursor).toBe(7_000);
  });

  it("leaves playback alone", () => {
    timelineLockStore.getState().lock("captionSession");
    useTimelineStore.getState().setPlay(true);
    expect(useTimelineStore.getState().control.isPlay).toBe(true);
    useTimelineStore.getState().setPlay(false);
  });

  it("leaves the selection alone, so a clip can still be inspected", () => {
    timelineLockStore.getState().lock("captionSession");
    selectionStore.getState().setIds(["other"]);
    expect(selectionStore.getState().ids).toEqual(["other"]);
  });

  // The session writes its own projection through this channel, so locking it
  // would lock the session out of the document it owns.
  it("leaves previewDocument alone, which is how the session writes at all", () => {
    timelineLockStore.getState().lock("captionSession");
    const doc = useTimelineStore.getState().getDocument();
    useTimelineStore.getState().previewDocument({
      ...doc,
      elements: { ...doc.elements, projected: doc.elements.other },
    });
    expect(elementIds()).toContain("projected");
    expect(historyLength()).toBe(0);
  });
});
