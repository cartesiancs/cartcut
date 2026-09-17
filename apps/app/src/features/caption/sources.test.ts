import { describe, expect, it } from "vitest";
import { captionSources, sourceDisplayName } from "./sources";

const clip = (over: Record<string, unknown> = {}) => ({
  filetype: "video",
  localpath: "file:///tmp/a.mp4",
  duration: 5000,
  ...over,
});

describe("captionSources", () => {
  it("lists video and audio, numbered from one", () => {
    const rows = captionSources({
      v1: clip(),
      a1: clip({ filetype: "audio", localpath: "file:///tmp/b.wav" }),
    });

    expect(rows.map((r) => [r.id, r.key, r.filetype])).toEqual([
      [1, "v1", "video"],
      [2, "a1", "audio"],
    ]);
  });

  it("skips everything with no speech in it", () => {
    const rows = captionSources({
      t1: clip({ filetype: "text" }),
      i1: clip({ filetype: "image" }),
      g1: clip({ filetype: "gif" }),
      s1: clip({ filetype: "shape" }),
      grp: clip({ filetype: "group" }),
      v1: clip(),
    });

    expect(rows.map((r) => r.key)).toEqual(["v1"]);
  });

  it("skips a clip with no source rather than offering one that cannot work", () => {
    // Choosing it would fail with "No such media file" only after the user had
    // picked it and waited.
    const rows = captionSources({
      broken: clip({ localpath: "" }),
      missing: clip({ localpath: undefined }),
      ok: clip(),
    });

    expect(rows.map((r) => r.key)).toEqual(["ok"]);
    expect(rows[0].id).toBe(1);
  });

  it("keeps two clips cut from one file apart", () => {
    // Identifying a row by path lit up both radio buttons and transcribed
    // whichever came first — the defect the key fixes.
    const rows = captionSources({
      first: clip({ localpath: "file:///tmp/same.mp4", duration: 1000 }),
      second: clip({ localpath: "file:///tmp/same.mp4", duration: 2000 }),
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].key).not.toBe(rows[1].key);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it("defaults a missing duration to zero rather than NaN", () => {
    const rows = captionSources({ v1: clip({ duration: undefined }) });
    expect(rows[0].durationMs).toBe(0);
  });

  it("answers empty for anything that is not a timeline", () => {
    expect(captionSources(null)).toEqual([]);
    expect(captionSources(undefined)).toEqual([]);
    expect(captionSources("nope")).toEqual([]);
    expect(captionSources({})).toEqual([]);
  });
});

describe("sourceDisplayName", () => {
  it("is the file name, not the path", () => {
    expect(
      sourceDisplayName("file:///Users/me/Movies/2026/final_cut.mp4"),
    ).toBe("final_cut.mp4");
  });

  it("puts back the one character localpath escapes", () => {
    // `functions/path.ts#encode` escapes `#` and nothing else.
    expect(sourceDisplayName("file:///tmp/take%232.mp4")).toBe("take#2.mp4");
  });

  it("leaves a literal percent alone", () => {
    // `decodeURIComponent` throws on this, and would also wrongly turn a
    // literal %20 in a file name into a space.
    expect(sourceDisplayName("file:///tmp/100%.mp4")).toBe("100%.mp4");
    expect(sourceDisplayName("file:///tmp/a%20b.mp4")).toBe("a%20b.mp4");
  });

  it("handles the malformed Windows localpath", () => {
    // CLAUDE.md: `toLocalPath` concatenates, so Windows mints
    // `file://C:\Users\me\a.mp4` — a drive letter where a URL host goes, with
    // backslashes surviving into what is otherwise a URL.
    expect(sourceDisplayName("file://C:\\Users\\me\\clip.mp4")).toBe("clip.mp4");
  });

  it("does not mistake a trailing slash for the name", () => {
    expect(sourceDisplayName("file:///tmp/folder/")).toBe("folder");
  });

  it("falls back to the whole string when there is no name to take", () => {
    expect(sourceDisplayName("")).toBe("");
    expect(sourceDisplayName(undefined as unknown as string)).toBe("");
  });

  it("keeps a name with no directory at all", () => {
    expect(sourceDisplayName("clip.mp4")).toBe("clip.mp4");
  });
});

describe("captionSources, in timeline order", () => {
  it("sorts by where each clip starts, and numbers after sorting", () => {
    const rows = captionSources({
      late: clip({ startTime: 9000 }),
      early: clip({ startTime: 1000 }),
      middle: clip({ startTime: 4000 }),
    });
    expect(rows.map((r) => [r.id, r.key])).toEqual([
      [1, "early"],
      [2, "middle"],
      [3, "late"],
    ]);
  });

  it("keeps the element map's order for clips starting together", () => {
    const rows = captionSources({ b: clip(), a: clip(), c: clip() });
    expect(rows.map((r) => r.key)).toEqual(["b", "a", "c"]);
  });

  it("reports the timeline length of a sped-up clip, apart from its source length", () => {
    const [row] = captionSources({
      fast: clip({
        startTime: 2000,
        duration: 6000,
        speed: 2,
        trim: { startTime: 1000, endTime: 7000 },
        trackId: "v1",
      }),
    });
    expect(row).toMatchObject({
      startMs: 2000,
      durationMs: 6000,
      spanMs: 3000,
      trimStartMs: 1000,
      trimEndMs: 7000,
      speed: 2,
      trackId: "v1",
    });
  });

  it("reads a missing or broken speed as 1x and a missing trim as the whole clip", () => {
    const [row] = captionSources({ x: clip({ speed: 0 }) });
    expect(row).toMatchObject({
      speed: 1,
      spanMs: 5000,
      trimStartMs: 0,
      trimEndMs: 5000,
      trackId: "",
    });
  });

  it("takes the picture's shape from the decoded frame first", () => {
    const [portrait, squashed, unknown] = captionSources({
      p: clip({ origin: { width: 1080, height: 1920 }, width: 500, height: 500 }),
      s: clip({ width: 400, height: 100 }),
      u: clip({ filetype: "audio" }),
    });
    expect(portrait.aspect).toBeCloseTo(1080 / 1920);
    expect(squashed.aspect).toBe(4);
    expect(unknown.aspect).toBeCloseTo(16 / 9);
  });
});
