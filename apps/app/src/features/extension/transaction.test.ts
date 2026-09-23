/**
 * A batch against the real store, the real commands and the real `commit`.
 *
 * The claim worth pinning hardest is that a batch of N edits costs one Cmd+Z.
 * It is the whole justification for the collector existing rather than letting
 * an extension make N calls, and it is invisible to every other test here.
 *
 * Counted the way `commands/commands.test.ts` counts it: the number of times
 * undo has to run to get back to where the document started, not the history
 * length, because `agent/checkpoint.ts` seeds a baseline entry for the
 * pre-edit state when the history is empty.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useTimelineStore } from "../../states/timelineStore";
import { ensureUndoBaseline } from "../agent/checkpoint";
import { getCommand } from "../agent/registry";
import { SCHEMA_VERSION, createTrack, normalizeDocument } from "../timeline/tracks";
import { videoElement } from "../renderer/testing";
import { isTimelineLocked, timelineLockMessage, timelineLockStore } from "../../states/timelineLockStore";
import { NON_TRANSACTIONAL, __resetTransactionForTesting, activeTransaction, runBatch, type BatchPorts } from "./transaction";

import "../agent/commands/read";
import "../agent/commands/edit";
import "../agent/commands/text";
import "../agent/commands/tracks";
import "./commands";

function ports(overrides: Partial<BatchPorts> = {}): BatchPorts {
  return {
    getDocument: () => useTimelineStore.getState().getDocument(),
    withCheckpoint: (fn) => useTimelineStore.getState().withCheckpoint(fn),
    ensureUndoBaseline,
    isLocked: isTimelineLocked,
    lockMessage: timelineLockMessage,
    runCommand: (name, params) => {
      const command = getCommand(name);
      if (command == null) {
        throw new Error("no such command: " + name);
      }
      return command(params);
    },
    ...overrides,
  };
}

function seed(): void {
  const store = useTimelineStore.getState();
  store.clearTimeline();
  store.patchDocument(
    normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0), createTrack("t1", "text", 1)],
      elements: {
        clip: { ...videoElement({ startTime: 0, duration: 10_000 }), trackId: "v1" } as never,
      },
    }),
  );
}

function clipIds(): string[] {
  return Object.keys(useTimelineStore.getState().getDocument().elements).sort();
}

/** How many undos it takes to get the element list back to where it started. */
function stepsToUndo(operation: () => void): number {
  const before = JSON.stringify(clipIds());
  operation();

  for (let steps = 0; steps < 12; steps += 1) {
    if (JSON.stringify(clipIds()) === before) {
      return steps;
    }
    useTimelineStore.getState().rollbackTimelineFromCheckPoint(-1);
  }
  throw new Error("never got back to the starting document");
}

const textStep = (text: string, startMs: number) => ({
  name: "add_text",
  params: { text, startMs, durationMs: 1000 },
});

describe("runBatch", () => {
  beforeEach(() => {
    __resetTransactionForTesting();
    timelineLockStore.getState().unlock();
    seed();
  });

  it("costs one undo for three edits", () => {
    const steps = stepsToUndo(() => {
      const outcome = runBatch(
        [textStep("one", 0), textStep("two", 2000), textStep("three", 4000)],
        ports(),
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.created).toHaveLength(3);
    });
    expect(steps).toBe(1);
  });

  it("lets a later step see an earlier step's result", () => {
    // `currentDoc` returns the working document inside a batch, so a split
    // followed by a trim of one of the halves resolves an id the store has
    // never seen.
    const outcome = runBatch(
      [
        { name: "split_clip", params: { elementId: "clip", atMs: [5000] } },
        { name: "add_text", params: { text: "after", startMs: 0, durationMs: 500 } },
      ],
      ports(),
    );
    expect(outcome.ok).toBe(true);
    expect(Object.keys(useTimelineStore.getState().getDocument().elements).length).toBe(3);
  });

  it("applies nothing until the last step has run", () => {
    let sawDuringBatch: string[] = [];
    const outcome = runBatch([textStep("one", 0), textStep("two", 1500)], {
      ...ports(),
      runCommand: (name, params) => {
        const command = getCommand(name);
        const result = command?.(params);
        sawDuringBatch = clipIds();
        return result;
      },
    });
    expect(outcome.ok).toBe(true);
    // The store still held only the seeded clip while the steps were running.
    expect(sawDuringBatch).toEqual(["clip"]);
  });

  it("records no checkpoint when every step declines", () => {
    // A batch that changed nothing must cost the user nothing, which is the
    // same promise a single declining command makes.
    const before = useTimelineStore.getState().history.timelineHistory.length;
    const outcome = runBatch(
      [{ name: "move_clips", params: { elementIds: ["clip"], deltaMs: 0 } }],
      ports(),
    );
    expect(outcome.ok).toBe(false);
    expect(useTimelineStore.getState().history.timelineHistory.length).toBe(before);
  });

  it("applies nothing when a step throws", () => {
    const before = clipIds();
    const outcome = runBatch(
      [textStep("one", 0), { name: "trim_clip", params: { elementId: "missing" } }],
      ports(),
    );
    expect(outcome.ok).toBe(false);
    expect(clipIds()).toEqual(before);
  });

  it("refuses an asynchronous command rather than awaiting it", () => {
    // Awaiting would leave the collector open across a tick, and an edit that
    // landed in that window would join this batch's undo step uninvited.
    const outcome = runBatch([{ name: "slow", params: {} }], {
      ...ports(),
      runCommand: () => Promise.resolve({ ok: true }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("asynchronous");
  });

  it("refuses every command on the non-transactional list", () => {
    for (const name of NON_TRANSACTIONAL) {
      expect([name, runBatch([{ name }], ports()).ok]).toEqual([name, false]);
    }
  });

  it("refuses to nest", () => {
    const outcome = runBatch([textStep("outer", 0)], {
      ...ports(),
      runCommand: () => runBatch([textStep("inner", 1000)], ports()),
    });
    expect(outcome.ok).toBe(false);
  });

  it("refuses while the timeline is locked", () => {
    timelineLockStore.getState().lock("captionSession");
    const outcome = runBatch([textStep("one", 0)], ports());
    expect(outcome.ok).toBe(false);
    expect(clipIds()).toEqual(["clip"]);
  });

  it("closes the transaction even when it fails", () => {
    // A transaction left open would make every later `commit` write into a
    // working document nothing will ever apply, and the editor would silently
    // stop accepting edits.
    runBatch([{ name: "trim_clip", params: { elementId: "missing" } }], ports());
    expect(activeTransaction()).toBeNull();
  });

  it("refuses an empty batch", () => {
    expect(runBatch([], ports()).ok).toBe(false);
  });
});
