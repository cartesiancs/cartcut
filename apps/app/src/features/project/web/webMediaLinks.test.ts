import { describe, expect, it } from "vitest";
import {
  blobPathsIn,
  identitiesFor,
  identityKey,
  matchPicked,
  nameFromPath,
  parseWebMediaEntry,
  rewritePaths,
  webMediaEntry,
  type MediaIdentity,
} from "./webMediaLinks";

const A = "blob:https://site/1111#take.mp4";
const B = "blob:https://site/2222#photo.png";

describe("blobPathsIn", () => {
  it("finds blob paths anywhere in a document, and nothing else", () => {
    const doc = {
      e1: { localpath: A, filetype: "video", params: { image: B, label: "blob is a word" } },
      e2: { localpath: "/examples/templates/x/media/a.mp4" },
      e3: { list: [A, "https://cdn/x.png"] },
    };
    expect([...blobPathsIn(doc)]).toEqual([A, B]);
  });
});

describe("nameFromPath", () => {
  it("reads the name the fragment carries", () => {
    expect(nameFromPath(A)).toBe("take.mp4");
    expect(nameFromPath("blob:https://site/1111#%ED%95%9C%EA%B8%80.mov")).toBe("한글.mov");
    expect(nameFromPath("blob:https://site/1111")).toBe("");
  });
});

describe("webMediaEntry and parseWebMediaEntry", () => {
  const known: Record<string, MediaIdentity> = {
    [A]: { name: "take.mp4", size: 1000, lastModified: 5, type: "video/mp4" },
  };

  it("records what each readable path was, and round-trips", () => {
    const text = webMediaEntry([A, B], (path) => known[path] ?? null);
    expect(text).not.toBeNull();
    expect(parseWebMediaEntry(text).get(A)).toEqual(known[A]);
    expect(parseWebMediaEntry(text).has(B)).toBe(false);
  });

  it("writes nothing when there is nothing to record, so other projects are unchanged", () => {
    expect(webMediaEntry([], () => null)).toBeNull();
    expect(webMediaEntry([B], () => null)).toBeNull();
  });

  it("reads a malformed entry as empty rather than throwing", () => {
    expect(parseWebMediaEntry("{").size).toBe(0);
    expect(parseWebMediaEntry(JSON.stringify({ files: { "/not/blob": { name: "x" } } })).size).toBe(0);
    expect(parseWebMediaEntry(null).size).toBe(0);
  });
});

describe("identitiesFor", () => {
  it("falls back to the fragment's name for a path the entry does not cover", () => {
    const entry = new Map([[A, { name: "take.mp4", size: 1000, lastModified: 5, type: "video/mp4" }]]);
    const out = identitiesFor([A, B], entry);
    expect(out.get(A)?.size).toBe(1000);
    expect(out.get(B)).toEqual({ name: "photo.png", size: null, lastModified: null, type: "" });
  });
});

describe("matchPicked", () => {
  const missing = new Map<string, MediaIdentity>([
    [A, { name: "take.mp4", size: 1000, lastModified: 5, type: "video/mp4" }],
    [B, { name: "photo.png", size: null, lastModified: null, type: "" }],
  ]);

  it("matches by name and size, and by name alone where the size was not recorded", () => {
    const out = matchPicked(missing, [
      { name: "photo.png", size: 77, lastModified: 1 },
      { name: "take.mp4", size: 1000, lastModified: 9 },
    ]);
    expect(out.get(A)).toBe(1);
    expect(out.get(B)).toBe(0);
  });

  it("refuses a same-named file of another size: a different take", () => {
    expect(matchPicked(missing, [{ name: "take.mp4", size: 999, lastModified: 5 }]).has(A)).toBe(false);
  });

  it("prefers the exact name, then the same modification time", () => {
    const out = matchPicked(missing, [
      { name: "TAKE.mp4", size: 1000, lastModified: 5 },
      { name: "take.mp4", size: 1000, lastModified: 4 },
      { name: "take.mp4", size: 1000, lastModified: 5 },
    ]);
    expect(out.get(A)).toBe(2);
  });

  it("accepts a name differing only in case when nothing better is there", () => {
    expect(matchPicked(missing, [{ name: "Take.MP4", size: 1000, lastModified: 0 }]).get(A)).toBe(0);
  });
});

describe("rewritePaths", () => {
  it("replaces exact matches and returns untouched parts by identity", () => {
    const untouched = { localpath: "/a.mp4" };
    const doc = { e1: { localpath: A, tags: [A, "x"] }, e2: untouched };
    const out = rewritePaths(doc, new Map([[A, "blob:https://site/9999#take.mp4"]]));
    expect(out.e1.localpath).toBe("blob:https://site/9999#take.mp4");
    expect(out.e1.tags).toEqual(["blob:https://site/9999#take.mp4", "x"]);
    expect(out.e2).toBe(untouched);
    expect(rewritePaths(doc, new Map())).toBe(doc);
  });
});

describe("identityKey", () => {
  it("is the same key the imported media list dedupes by", () => {
    expect(identityKey({ name: "a.mp4", size: 3, lastModified: 4 })).toBe("a.mp4\u00003\u00004");
  });
});
