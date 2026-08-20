/**
 * The command layer against a real store.
 *
 * These run the same code path an MCP tool call takes once it has crossed the
 * bridge — the registry, the command, `withCheckpoint`, the pure ops — so they
 * cover the seam that the protocol-level smoke test cannot reach and that unit
 * tests of the ops individually do not either.
 *
 * The claim worth pinning hardest is that one instruction is one undo step. It
 * is the whole justification for routing agent edits through `withCheckpoint`
 * rather than letting them write the store directly, and it is invisible to
 * every other test in the repo.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useTimelineStore } from "../../../states/timelineStore";
import { renderOptionStore } from "../../../states/renderOptionStore";
import {
  SCHEMA_VERSION,
  clipsOnTrack,
  createTrack,
  normalizeDocument,
} from "../../timeline/tracks";
import { spanOf } from "../../timeline/geometry";
import { videoElement, imageElement } from "../../renderer/testing";
import { getCommand } from "../registry";

import "./read";
import "./edit";
import "./text";
import "./meta";

/** Invoke a command the way the bridge does. */
async function run(name: string, params: any = {}) {
  const command = getCommand(name);
  if (command == null) {
    throw new Error(`no such command: ${name}`);
  }
  return (await command(params)) as any;
}

function seed(elements: Record<string, any>, tracks = [["v1", "video"]] as any) {
  const store = useTimelineStore.getState();
  store.clearTimeline();
  store.patchDocument(
    normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: tracks.map(([id, kind]: any, index: number) =>
        createTrack(id, kind, index),
      ),
      elements,
    }),
  );
}

function currentSpans(trackId = "v1") {
  const doc = useTimelineStore.getState().getDocument();
  return clipsOnTrack(doc, trackId)
    .map(([, el]) => spanOf(el))
    .sort((a, b) => a.start - b.start);
}

function historyLength() {
  return useTimelineStore.getState().history.timelineHistory.length;
}

/**
 * How many undo steps an operation cost.
 *
 * Not just the history delta: the agent seeds a baseline entry for the
 * pre-edit state when the history is empty (see `agent/checkpoint.ts`), so the
 * first edit legitimately adds two entries while still being one step to undo.
 * What callers actually care about is how many times Cmd+Z is needed.
 */
async function stepsToUndo(operation: () => Promise<unknown>) {
  const before = JSON.stringify(
    Object.keys(useTimelineStore.getState().getDocument().elements).sort(),
  );
  await operation();

  let steps = 0;
  while (steps < 10) {
    const now = JSON.stringify(
      Object.keys(useTimelineStore.getState().getDocument().elements).sort(),
    );
    if (now === before) {
      return steps;
    }
    const result: any = await run("undo");
    if (!result.ok) {
      return Infinity;
    }
    steps++;
  }
  return Infinity;
}

const tenSecondClip = () =>
  videoElement({
    trackId: "v1",
    startTime: 0,
    duration: 10_000,
    trim: { startTime: 0, endTime: 10_000 },
    sourceDuration: 10_000,
  });

beforeEach(() => {
  useTimelineStore.getState().clearTimeline();
  renderOptionStore.getState().updateOptions({
    previewSize: { w: 1920, h: 1080 },
    fps: 60,
    duration: 10,
    backgroundColor: "#000000",
  });
});

describe("reading", () => {
  it("summarises the project without dumping it", async () => {
    seed({
      a: tenSecondClip(),
      b: imageElement({ trackId: "v1", startTime: 12_000, duration: 2000 }),
    });

    const overview = await run("get_project_overview");
    expect(overview.clipCount).toBe(2);
    expect(overview.timelineDurationMs).toBe(14_000);
    expect(overview.clipsByType).toEqual({ video: 1, image: 1 });
    expect(overview.tracks[0]).toMatchObject({ name: "V1", clips: 2 });
  });

  it("addresses clips by their map key", async () => {
    seed({ "the-id": tenSecondClip() });
    const { clips } = await run("list_clips");
    expect(clips[0].id).toBe("the-id");
    // And that id is what the other tools accept.
    await expect(run("get_clip", { elementId: "the-id" })).resolves.toMatchObject(
      { id: "the-id" },
    );
  });

  it("filters by time window", async () => {
    seed({
      a: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }),
      b: imageElement({ trackId: "v1", startTime: 5000, duration: 1000 }),
    });

    const { clips } = await run("list_clips", { startMs: 4000, endMs: 7000 });
    expect(clips.map((c: any) => c.id)).toEqual(["b"]);
  });

  it("explains an unknown id instead of failing silently", async () => {
    seed({ a: tenSecondClip() });
    await expect(run("get_clip", { elementId: "ghost" })).rejects.toThrow(
      /No clip with id "ghost"/,
    );
  });
});

describe("remove_ranges", () => {
  it("is one undo step no matter how many ranges", async () => {
    seed({ a: tenSecondClip() });

    // Three cuts, one step: Cmd+Z once takes the whole instruction back.
    const steps = await stepsToUndo(async () => {
      const result: any = await run("remove_ranges", {
        elementId: "a",
        ranges: [
          { startMs: 1000, endMs: 2000 },
          { startMs: 4000, endMs: 5000 },
          { startMs: 7000, endMs: 8000 },
        ],
      });
      expect(result.ok).toBe(true);
      expect(currentSpans()).toHaveLength(4);
    });

    expect(steps).toBe(1);
  });

  it("restores the original clip on undo", async () => {
    seed({ a: tenSecondClip() });

    await run("remove_ranges", {
      elementId: "a",
      ranges: [{ startMs: 3000, endMs: 5000 }],
    });
    expect(currentSpans()).toHaveLength(2);

    const undone = await run("undo");
    expect(undone.ok).toBe(true);
    expect(currentSpans()).toEqual([{ start: 0, end: 10_000, length: 10_000 }]);
  });

  it("declines without costing an undo step", async () => {
    seed({ a: tenSecondClip() });
    const before = historyLength();

    const result = await run("remove_ranges", {
      elementId: "a",
      ranges: [{ startMs: 50_000, endMs: 60_000 }],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/0–10000ms/);
    // Not even the undo baseline: a declined edit leaves no trace at all.
    expect(historyLength()).toBe(before);
  });

  it("closes gaps by default and leaves them when asked", async () => {
    seed({ a: tenSecondClip() });
    await run("remove_ranges", {
      elementId: "a",
      ranges: [{ startMs: 3000, endMs: 5000 }],
    });
    expect(currentSpans()[1].start).toBe(3000);

    seed({ a: tenSecondClip() });
    await run("remove_ranges", {
      elementId: "a",
      ranges: [{ startMs: 3000, endMs: 5000 }],
      ripple: false,
    });
    expect(currentSpans()[1].start).toBe(5000);
  });
});

describe("trim and move", () => {
  it("trims to absolute times, not deltas", async () => {
    seed({ a: tenSecondClip() });

    await run("trim_clip", { elementId: "a", startMs: 2000, endMs: 8000 });

    expect(currentSpans()).toEqual([{ start: 2000, end: 8000, length: 6000 }]);
  });

  it("moves a group by its earliest clip, keeping their spacing", async () => {
    seed({
      a: imageElement({ trackId: "v1", startTime: 1000, duration: 1000 }),
      b: imageElement({ trackId: "v1", startTime: 5000, duration: 1000 }),
    });

    const result = await run("move_clips", {
      elementIds: ["a", "b"],
      toMs: 0,
    });

    expect(result.ok).toBe(true);
    expect(currentSpans()).toEqual([
      { start: 0, end: 1000, length: 1000 },
      { start: 4000, end: 5000, length: 1000 },
    ]);
  });

  it("refuses a move rather than performing half of it", async () => {
    // `b` cannot go to 0 — `a` is there — so neither clip moves.
    seed({
      a: imageElement({ trackId: "v1", startTime: 0, duration: 2000 }),
      b: imageElement({ trackId: "v1", startTime: 5000, duration: 1000 }),
    });
    const before = historyLength();

    const result = await run("move_clips", { elementIds: ["b"], toMs: 500 });

    expect(result.ok).toBe(false);
    expect(currentSpans()[1].start).toBe(5000);
    expect(historyLength()).toBe(before);
  });
});

describe("add_subtitles", () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({
    text: `line ${i}`,
    startMs: i * 1000,
    durationMs: 900,
  }));

  it("puts a whole transcript on one text track in one undo step", async () => {
    seed({ a: tenSecondClip() });

    const steps = await stepsToUndo(async () => {
      const result: any = await run("add_subtitles", { items: lines });
      expect(result.ok).toBe(true);
      expect(result.created).toHaveLength(12);
      // The placement rule that stops forty captions becoming forty rows.
      expect(result.tracks).toEqual(["T1"]);
    });

    // Twelve captions, one Cmd+Z.
    expect(steps).toBe(1);
    expect(Object.keys(useTimelineStore.getState().getDocument().elements)).toEqual(
      ["a"],
    );
  });

  it("keeps the response small however many lines were added", async () => {
    seed({ a: tenSecondClip() });
    const result = await run("add_subtitles", { items: lines });

    expect(result.clips).toHaveLength(5);
    expect(result.note).toMatch(/12 subtitles added/);
  });

  it("maps source-file times through a clip's trim", async () => {
    // The clip starts 2s into its source and sits at timeline 0, so a caption
    // at source 3s belongs at timeline 1s.
    seed({
      a: videoElement({
        trackId: "v1",
        startTime: 0,
        duration: 6000,
        trim: { startTime: 2000, endTime: 8000 },
        sourceDuration: 10_000,
      }),
    });

    const result = await run("add_subtitles", {
      items: [{ text: "hello", startMs: 3000, durationMs: 1000 }],
      sourceElementId: "a",
    });

    expect(result.clips[0]).toMatchObject({ start: 1000, dur: 1000 });
  });

  it("sizes captions from the project, not a hardcoded 1080p", async () => {
    renderOptionStore.getState().updateOptions({
      previewSize: { w: 1080, h: 1920 },
      fps: 60,
      duration: 10,
      backgroundColor: "#000000",
    });
    seed({ a: tenSecondClip() });

    const result = await run("add_subtitles", {
      items: [{ text: "vertical", startMs: 0, durationMs: 1000 }],
    });

    const doc = useTimelineStore.getState().getDocument();
    const caption: any = doc.elements[result.created[0]];
    expect(caption.width).toBe(1080);
    // Comfortably inside a 1920-tall frame, not off the bottom of it.
    expect(caption.location.y).toBeLessThan(1920);
    expect(caption.location.y).toBeGreaterThan(1500);
  });
});

describe("update_clip", () => {
  it("writes whitelisted appearance properties", async () => {
    seed({ a: tenSecondClip() });

    await run("update_clip", {
      elementId: "a",
      patch: { location: { x: 100, y: 50 }, opacity: 40 },
    });

    const element: any = useTimelineStore.getState().getDocument().elements.a;
    expect(element.location).toEqual({ x: 100, y: 50 });
    expect(element.opacity).toBe(40);
  });

  it("refuses timing writes and says what to use instead", async () => {
    seed({ a: tenSecondClip() });

    await expect(
      run("update_clip", { elementId: "a", patch: { startTime: 5000 } }),
    ).rejects.toThrow(/trim_clip or move_clips/);

    // And nothing was written.
    expect(currentSpans()[0].start).toBe(0);
  });

  it("refuses a text-only property on a video clip", async () => {
    seed({ a: tenSecondClip() });
    await expect(
      run("update_clip", { elementId: "a", patch: { textcolor: "#fff" } }),
    ).rejects.toThrow(/cannot write textcolor on a video clip/);
  });
});

describe("undo and redo", () => {
  it("reports having nothing to do rather than throwing", async () => {
    seed({ a: tenSecondClip() });
    // `seed` itself leaves no history: patchDocument does not checkpoint.
    expect(await run("redo")).toMatchObject({ ok: false });
  });

  it("round-trips an edit", async () => {
    seed({ a: tenSecondClip() });
    await run("split_clip", { elementId: "a", atMs: [4000] });
    expect(currentSpans()).toHaveLength(2);

    await run("undo");
    expect(currentSpans()).toHaveLength(1);

    await run("redo");
    expect(currentSpans()).toHaveLength(2);
  });
});
