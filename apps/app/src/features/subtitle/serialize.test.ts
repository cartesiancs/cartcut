import { describe, expect, it } from "vitest";
import { normalizeCues, type SubtitleCue } from "./cues";
import { parseSubtitles } from "./parse";
import { serializeSubtitles, toSrt, toVtt } from "./serialize";

const CUES: SubtitleCue[] = [
  { startMs: 1000, endMs: 2500, text: "First line." },
  { startMs: 3000, endMs: 4000, text: "Second line,\nover two rows." },
];

describe("toSrt", () => {
  it("writes the file a player expects", () => {
    expect(toSrt(CUES)).toBe(
      [
        "1",
        "00:00:01,000 --> 00:00:02,500",
        "First line.",
        "",
        "2",
        "00:00:03,000 --> 00:00:04,000",
        "Second line,",
        "over two rows.",
        "",
      ].join("\n"),
    );
  });

  it("numbers cues after sorting, not before", () => {
    // Numbering in the caller's order would emit a file whose indices and
    // timestamps disagree, which some players read and some refuse.
    const out = toSrt([CUES[1], CUES[0]]);
    expect(out.indexOf("1\n00:00:01,000")).toBe(0);
    expect(out).toContain("2\n00:00:03,000");
  });

  it("leaves an ampersand alone", () => {
    // SubRip has no entity syntax, so escaping would burn `&amp;` into the
    // picture for a user who typed `Tom & Jerry`.
    expect(toSrt([{ startMs: 0, endMs: 1, text: "Tom & Jerry <i>x</i>" }])).toContain(
      "Tom & Jerry <i>x</i>",
    );
  });

  it("answers with an empty string for no cues", () => {
    expect(toSrt([])).toBe("");
  });
});

describe("toVtt", () => {
  it("writes the signature, dots, and no cue numbers", () => {
    expect(toVtt(CUES)).toBe(
      [
        "WEBVTT",
        "",
        "00:00:01.000 --> 00:00:02.500",
        "First line.",
        "",
        "00:00:03.000 --> 00:00:04.000",
        "Second line,",
        "over two rows.",
        "",
      ].join("\n"),
    );
  });

  it("escapes the three characters that are markup here", () => {
    expect(toVtt([{ startMs: 0, endMs: 1, text: "a & b < c > d" }])).toContain(
      "a &amp; b &lt; c &gt; d",
    );
  });

  it("escapes the ampersand first, so a bracket does not come out double-escaped", () => {
    expect(toVtt([{ startMs: 0, endMs: 1, text: "<i>" }])).toContain("&lt;i&gt;");
  });

  it("keeps the signature with no cues, since a header-only file is still valid", () => {
    expect(toVtt([])).toBe("WEBVTT\n\n");
  });
});

describe("serializeSubtitles", () => {
  it("dispatches on the flavour", () => {
    expect(serializeSubtitles(CUES, "srt")).toBe(toSrt(CUES));
    expect(serializeSubtitles(CUES, "vtt")).toBe(toVtt(CUES));
  });
});

describe("the two halves of the format layer agree", () => {
  // The bidirectional guarantee. Reading and writing share nothing but
  // `SubtitleCue` and `normalizeCues`, so this is the only thing that can catch
  // them drifting apart.
  //
  // Markup-free, because that is the part both formats can carry. The angle
  // brackets get their own cases below, where the two formats genuinely differ.
  const ROUND_TRIP: SubtitleCue[] = [
    { startMs: 0, endMs: 1, text: "the shortest cue there is" },
    { startMs: 1000, endMs: 2500, text: "plain" },
    { startMs: 2500, endMs: 3000, text: "two\nlines" },
    { startMs: 3000, endMs: 4000, text: "Tom & Jerry" },
    { startMs: 5000, endMs: 6000, text: "\ud55c\uae00\uacfc \u65e5\u672c\u8a9e" },
    { startMs: 3_600_000, endMs: 3_601_000, text: "an hour in" },
  ];

  it("round trips through SubRip", () => {
    expect(parseSubtitles(toSrt(ROUND_TRIP), "a.srt").cues).toEqual(
      normalizeCues(ROUND_TRIP),
    );
  });

  it("round trips through WebVTT", () => {
    expect(parseSubtitles(toVtt(ROUND_TRIP), "a.vtt").cues).toEqual(
      normalizeCues(ROUND_TRIP),
    );
  });

  it("round trips with nothing skipped either way", () => {
    expect(parseSubtitles(toSrt(ROUND_TRIP)).skipped).toBe(0);
    expect(parseSubtitles(toVtt(ROUND_TRIP)).skipped).toBe(0);
  });

  it("reports the flavour it was handed", () => {
    expect(parseSubtitles(toVtt(ROUND_TRIP)).flavour).toBe("vtt");
    expect(parseSubtitles(toSrt(ROUND_TRIP)).flavour).toBe("srt");
  });

  // Proves the round trips above measure something. If the parser ignored cue
  // text entirely, or the writer emitted a fixed timestamp, every assertion
  // above could still pass against a suitably broken pair.
  it("does not confuse two files that differ by one cue", () => {
    const shifted = ROUND_TRIP.map((cue, index) =>
      index === 1 ? { ...cue, startMs: cue.startMs + 1 } : cue,
    );

    expect(parseSubtitles(toSrt(shifted)).cues).not.toEqual(
      parseSubtitles(toSrt(ROUND_TRIP)).cues,
    );
  });
});

describe("what each format can and cannot carry", () => {
  const through = (text: string, flavour: "srt" | "vtt") =>
    parseSubtitles(serializeSubtitles([{ startMs: 0, endMs: 1000, text }], flavour))
      .cues[0]?.text;

  it("carries angle brackets and ampersands through WebVTT, because it escapes them", () => {
    expect(through("<i> and &lt; and &", "vtt")).toBe("<i> and &lt; and &");
  });

  it("carries an ampersand and an unknown tag through SubRip", () => {
    // SubRip has no entity syntax, so nothing is decoded, and `<x>` is not one
    // of its formatting tags.
    expect(through("Tom & Jerry &amp; <x>", "srt")).toBe("Tom & Jerry &amp; <x>");
  });

  it("reads a literal <i> back as italics through SubRip, and says so", () => {
    // The documented loss. `<i>` has one spelling in SubRip and it means
    // italics; a file with italics is far likelier than a caption about HTML.
    expect(through("<i> is a tag", "srt")).toBe("is a tag");
  });
});
