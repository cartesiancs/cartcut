/**
 * The ephemeral text selection.
 *
 * Two claims, and the second is the one that matters for performance: a
 * collapsed caret is not a range, and writing the range already held notifies
 * nobody. The field's `select` event fires on every pointermove of a drag, so
 * without the guard the preview repaints dozens of times a second to draw the
 * same rectangle.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  textRangeFor,
  textRangeSelectionStore,
} from "./textRangeSelectionStore";

const store = textRangeSelectionStore;

beforeEach(() => {
  store.setState({ range: null });
});

/** How many times a subscriber was woken by the block. */
function notifications(run: () => void): number {
  let count = 0;
  const off = store.subscribe(() => {
    count += 1;
  });
  run();
  off();
  return count;
}

describe("select", () => {
  it("holds a range", () => {
    store.getState().select("a", 2, 7);
    expect(store.getState().range).toEqual({ elementId: "a", from: 2, to: 7 });
  });

  it("orders its ends", () => {
    store.getState().select("a", 7, 2);
    expect(store.getState().range).toEqual({ elementId: "a", from: 2, to: 7 });
  });

  it("treats a collapsed caret as no range", () => {
    store.getState().select("a", 4, 4);
    expect(store.getState().range).toBeNull();
  });

  it("clears a held range when the caret collapses", () => {
    store.getState().select("a", 2, 7);
    store.getState().select("a", 4, 4);
    expect(store.getState().range).toBeNull();
  });
});

describe("waking subscribers", () => {
  it("does not notify for the range already held", () => {
    store.getState().select("a", 2, 7);
    expect(notifications(() => store.getState().select("a", 2, 7))).toBe(0);
  });

  it("notifies when the range moves", () => {
    store.getState().select("a", 2, 7);
    expect(notifications(() => store.getState().select("a", 2, 8))).toBe(1);
  });

  it("notifies when the same range moves to another clip", () => {
    store.getState().select("a", 2, 7);
    expect(notifications(() => store.getState().select("b", 2, 7))).toBe(1);
  });

  it("does not notify clearing an already clear store", () => {
    expect(notifications(() => store.getState().clear())).toBe(0);
  });

  it("does not notify for a caret held against an empty store", () => {
    expect(notifications(() => store.getState().select("a", 4, 4))).toBe(0);
  });
});

describe("textRangeFor", () => {
  it("answers for the clip that holds the selection", () => {
    store.getState().select("a", 2, 7);
    expect(textRangeFor("a")).toEqual({ from: 2, to: 7 });
  });

  it("answers nothing for another clip", () => {
    store.getState().select("a", 2, 7);
    expect(textRangeFor("b")).toBeNull();
  });

  it("answers nothing for no clip and for an empty store", () => {
    store.getState().select("a", 2, 7);
    expect(textRangeFor(undefined)).toBeNull();
    store.getState().clear();
    expect(textRangeFor("a")).toBeNull();
  });
});
