import { describe, it, expect, beforeEach } from "vitest";
import {
  addTrack,
  capabilities,
  copySelection,
  cutSelection,
  deleteSelection,
  mergeSelection,
  pasteFromClipboard,
  redo,
  rotateSelection,
  splitSelection,
  undo,
} from "./actions";
import { useTimelineStore } from "../../states/timelineStore";
import { selectionStore } from "../../states/selectionStore";
import { createTrack } from "../timeline/tracks";
import { audioElement, videoElement } from "../renderer/testing";

const store = () => useTimelineStore.getState();
const elements = () => store().timeline;
const historyLength = () => store().history.timelineHistory.length;
const select = (ids: string[]) => selectionStore.getState().setIds(ids);

/**
 * One 4s video on one track, with the playhead at zero and an undo baseline
 * already recorded — the store keeps post-edit snapshots only, so without a
 * first checkpoint there is nothing for `undo` to step back to.
 */
function seed(extra: Record<string, any> = {}) {
  useTimelineStore.setState({
    timeline: {},
    tracks: [createTrack("t0", "video", 0)],
    cursor: 0,
    history: { timelineHistory: [], historyNow: -1 },
  });
  selectionStore.setState({ ids: [], clipboard: {} });

  store().withCheckpoint(() => ({
    schemaVersion: 2 as const,
    tracks: [createTrack("t0", "video", 0)],
    elements: { a: videoElement({ trackId: "t0" }), ...extra },
  }));
}

describe("splitSelection", () => {
  beforeEach(() => seed());

  it("cuts the selected clip at the playhead", () => {
    select(["a"]);
    store().setCursor(1500);

    splitSelection();

    expect(Object.keys(elements())).toHaveLength(2);
  });

  it("records no undo step when the playhead is off the clip", () => {
    select(["a"]);
    store().setCursor(0);
    const before = historyLength();

    splitSelection();

    expect(historyLength()).toBe(before);
    expect(Object.keys(elements())).toHaveLength(1);
  });
});

describe("cutSelection", () => {
  beforeEach(() => seed());

  it("removes the clip and fills the clipboard", () => {
    select(["a"]);

    cutSelection();

    expect(elements().a).toBeUndefined();
    expect(Object.keys(selectionStore.getState().clipboard)).toEqual(["a"]);
  });

  // Filling the clipboard is not an edit, so only the delete records — which is
  // what makes one Cmd+Z put the clip back.
  it("is a single undo step", () => {
    select(["a"]);
    const before = historyLength();

    cutSelection();

    expect(historyLength()).toBe(before + 1);
    undo();
    expect(elements().a).toBeDefined();
  });

  it("leaves nothing selected", () => {
    select(["a"]);

    cutSelection();

    expect(selectionStore.getState().ids).toEqual([]);
  });
});

describe("copy and paste", () => {
  beforeEach(() => seed());

  it("pastes a copied clip at the playhead", () => {
    select(["a"]);
    copySelection();
    store().setCursor(5000);

    pasteFromClipboard();

    const pasted = Object.entries(elements()).find(([id]) => id !== "a");
    expect(pasted).toBeDefined();
    expect(pasted?.[1].startTime).toBe(5000);
  });

  it("deep-clones, so a later edit does not reach the clipboard", () => {
    select(["a"]);
    copySelection();

    store().withCheckpoint((doc) => ({
      ...doc,
      elements: {
        ...doc.elements,
        a: { ...doc.elements.a, startTime: 9000 } as any,
      },
    }));

    expect(selectionStore.getState().clipboard.a.startTime).toBe(0);
  });
});

describe("mergeSelection", () => {
  beforeEach(() => seed());

  it("rejoins the halves of a split and selects the survivor", () => {
    select(["a"]);
    store().setCursor(1500);
    splitSelection();

    const ids = Object.keys(elements());
    select(ids);
    mergeSelection();

    expect(Object.keys(elements())).toEqual(["a"]);
    expect(selectionStore.getState().ids).toEqual(["a"]);
  });

  // A press that changes nothing must also not disturb what is selected.
  it("leaves the selection alone when it declines", () => {
    select(["a"]);
    const before = historyLength();

    mergeSelection();

    expect(historyLength()).toBe(before);
    expect(selectionStore.getState().ids).toEqual(["a"]);
  });
});

describe("rotateSelection", () => {
  beforeEach(() => seed());

  it("turns the selection and records one step", () => {
    select(["a"]);
    const before = historyLength();

    rotateSelection(90);

    expect(elements().a.rotation).toBe(90);
    expect(historyLength()).toBe(before + 1);
  });

  it("records no step when nothing in the selection can turn", () => {
    seed({ b: audioElement({ trackId: "t0", startTime: 8000 }) });
    select(["b"]);
    const before = historyLength();

    rotateSelection(90);

    expect(historyLength()).toBe(before);
  });
});

describe("capabilities", () => {
  beforeEach(() => seed());

  it("offers nothing that needs a selection when none is made", () => {
    const caps = capabilities();

    expect(caps.canDelete).toBe(false);
    expect(caps.canCopy).toBe(false);
    expect(caps.canCut).toBe(false);
    expect(caps.canSplit).toBe(false);
    expect(caps.canMerge).toBe(false);
    expect(caps.canRotate).toBe(false);
  });

  it("allows a split only when the playhead is strictly inside a clip", () => {
    select(["a"]);

    store().setCursor(0);
    expect(capabilities().canSplit).toBe(false);

    store().setCursor(1500);
    expect(capabilities().canSplit).toBe(true);

    // Half-open spans: the far edge belongs to whatever comes next.
    store().setCursor(4000);
    expect(capabilities().canSplit).toBe(false);
  });

  it("allows a paste only once something has been copied", () => {
    expect(capabilities().canPaste).toBe(false);

    select(["a"]);
    copySelection();

    expect(capabilities().canPaste).toBe(true);
  });

  it("tracks what undo and redo can actually reach", () => {
    select(["a"]);
    rotateSelection(90);
    expect(capabilities().canUndo).toBe(true);
    expect(capabilities().canRedo).toBe(false);

    undo();
    expect(capabilities().canRedo).toBe(true);

    redo();
    expect(capabilities().canRedo).toBe(false);
  });

  it("offers detach-audio only for video that still has audio attached", () => {
    seed({ b: audioElement({ trackId: "t0", startTime: 8000 }) });

    select(["a"]);
    expect(capabilities().canDetachAudio).toBe(true);

    select(["b"]);
    expect(capabilities().canDetachAudio).toBe(false);
  });
});

describe("addTrack", () => {
  beforeEach(() => seed());

  const tracks = () => store().tracks;

  it("adds a row of the kind asked for, in one undo step", () => {
    const before = historyLength();

    addTrack("audio");

    expect(tracks()).toHaveLength(2);
    expect(tracks().some((track) => track.kind === "audio")).toBe(true);
    expect(historyLength()).toBe(before + 1);

    undo();
    expect(tracks()).toHaveLength(1);
  });

  // Where the row lands is `appendTrackOfKind`'s rule, and the reason the
  // action does not choose an index itself: a caption behind the picture is not
  // a caption.
  it("puts a first text row in front of the picture", () => {
    addTrack("text");

    const text = tracks().find((track) => track.kind === "text");
    const video = tracks().find((track) => track.kind === "video");
    expect(text!.index).toBeLessThan(video!.index);
  });

  it("stacks a second row of a kind on top of the first", () => {
    addTrack("audio");
    addTrack("audio");

    const audio = tracks().filter((track) => track.kind === "audio");
    expect(audio).toHaveLength(2);
    // Indices are re-derived with no holes, so the two are adjacent rows.
    expect(Math.abs(audio[0].index - audio[1].index)).toBe(1);
  });

  it("leaves the clips alone", () => {
    addTrack("video");

    expect(elements().a).toBeDefined();
    expect(elements().a.trackId).toBe("t0");
  });

  it("needs no selection", () => {
    select([]);
    const before = historyLength();

    addTrack("effect");

    expect(historyLength()).toBe(before + 1);
    expect(tracks().some((track) => track.kind === "effect")).toBe(true);
  });
});

describe("deleteSelection", () => {
  beforeEach(() => seed());

  it("removes the clips and clears the selection", () => {
    select(["a"]);

    deleteSelection();

    expect(elements().a).toBeUndefined();
    expect(selectionStore.getState().ids).toEqual([]);
  });

  it("records no step for an empty selection", () => {
    const before = historyLength();

    deleteSelection();

    expect(historyLength()).toBe(before);
  });
});
