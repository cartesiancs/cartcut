import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectionStore } from "./selectionStore";

const reset = () => selectionStore.setState({ ids: [], clipboard: {} });
const ids = () => selectionStore.getState().ids;

describe("selectionStore", () => {
  beforeEach(reset);

  it("holds the selection in the order it was given", () => {
    selectionStore.getState().setIds(["c", "a", "b"]);

    expect(ids()).toEqual(["c", "a", "b"]);
  });

  it("copies the array in, so a caller's later mutation cannot leak", () => {
    const mine = ["a"];
    selectionStore.getState().setIds(mine);
    mine.push("b");

    expect(ids()).toEqual(["a"]);
  });

  // The guard that keeps a drag from churning the store: the canvas reassigns
  // `targetId` on every hit-test, and most of those name what was already
  // selected.
  it("does not notify when the same ids are set again", () => {
    selectionStore.getState().setIds(["a", "b"]);

    const listener = vi.fn();
    const unsubscribe = selectionStore.subscribe(listener);
    selectionStore.getState().setIds(["a", "b"]);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies when the order changes, which is a different selection", () => {
    selectionStore.getState().setIds(["a", "b"]);

    const listener = vi.fn();
    const unsubscribe = selectionStore.subscribe(listener);
    selectionStore.getState().setIds(["b", "a"]);
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(["b", "a"]);
  });

  it("clears, and does not notify when already empty", () => {
    selectionStore.getState().setIds(["a"]);
    selectionStore.getState().clear();
    expect(ids()).toEqual([]);

    const listener = vi.fn();
    const unsubscribe = selectionStore.subscribe(listener);
    selectionStore.getState().clear();
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps the clipboard keyed by the copied clips' original ids", () => {
    const clip = { key: "a", filetype: "video" } as any;
    selectionStore.getState().setClipboard({ a: clip });

    expect(selectionStore.getState().clipboard).toEqual({ a: clip });
  });

  it("keeps the clipboard across a selection change", () => {
    selectionStore.getState().setClipboard({ a: { key: "a" } as any });
    selectionStore.getState().setIds(["b"]);

    expect(Object.keys(selectionStore.getState().clipboard)).toEqual(["a"]);
  });
});
