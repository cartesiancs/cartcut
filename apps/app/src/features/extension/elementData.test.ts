import { describe, expect, it } from "vitest";

import { MAX_ELEMENT_DATA_BYTES, elementExtData, setElementExtData } from "./elementData";
import type { TimelineDocument } from "../timeline/tracks";

function docWith(ext?: Record<string, unknown>): TimelineDocument {
  return {
    schemaVersion: 2,
    tracks: [{ id: "t1", kind: "video", name: "Video 1", index: 0 }],
    elements: {
      a: {
        ...(ext == null ? {} : { ext }),
        priority: 1,
        blob: "",
        startTime: 0,
        duration: 1000,
        location: { x: 0, y: 0 },
        timelineOptions: { color: "#fff" },
        trackId: "t1",
        filetype: "text",
      } as never,
    },
  } as TimelineDocument;
}

function set(doc: TimelineDocument, owner: string, value: unknown) {
  const result = setElementExtData(doc, "a", owner, value as never);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.document;
}

describe("setElementExtData", () => {
  it("stores a value under the owner's id", () => {
    const next = set(docWith(), "acme.hello", { note: "hi" });
    expect((next.elements.a as never as { ext: unknown }).ext).toEqual({ "acme.hello": { note: "hi" } });
  });

  it("returns the document by identity when the value is unchanged", () => {
    // The decline rule every pure op here follows. Without it an extension
    // that recomputes on each document change fills the undo history.
    const doc = set(docWith(), "acme.hello", { note: "hi" });
    expect(setElementExtData(doc, "a", "acme.hello", { note: "hi" } as never)).toMatchObject({
      ok: true,
      document: doc,
    });
  });

  it("returns by identity when clearing something that was never there", () => {
    const doc = docWith();
    expect(setElementExtData(doc, "a", "acme.hello", null)).toMatchObject({ ok: true, document: doc });
  });

  it("deletes the owner's key rather than storing null", () => {
    const doc = set(set(docWith(), "a.one", 1), "b.two", 2);
    const next = set(doc, "a.one", null);
    expect((next.elements.a as never as { ext: unknown }).ext).toEqual({ "b.two": 2 });
  });

  it("deletes the whole object when the last owner clears", () => {
    // This is what makes a project nobody ran an extension on byte-identical
    // to one saved before extensions existed, so SCHEMA_VERSION never moves.
    const doc = set(docWith(), "a.one", 1);
    const next = set(doc, "a.one", null);
    expect("ext" in (next.elements.a as never as Record<string, unknown>)).toBe(false);
  });

  it("never mutates the document it was given", () => {
    const doc = docWith();
    const snapshot = JSON.stringify(doc);
    set(doc, "acme.hello", { note: "hi" });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it("leaves other elements untouched by identity", () => {
    const doc = docWith();
    const next = set(doc, "acme.hello", 1);
    expect(next.tracks).toBe(doc.tracks);
  });

  it("one extension cannot read or clear another's key", () => {
    const doc = set(docWith(), "a.one", "mine");
    expect(elementExtData(doc.elements.a, "b.two")).toBeNull();
    const next = set(doc, "b.two", null);
    expect(elementExtData(next.elements.a, "a.one")).toBe("mine");
  });

  it("refuses a value over the cap", () => {
    const huge = { blob: "x".repeat(MAX_ELEMENT_DATA_BYTES + 100) };
    expect(setElementExtData(docWith(), "a", "acme.hello", huge as never)).toMatchObject({ ok: false });
  });

  it("refuses a clip that does not exist", () => {
    expect(setElementExtData(docWith(), "nope", "acme.hello", 1 as never)).toMatchObject({ ok: false });
  });
});
