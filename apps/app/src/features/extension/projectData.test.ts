import { describe, expect, it } from "vitest";

import {
  EXTENSIONS_ENTRY_VERSION,
  MAX_PROJECT_DATA_BYTES,
  parseExtensionsEntry,
  serializeExtensionsEntry,
  withProjectData,
} from "./projectData";

describe("serializeExtensionsEntry", () => {
  it("answers null when nothing is stored", () => {
    // Null rather than "{}": an empty object would still be a zip entry, and a
    // project nobody ran an extension on would stop being byte-identical to
    // one saved before this existed.
    expect(serializeExtensionsEntry({})).toBeNull();
  });

  it("produces the same bytes for the same data whatever order it was built in", () => {
    // `projectDigest.ts` hashes this text, so key order following insertion
    // would make an unchanged project read as edited.
    const a = serializeExtensionsEntry({ "b.two": 2, "a.one": 1 } as never);
    const b = serializeExtensionsEntry({ "a.one": 1, "b.two": 2 } as never);
    expect(a).toBe(b);
  });

  it("round trips", () => {
    const data = { "acme.hello": { note: "hi", ids: [1, 2, 3] } } as never;
    expect(parseExtensionsEntry(serializeExtensionsEntry(data))).toEqual(data);
  });
});

describe("parseExtensionsEntry", () => {
  it("fails closed on anything it cannot read", () => {
    // It runs while a project is being opened. A throw here would make the
    // project refuse to open over an extension's bookkeeping.
    for (const value of [null, undefined, "", "   ", "{ not json", "[]", '"a string"']) {
      expect([String(value), parseExtensionsEntry(value as never)]).toEqual([String(value), {}]);
    }
  });

  it("refuses an envelope from a version it does not know", () => {
    const text = JSON.stringify({ v: EXTENSIONS_ENTRY_VERSION + 1, data: { "a.b": 1 } });
    expect(parseExtensionsEntry(text)).toEqual({});
  });

  it("refuses data that is not an object", () => {
    expect(parseExtensionsEntry(JSON.stringify({ v: 1, data: [1, 2] }))).toEqual({});
  });
});

describe("withProjectData", () => {
  it("stores under the extension's own id", () => {
    const result = withProjectData({}, "acme.hello", { note: "hi" } as never);
    expect(result).toEqual({ ok: true, data: { "acme.hello": { note: "hi" } } });
  });

  it("returns the same object when nothing changed", () => {
    const data = { "acme.hello": 1 } as never;
    expect(withProjectData(data, "acme.hello", 1 as never)).toMatchObject({ ok: true, data });
    expect(withProjectData(data, "other.ext", null)).toMatchObject({ ok: true, data });
  });

  it("deletes the key rather than storing null", () => {
    const result = withProjectData({ "a.one": 1, "b.two": 2 } as never, "a.one", null);
    expect(result).toEqual({ ok: true, data: { "b.two": 2 } });
  });

  it("refuses a value over the cap", () => {
    const huge = { blob: "x".repeat(MAX_PROJECT_DATA_BYTES + 100) } as never;
    expect(withProjectData({}, "acme.hello", huge)).toMatchObject({ ok: false });
  });

  it("never mutates what it was given", () => {
    const data = { "a.one": 1 } as never;
    const snapshot = JSON.stringify(data);
    withProjectData(data, "b.two", 2 as never);
    expect(JSON.stringify(data)).toBe(snapshot);
  });
});
