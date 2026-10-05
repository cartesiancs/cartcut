import { beforeEach, describe, expect, it } from "vitest";
import { noteStore } from "./noteStore";
import { timelineViewEntryText, trackHeightStore } from "./trackHeightStore";
import { NOTE_TEXT_MAX, type TimelineNote } from "../features/note/notes";

const store = () => noteStore.getState();
const TRACKS = [{ id: "v1" }, { id: "v2" }];

const note = (over: Partial<TimelineNote> = {}): TimelineNote => ({
  id: "n1",
  trackId: "v1",
  atMs: 1000,
  text: "fix the cut",
  ...over,
});

/** Counts notifications, so a no-op write can be shown to wake nobody. */
function notifications(): { count: () => number; stop: () => void } {
  let n = 0;
  const stop = noteStore.subscribe(() => {
    n++;
  });
  return { count: () => n, stop };
}

beforeEach(() => {
  noteStore.setState(noteStore.getInitialState(), true);
  trackHeightStore.setState(trackHeightStore.getInitialState(), true);
});

describe("noteStore", () => {
  it("keeps trimmed text, capped", () => {
    store().add(note({ text: "" }));
    store().setText("n1", "  hello \n");
    expect(store().notes[0].text).toBe("hello");
    store().setText("n1", "x".repeat(NOTE_TEXT_MAX + 50));
    expect(store().notes[0].text).toHaveLength(NOTE_TEXT_MAX);
  });

  it("removes a note whose text is set to nothing, and closes its card", () => {
    store().add(note());
    store().openAt("n1", 10, 20);
    store().setText("n1", "   ");
    expect(store().notes).toEqual([]);
    expect(store().open).toBeNull();
  });

  it("closes the card of a removed note and leaves another open", () => {
    store().add(note());
    store().add(note({ id: "n2" }));
    store().openAt("n2", 0, 0);
    store().remove("n1");
    expect(store().open?.id).toBe("n2");
    store().remove("n2");
    expect(store().open).toBeNull();
  });

  it("notifies nobody for a write that changes nothing", () => {
    store().add(note());
    store().openAt("n1", 1, 2);
    const seen = notifications();
    store().setText("n1", "fix the cut");
    store().setText("gone", "text");
    store().remove("gone");
    store().openAt("n1", 1, 2);
    expect(seen.count()).toBe(0);
    store().close();
    expect(seen.count()).toBe(1);
    store().close();
    // Only a no-op with the card closed: a load always closes it.
    store().replace([note()]);
    seen.stop();
    expect(seen.count()).toBe(1);
  });

  it("replaces everything on load and closes the card", () => {
    store().add(note());
    store().openAt("n1", 0, 0);
    store().replace([note({ id: "n9" })]);
    expect(store().notes.map((each) => each.id)).toEqual(["n9"]);
    expect(store().open).toBeNull();
  });
});

describe("the timelineView entry", () => {
  it("does not write a note still being composed", () => {
    // Opening a new note must not make the project dirty.
    store().add(note({ text: "" }));
    expect(timelineViewEntryText(TRACKS)).toBeNull();
  });

  it("writes kept notes beside the heights", () => {
    store().add(note());
    trackHeightStore.getState().preview("v2", 90);
    trackHeightStore.getState().commit();
    expect(JSON.parse(timelineViewEntryText(TRACKS)!)).toEqual({
      v: 1,
      trackHeights: { v2: 90 },
      notes: [note()],
    });
  });

  it("keeps a deleted track's note in memory, so undoing the delete restores it", () => {
    store().add(note());
    expect(timelineViewEntryText([{ id: "v2" }])).toBeNull();
    expect(store().notes).toHaveLength(1);
    expect(timelineViewEntryText(TRACKS)).not.toBeNull();
  });
});
