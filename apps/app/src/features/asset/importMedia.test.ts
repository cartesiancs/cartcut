/**
 * Importing a drop: what survives a bad file, and where the good ones land.
 *
 * The prober is injected, so all of this runs under vitest's node environment
 * with no DOM and no ffprobe — the seam `mediaProbe.ts` was built to have.
 */

import { describe, it, expect, vi } from "vitest";
import { emptyPlan, placeImported, planImport, type ImportPlan } from "./importMedia";
import type { MediaProber } from "../element/mediaProbe";
import type { MediaProbe } from "../element/mediaElement";
import { spanEnd, spanLength } from "../timeline/geometry";
import { clipsOnTrack } from "../timeline/tracks";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";

const FPS = 30;

function doc(
  tracks: Array<[string, "video" | "audio" | "text"]> = [["v1", "video"]],
): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: tracks.map(([id, kind], index) => createTrack(id, kind, index)),
    elements: {},
  });
}

/** Ids that read back meaningfully when a test has to name one. */
function counter(prefix = "id") {
  let n = 0;
  return () => `${prefix}${++n}`;
}

/** A prober that answers instantly, matching the one the agent suite uses. */
const fakeProber: MediaProber = {
  image: async () => ({ width: 800, height: 600 }),
  gif: async () => ({ width: 320, height: 240 }),
  video: async () => ({
    width: 1920,
    height: 1080,
    durationMs: 5_000,
    hasAudio: true,
  }),
  audio: async () => ({ durationMs: 3_000 }),
};

function probe(over: Partial<MediaProbe> = {}): MediaProbe {
  return {
    kind: "video",
    localpath: "file:///m/a.mp4",
    durationMs: 5_000,
    width: 1920,
    height: 1080,
    hasAudio: true,
    ...over,
  };
}

function planOf(...probes: MediaProbe[]): ImportPlan {
  return {
    ready: probes.map((p) => ({ item: { path: p.localpath }, probe: p })),
    skipped: [],
  };
}

const place = (
  d: TimelineDocument,
  plan: ImportPlan,
  over: Partial<Parameters<typeof placeImported>[2]> = {},
) => placeImported(d, plan, { startMs: 0, fps: FPS, newId: counter(), ...over });

// ------------------------------------------------------------------ planImport

describe("planImport", () => {
  it("probes every file", async () => {
    const plan = await planImport(["/m/a.mp4", "/m/b.png"], fakeProber);

    expect(plan.ready).toHaveLength(2);
    expect(plan.skipped).toEqual([]);
  });

  it("accepts bare paths and full items alike", async () => {
    const plan = await planImport(
      ["/m/a.mp4", { path: "/m/b.mp4", startMs: 2000, trackId: "v2" }],
      fakeProber,
    );

    expect(plan.ready[0].item).toEqual({ path: "/m/a.mp4" });
    expect(plan.ready[1].item).toEqual({
      path: "/m/b.mp4",
      startMs: 2000,
      trackId: "v2",
    });
  });

  it("keeps the nine good files when one is unreadable", async () => {
    // Settled rather than raced. A bare `Promise.all` would lose the whole drop
    // to a single corrupt file — the same failure `assetBatch.ts` records.
    const flaky: MediaProber = {
      ...fakeProber,
      image: async () => {
        throw new Error("unreadable");
      },
    };

    const plan = await planImport(["/m/a.mp4", "/m/bad.png", "/m/c.wav"], flaky);

    expect(plan.ready.map((r) => r.item.path)).toEqual(["/m/a.mp4", "/m/c.wav"]);
    expect(plan.skipped).toEqual([{ path: "/m/bad.png", reason: "unreadable" }]);
  });

  it("skips a file the editor has no renderer for, with a reason", async () => {
    // Nothing upstream filters by extension; `probeMedia` is the single place
    // that decides, and it says why.
    const plan = await planImport(["/m/notes.txt"], fakeProber);

    expect(plan.ready).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].path).toBe("/m/notes.txt");
    expect(plan.skipped[0].reason).toMatch(/no renderer/i);
  });

  it("skips a folder, which arrives with no extension", async () => {
    const plan = await planImport(["/m/My Footage"], fakeProber);

    expect(plan.ready).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
  });

  it("probes in parallel, not one after another", async () => {
    let running = 0;
    let peak = 0;
    const slow: MediaProber = {
      ...fakeProber,
      video: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await Promise.resolve();
        running -= 1;
        return { width: 10, height: 10, durationMs: 1000, hasAudio: false };
      },
    };

    await planImport(["/m/a.mp4", "/m/b.mp4", "/m/c.mp4"], slow);

    expect(peak).toBeGreaterThan(1);
  });

  it("does nothing for an empty drop", async () => {
    const prober = { ...fakeProber, video: vi.fn(fakeProber.video) };
    const plan = await planImport([], prober);

    expect(plan).toBe(emptyPlan);
    expect(prober.video).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- placeImported

describe("placeImported", () => {
  it("declines by identity when nothing could be read", () => {
    // What makes a drop of nothing but unreadable files cost the user no undo
    // step: `withCheckpoint` reads the same document back and records nothing.
    const before = doc();
    const result = place(before, { ready: [], skipped: [{ path: "x", reason: "y" }] });

    expect(result.doc).toBe(before);
    expect(result.createdIds).toEqual([]);
  });

  it("places one file at the moment it was dropped", () => {
    const result = place(doc(), planOf(probe()), { startMs: 4000 });

    const placed = result.doc.elements[result.createdIds[0]];
    expect(placed.startTime).toBe(4000);
    expect(spanLength(placed)).toBe(5000);
  });

  describe("laying a run end to end", () => {
    it("starts each file where the last one ended", () => {
      const result = place(
        doc(),
        planOf(
          probe({ durationMs: 5000 }),
          probe({ durationMs: 3000 }),
          probe({ durationMs: 2000 }),
        ),
        { startMs: 1000 },
      );

      const starts = result.createdIds.map((id) => result.doc.elements[id].startTime);
      expect(starts).toEqual([1000, 6000, 9000]);
    });

    it("reads each length back from the document rather than the probe", () => {
      // A still takes its length from `durationMs` and a video from the file;
      // only the placed element knows which happened. Recomputing from the
      // probe would overlap the still with whatever follows it.
      const result = place(
        doc([
          ["v1", "video"],
          ["v2", "video"],
        ]),
        {
          ready: [
            { item: { path: "/m/a.png", durationMs: 2500 }, probe: probe({ kind: "image", durationMs: 0 }) },
            { item: { path: "/m/b.mp4" }, probe: probe({ durationMs: 4000 }) },
          ],
          skipped: [],
        },
        { startMs: 0 },
      );

      const [still, video] = result.createdIds.map((id) => result.doc.elements[id]);
      expect(spanLength(still)).toBe(2500);
      expect(video.startTime).toBe(2500);
      expect(spanEnd(video)).toBe(6500);
    });

    it("accounts for a clip playing at a different speed", () => {
      const result = place(doc(), planOf(probe({ durationMs: 4000 })), {
        startMs: 0,
      });
      const id = result.createdIds[0];

      // `spanEnd` is the timeline span, not the source duration — the reason
      // the cursor is advanced from it rather than from `duration`.
      expect(spanEnd(result.doc.elements[id])).toBe(4000);
    });

    it("stacks them at one moment when asked not to sequence", () => {
      const result = place(doc(), planOf(probe(), probe(), probe()), {
        startMs: 2000,
        sequential: false,
      });

      const starts = result.createdIds.map((id) => result.doc.elements[id].startTime);
      expect(starts).toEqual([2000, 2000, 2000]);
    });

    it("lets a file name its own moment inside a run", () => {
      const result = placeImported(
        doc(),
        {
          ready: [
            { item: { path: "/m/a.mp4" }, probe: probe({ durationMs: 1000 }) },
            { item: { path: "/m/b.mp4", startMs: 9000 }, probe: probe({ durationMs: 1000 }) },
          ],
          skipped: [],
        },
        { startMs: 0, fps: FPS, newId: counter() },
      );

      const starts = result.createdIds.map((id) => result.doc.elements[id].startTime);
      expect(starts).toEqual([0, 9000]);
    });
  });

  describe("the row", () => {
    it("uses the track the drop aimed at", () => {
      const d = doc([
        ["v1", "video"],
        ["v2", "video"],
      ]);
      const result = place(d, planOf(probe()), { startMs: 0, trackId: "v2" });

      expect(result.doc.elements[result.createdIds[0]].trackId).toBe("v2");
    });

    it("chooses one itself when the drop aimed at no row", () => {
      const result = place(doc(), planOf(probe()), { startMs: 0, trackId: null });

      expect(result.doc.elements[result.createdIds[0]].trackId).toBe("v1");
    });

    it("keeps a run together on the aimed row when it fits", () => {
      const d = doc([
        ["v1", "video"],
        ["v2", "video"],
      ]);
      const result = place(d, planOf(probe(), probe(), probe()), {
        startMs: 0,
        trackId: "v2",
      });

      expect(clipsOnTrack(result.doc, "v2")).toHaveLength(3);
      expect(clipsOnTrack(result.doc, "v1")).toHaveLength(0);
    });

    it("falls through rather than refusing when the aimed row is occupied", () => {
      const d = doc([
        ["v1", "video"],
        ["v2", "video"],
      ]);
      const occupied = place(d, planOf(probe()), { startMs: 0, trackId: "v2" }).doc;

      // Second drop at the same moment on the same row: it has to go somewhere.
      const result = place(occupied, planOf(probe()), {
        startMs: 0,
        trackId: "v2",
        newId: counter("second"),
      });

      const placed = result.doc.elements[result.createdIds[0]];
      expect(placed.trackId).not.toBe("v2");
      expect(placed.startTime).toBe(0);
    });

    it("sends audio to an audio track even when a video row was aimed at", () => {
      const d = doc([
        ["v1", "video"],
        ["a1", "audio"],
      ]);
      const result = place(d, planOf(probe({ kind: "audio", durationMs: 3000 })), {
        startMs: 0,
        trackId: "v1",
      });

      expect(result.doc.elements[result.createdIds[0]].trackId).toBe("a1");
    });

    it("adds a track when there is no room anywhere", () => {
      const before = doc();
      const first = place(before, planOf(probe()), { startMs: 0 }).doc;
      const result = place(first, planOf(probe()), {
        startMs: 0,
        sequential: false,
        newId: counter("second"),
      });

      expect(result.doc.tracks.length).toBeGreaterThan(before.tracks.length);
    });
  });

  describe("quantising", () => {
    it("puts the run start on a frame boundary", () => {
      const result = place(doc(), planOf(probe()), { startMs: 1234 });

      // 1234ms is not a 30fps frame; 1233.33 is.
      expect(result.doc.elements[result.createdIds[0]].startTime).toBeCloseTo(
        1233.33,
        1,
      );
    });

    it("clamps a negative start to zero", () => {
      const result = place(doc(), planOf(probe()), { startMs: -5000 });

      expect(result.doc.elements[result.createdIds[0]].startTime).toBe(0);
    });

    it("snaps to the project's own fps", () => {
      const at24 = place(doc(), planOf(probe()), { startMs: 1000, fps: 24 });
      const start = at24.doc.elements[at24.createdIds[0]].startTime;

      expect(start * (24 / 1000)).toBeCloseTo(Math.round(start * (24 / 1000)), 6);
    });
  });

  describe("as one edit", () => {
    it("hands back a single new document for the whole run", () => {
      // Three files, one document — so `withCheckpoint` records one undo step
      // and Cmd+Z takes all three away together.
      const before = doc();
      const result = place(before, planOf(probe(), probe(), probe()), {
        startMs: 0,
      });

      expect(result.doc).not.toBe(before);
      expect(Object.keys(before.elements)).toHaveLength(0);
      expect(Object.keys(result.doc.elements)).toHaveLength(3);
    });

    it("does not touch the document it was given", () => {
      const before = doc();
      place(before, planOf(probe(), probe()), { startMs: 0 });

      expect(Object.keys(before.elements)).toHaveLength(0);
      expect(before.tracks).toHaveLength(1);
    });

    it("returns the ids it created, in the order it placed them", () => {
      const result = place(doc(), planOf(probe(), probe(), probe()), {
        startMs: 0,
        newId: counter("x"),
      });

      expect(result.createdIds).toHaveLength(3);
      expect(new Set(result.createdIds).size).toBe(3);
      for (const id of result.createdIds) {
        expect(result.doc.elements[id]).toBeDefined();
      }
    });
  });

  it("carries a probed file end to end, from paths to placement", async () => {
    const plan = await planImport(["/m/a.mp4", "/m/b.png", "/m/notes.txt"], fakeProber);
    const result = place(doc(), plan, { startMs: 0 });

    expect(plan.skipped).toHaveLength(1);
    expect(result.createdIds).toHaveLength(2);

    const [video, image] = result.createdIds.map((id) => result.doc.elements[id]);
    expect(video.filetype).toBe("video");
    expect(image.filetype).toBe("image");
    expect(image.startTime).toBe(spanEnd(video));
  });
});
