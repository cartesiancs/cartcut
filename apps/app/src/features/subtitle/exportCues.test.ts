import { describe, expect, it } from "vitest";
import type { CaptionIds } from "../caption/applyCaptions";
import { textElement, videoElement } from "../renderer/testing";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";
import { normalizeCues, type SubtitleCue } from "./cues";
import { cuesFromDocument, exportScopeFor } from "./exportCues";
import { importSubtitles } from "./importCues";
import { parseSubtitles } from "./parse";
import { serializeSubtitles } from "./serialize";

function doc(elements: Record<string, unknown> = {}): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("t1", "text", 0), createTrack("v1", "video", 1)],
    elements,
  });
}

const caption = (
  id: string,
  startTime: number,
  duration: number,
  text: string,
  trackId = "t1",
) => ({
  [id]: textElement({ trackId, startTime, duration, text }),
});

describe("cuesFromDocument", () => {
  it("reads every text clip as a cue, in time order", () => {
    const d = doc({
      ...caption("b", 3000, 1000, "second"),
      ...caption("a", 1000, 1500, "first"),
    });

    expect(cuesFromDocument(d, { kind: "all" })).toEqual([
      { startMs: 1000, endMs: 2500, text: "first" },
      { startMs: 3000, endMs: 4000, text: "second" },
    ]);
  });

  it("ignores everything that is not a text clip", () => {
    const d = doc({
      ...caption("a", 0, 1000, "words"),
      clip: videoElement({ trackId: "v1", startTime: 0, duration: 4000 }),
    });

    expect(cuesFromDocument(d, { kind: "all" })).toHaveLength(1);
  });

  it("keeps overlapping captions as overlapping cues", () => {
    // Both formats permit overlap, and merging would invent a line break the
    // user never typed.
    const d = doc({
      ...caption("a", 0, 5000, "under"),
      ...caption("b", 1000, 1000, "over", "t1"),
    });

    expect(cuesFromDocument(d, { kind: "all" })).toEqual([
      { startMs: 0, endMs: 5000, text: "under" },
      { startMs: 1000, endMs: 2000, text: "over" },
    ]);
  });

  it("drops a caption with no words", () => {
    const d = doc({ ...caption("a", 0, 1000, "   "), ...caption("b", 2000, 1000, "kept") });

    expect(cuesFromDocument(d, { kind: "all" }).map((c) => c.text)).toEqual(["kept"]);
  });

  it("keeps a caption's own line breaks", () => {
    const d = doc(caption("a", 0, 1000, "two\nlines"));

    expect(cuesFromDocument(d, { kind: "all" })[0].text).toBe("two\nlines");
  });

  it("narrows to the elements it was given", () => {
    const d = doc({ ...caption("a", 0, 1000, "a"), ...caption("b", 2000, 1000, "b") });

    expect(cuesFromDocument(d, { kind: "elements", ids: ["b"] }).map((c) => c.text)).toEqual(
      ["b"],
    );
  });

  it("writes a repeated id once", () => {
    const d = doc(caption("a", 0, 1000, "a"));

    expect(cuesFromDocument(d, { kind: "elements", ids: ["a", "a"] })).toHaveLength(1);
  });

  it("ignores an id that names nothing", () => {
    const d = doc(caption("a", 0, 1000, "a"));

    expect(cuesFromDocument(d, { kind: "elements", ids: ["a", "gone"] })).toHaveLength(1);
  });

  it("answers with nothing for a project holding no text", () => {
    expect(cuesFromDocument(doc(), { kind: "all" })).toEqual([]);
  });
});

describe("exportScopeFor", () => {
  const d = () =>
    doc({
      ...caption("a", 0, 1000, "a"),
      ...caption("b", 2000, 1000, "b"),
      clip: videoElement({ trackId: "v1", startTime: 0, duration: 4000 }),
    });

  it("narrows to the selected captions", () => {
    expect(exportScopeFor(d(), ["b"])).toEqual({ kind: "elements", ids: ["b"] });
  });

  it("takes the whole project when nothing is selected", () => {
    expect(exportScopeFor(d(), [])).toEqual({ kind: "all" });
  });

  it("takes the whole project when the selection holds no text", () => {
    // Selecting a video clip says nothing about wanting a narrower export, and
    // answering with an empty file would be a worse reading of it.
    expect(exportScopeFor(d(), ["clip"])).toEqual({ kind: "all" });
  });

  it("keeps only the text out of a mixed selection", () => {
    expect(exportScopeFor(d(), ["clip", "a"])).toEqual({
      kind: "elements",
      ids: ["a"],
    });
  });

  it("ignores an id that names nothing", () => {
    expect(exportScopeFor(d(), ["gone"])).toEqual({ kind: "all" });
  });
});

describe("import and export agree", () => {
  // The end-to-end proof. The two directions share nothing but `SubtitleCue`
  // and `normalizeCues`, so this is the only test that can catch one half being
  // changed without the other.
  const CUES: SubtitleCue[] = [
    { startMs: 0, endMs: 900, text: "first" },
    { startMs: 1000, endMs: 2500, text: "second,\nover two rows" },
    { startMs: 3000, endMs: 4000, text: "Tom & Jerry" },
    { startMs: 5000, endMs: 6000, text: "한글 자막" },
  ];

  const ids: CaptionIds[] = CUES.map((_, n) => ({
    element: `caption${n + 1}`,
    track: `text${n + 1}`,
  }));

  const placed = () =>
    importSubtitles(doc(), {
      cues: CUES,
      frame: { w: 1920, h: 1080 },
      sourceKey: null,
      ids,
    });

  it("gets the same cues back off the timeline", () => {
    expect(cuesFromDocument(placed(), { kind: "all" })).toEqual(normalizeCues(CUES));
  });

  it("survives a whole file round trip through SubRip", () => {
    const written = serializeSubtitles(cuesFromDocument(placed(), { kind: "all" }), "srt");

    expect(parseSubtitles(written, "a.srt").cues).toEqual(normalizeCues(CUES));
  });

  it("survives a whole file round trip through WebVTT", () => {
    const written = serializeSubtitles(cuesFromDocument(placed(), { kind: "all" }), "vtt");

    expect(parseSubtitles(written, "a.vtt").cues).toEqual(normalizeCues(CUES));
  });

  it("re-imports a file it exported to the same timeline", () => {
    const first = placed();
    const written = serializeSubtitles(cuesFromDocument(first, { kind: "all" }), "srt");
    const again = importSubtitles(doc(), {
      cues: parseSubtitles(written).cues,
      frame: { w: 1920, h: 1080 },
      sourceKey: null,
      ids,
    });

    expect(cuesFromDocument(again, { kind: "all" })).toEqual(
      cuesFromDocument(first, { kind: "all" }),
    );
  });

  // Proves the four cases above measure something. Hand the two sides different
  // input and require them to disagree.
  it("does not answer the same for a timeline one cue different", () => {
    const shifted = importSubtitles(doc(), {
      cues: CUES.map((cue, n) => (n === 1 ? { ...cue, startMs: cue.startMs + 1 } : cue)),
      frame: { w: 1920, h: 1080 },
      sourceKey: null,
      ids,
    });

    expect(cuesFromDocument(shifted, { kind: "all" })).not.toEqual(
      cuesFromDocument(placed(), { kind: "all" }),
    );
  });
});
