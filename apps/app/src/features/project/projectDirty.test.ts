import { beforeEach, describe, expect, it } from "vitest";
import {
  currentProjectDigest,
  initProjectBaseline,
  isProjectDirty,
  isProjectEmpty,
  markProjectSaved,
  projectBaseline,
  resetProjectBaseline,
} from "./projectDirty";
import { useTimelineStore } from "../../states/timelineStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { SCHEMA_VERSION, type TimelineTrack } from "../timeline/tracks";
import type { Timeline } from "../../@types/timeline";

/**
 * The behaviours here are the ones the old detector got wrong, and each one is
 * a way to lose work:
 *
 * - a **track reorder** must read dirty (it read clean, so Open cleared it);
 * - an **undo back to the saved state** must read clean (otherwise Auto Save
 *   writes forever and the quit guard cries wolf);
 * - a **failed save** must not mark the project saved — that is the case where
 *   marking it clean deletes the only unsaved copy.
 *
 * The stores are module singletons with no global setup file, so every test
 * resets them itself.
 */

function clip(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filetype: "video",
    startTime: 0,
    duration: 5000,
    location: { x: 0, y: 0 },
    trim: { startTime: 0, endTime: 5000 },
    width: 1920,
    height: 1080,
    localpath: "file:///a/clip.mp4",
    priority: 1,
    ...over,
  };
}

const TRACKS: TimelineTrack[] = [
  { id: "t1", kind: "video", name: "V1", index: 0 },
  { id: "t2", kind: "audio", name: "A1", index: 1 },
];

function setDocument(elements: Timeline, tracks: TimelineTrack[] = TRACKS) {
  useTimelineStore.setState({ timeline: elements, tracks: tracks });
}

beforeEach(() => {
  resetProjectBaseline();
  useTimelineStore.setState({
    timeline: {},
    tracks: [],
    history: { timelineHistory: [], historyNow: -1 },
  });
  renderOptionStore.setState({
    options: renderOptionStore.getInitialState().options,
  });
});

describe("isProjectDirty", () => {
  it("reports dirty when no baseline has been established", () => {
    // LOAD-BEARING, and the cause of a real bug.
    //
    // The first draft *seeded* the baseline here and answered `false`. For a
    // project that has never been saved nothing else establishes one — only
    // `load` and a successful save do — so the first ask was the quit guard
    // itself, which seeded from the already-edited timeline and reported
    // clean. The window closed on unsaved work with no warning at all.
    //
    // Unknown means assume unsaved. `initProjectBaseline` is what makes a
    // fresh launch quiet, and it runs at startup against the empty project
    // rather than lazily against whatever is on screen.
    expect(projectBaseline()).toBeNull();
    expect(isProjectDirty()).toBe(true);
    // And asking must not have changed the answer.
    expect(projectBaseline()).toBeNull();
    expect(isProjectDirty()).toBe(true);
  });

  it("reports clean for an untouched project once seeded at startup", () => {
    // The other half: a fresh launch must not warn about a project nobody
    // has touched.
    initProjectBaseline();
    expect(isProjectDirty()).toBe(false);
  });

  it("reports dirty for work done after startup seeding", () => {
    // The quit-guard scenario, end to end: launch, edit, quit.
    initProjectBaseline();
    setDocument({ a: clip() } as unknown as Timeline);
    expect(isProjectDirty()).toBe(true);
  });

  it("still reports dirty after an autosave has been written", () => {
    // An autosave is not a save. It records nothing in `projectDirty`, so a
    // project whose only copy is a recovery point still warns on quit —
    // which is the whole point of the warning.
    initProjectBaseline();
    setDocument({ a: clip() } as unknown as Timeline);
    // ...autosave runs here and writes a ring entry. It does not, and must
    // not, touch the baseline.
    expect(isProjectDirty()).toBe(true);
  });

  it("reports dirty after an edit", () => {
    markProjectSaved();
    setDocument({ a: clip() } as unknown as Timeline);
    expect(isProjectDirty()).toBe(true);
  });

  it("reports clean once the edit is saved", () => {
    setDocument({ a: clip() } as unknown as Timeline);
    markProjectSaved();
    expect(isProjectDirty()).toBe(false);
  });

  it("reports clean when an undo returns to the saved state", () => {
    // LOAD-BEARING. The digest is over content, not identity, so a restored
    // history entry reads as the state it restores even though it is a
    // different object. Without this Auto Save writes forever after any
    // undo and the quit guard warns about a project that is on disk.
    const saved = { a: clip() } as unknown as Timeline;
    setDocument(saved);
    markProjectSaved();

    setDocument({ a: clip({ startTime: 400 }) } as unknown as Timeline);
    expect(isProjectDirty()).toBe(true);

    // A *different object* holding the same content, as an undo produces.
    setDocument({ a: clip() } as unknown as Timeline);
    expect(isProjectDirty()).toBe(false);
  });

  it("reports clean when an edit is followed by its inverse", () => {
    setDocument({ a: clip() } as unknown as Timeline);
    markProjectSaved();
    setDocument({ a: clip({ startTime: 100 }) } as unknown as Timeline);
    setDocument({ a: clip({ startTime: 0 }) } as unknown as Timeline);
    expect(isProjectDirty()).toBe(false);
  });

  it("reports dirty when a track is renamed", () => {
    // LOAD-BEARING. The exact case the old element-only hash missed.
    setDocument({ a: clip() } as unknown as Timeline);
    markProjectSaved();
    setDocument({ a: clip() } as unknown as Timeline, [
      { ...TRACKS[0], name: "Picture" },
      TRACKS[1],
    ]);
    expect(isProjectDirty()).toBe(true);
  });

  it("reports dirty when tracks are reordered", () => {
    // LOAD-BEARING, and the case the user named specifically.
    setDocument({ a: clip() } as unknown as Timeline);
    markProjectSaved();
    setDocument({ a: clip() } as unknown as Timeline, [
      { ...TRACKS[1], index: 0 },
      { ...TRACKS[0], index: 1 },
    ]);
    expect(isProjectDirty()).toBe(true);
  });

  it("reports dirty when a track is added with no clips on it", () => {
    setDocument({} as Timeline, []);
    markProjectSaved();
    setDocument({} as Timeline, [TRACKS[0]]);
    expect(isProjectDirty()).toBe(true);
  });

  it("reports dirty when the frame rate changes", () => {
    // A rate change rebakes animation and is written into the file, so a
    // project whose only change is its rate must still autosave.
    setDocument({ a: clip() } as unknown as Timeline);
    markProjectSaved();
    renderOptionStore.getState().setFps(30);
    expect(isProjectDirty()).toBe(true);
  });

  it("reports dirty when the background colour changes", () => {
    setDocument({ a: clip() } as unknown as Timeline);
    markProjectSaved();
    renderOptionStore.getState().updateOptions({
      ...renderOptionStore.getState().options,
      backgroundColor: "#ff0000",
    });
    expect(isProjectDirty()).toBe(true);
  });

  it("is unaffected by the playhead", () => {
    // The cursor moves at the display rate during playback and is not in the
    // file. If it reached the digest, every project would be permanently dirty
    // and every ring would be permanently un-droppable.
    setDocument({ a: clip() } as unknown as Timeline);
    markProjectSaved();
    useTimelineStore.getState().setCursor(1234);
    expect(isProjectDirty()).toBe(false);
  });

  it("is unaffected by scroll, zoom range or canvas width", () => {
    setDocument({ a: clip() } as unknown as Timeline);
    markProjectSaved();
    useTimelineStore.getState().setScroll(500);
    useTimelineStore.getState().setRange(0.4);
    useTimelineStore.getState().setCanvasWidth(1200);
    expect(isProjectDirty()).toBe(false);
  });

  it("is unaffected by undo history depth", () => {
    // History is not in the file. A project with fifty undo steps and a
    // project with none are the same project if their documents match.
    setDocument({ a: clip() } as unknown as Timeline);
    markProjectSaved();
    useTimelineStore.setState({
      history: {
        timelineHistory: [
          { tracks: TRACKS, elements: { a: clip() } as unknown as Timeline },
        ],
        historyNow: 0,
      },
    });
    expect(isProjectDirty()).toBe(false);
  });
});

describe("markProjectSaved", () => {
  it("takes the digest from the store by default", () => {
    setDocument({ a: clip() } as unknown as Timeline);
    markProjectSaved();
    expect(projectBaseline()).toBe(currentProjectDigest());
  });

  it("accepts a digest computed before the write", () => {
    // LOAD-BEARING. Auto Save computes the digest, then writes; an edit can
    // land while the bytes are in flight. Marking with the *pre-write* digest
    // is what leaves the project dirty afterwards instead of swallowing that
    // edit — a baseline taken after the write would record a state that was
    // never written.
    setDocument({ a: clip() } as unknown as Timeline);
    const inFlight = currentProjectDigest();

    // the edit that arrives mid-write
    setDocument({ a: clip({ startTime: 250 }) } as unknown as Timeline);

    markProjectSaved(inFlight);
    expect(isProjectDirty()).toBe(true);
  });

  it("leaves the project dirty when it is never called", () => {
    // The failed-save shape: a write that did not land must not mark clean.
    setDocument({ a: clip() } as unknown as Timeline);
    markProjectSaved();
    setDocument({ a: clip({ startTime: 1 }) } as unknown as Timeline);
    // ...a save is attempted and fails, so nothing calls markProjectSaved.
    expect(isProjectDirty()).toBe(true);
  });
});

describe("isProjectEmpty", () => {
  it("is true for a fresh project", () => {
    expect(isProjectEmpty()).toBe(true);
  });

  it("is false with one clip", () => {
    setDocument({ a: clip() } as unknown as Timeline, []);
    expect(isProjectEmpty()).toBe(false);
  });

  it("is false with a track and no clips", () => {
    // Three added rows and nothing else is still work.
    setDocument({} as Timeline, [TRACKS[0]]);
    expect(isProjectEmpty()).toBe(false);
  });

  it("is independent of dirtiness", () => {
    // The two questions are orthogonal, which is the whole reason both exist:
    // a freshly opened project is non-empty and clean, and an emptied one is
    // empty and dirty.
    setDocument({ a: clip() } as unknown as Timeline);
    markProjectSaved();
    expect(isProjectEmpty()).toBe(false);
    expect(isProjectDirty()).toBe(false);

    setDocument({} as Timeline, []);
    expect(isProjectEmpty()).toBe(true);
    expect(isProjectDirty()).toBe(true);
  });
});

describe("currentProjectDigest", () => {
  it("matches a document put through the store", () => {
    setDocument({ a: clip() } as unknown as Timeline);
    const first = currentProjectDigest();
    setDocument({ a: clip() } as unknown as Timeline);
    expect(currentProjectDigest()).toBe(first);
  });

  it("survives patchDocument, which normalizes on the way in", () => {
    // Worth stating: the digest is taken from the store *after*
    // `patchDocument` has normalized, which is why a baseline must never be
    // computed from the file's bytes.
    useTimelineStore.getState().patchDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: TRACKS,
      elements: { a: clip() } as unknown as Timeline,
    });
    const afterPatch = currentProjectDigest();
    expect(afterPatch).toBe(currentProjectDigest());
  });
});
