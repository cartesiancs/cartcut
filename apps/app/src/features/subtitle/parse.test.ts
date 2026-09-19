import { describe, expect, it } from "vitest";
import { parseSubtitles, sniffFlavour } from "./parse";

/** A well-formed SubRip file, as a tool would write one. */
const SRT = [
  "1",
  "00:00:01,000 --> 00:00:02,500",
  "First line.",
  "",
  "2",
  "00:00:03,000 --> 00:00:04,000",
  "Second line,",
  "over two rows.",
  "",
].join("\n");

/** A well-formed WebVTT file, with everything a real one carries. */
const VTT = [
  "WEBVTT - Some title",
  "Kind: captions",
  "Language: en",
  "",
  "NOTE this comment is not a cue",
  "",
  "STYLE",
  "::cue { color: yellow }",
  "",
  "intro",
  "00:00:01.000 --> 00:00:02.500 align:start line:90%",
  "First line.",
  "",
  "00:00:03.000 --> 00:00:04.000",
  "Second line.",
  "",
].join("\n");

describe("sniffFlavour", () => {
  it("trusts a WEBVTT signature over anything else", () => {
    expect(sniffFlavour(VTT, "whatever.srt")).toBe("vtt");
  });

  it("sees the signature through a BOM", () => {
    expect(sniffFlavour(`﻿${VTT}`)).toBe("vtt");
  });

  it("falls back to the filename when the content says nothing", () => {
    expect(sniffFlavour(SRT, "captions.vtt")).toBe("vtt");
    expect(sniffFlavour(SRT, "captions.srt")).toBe("srt");
    expect(sniffFlavour(SRT)).toBe("srt");
  });
});

describe("parseSubtitles on a well-formed file", () => {
  it("reads a SubRip file", () => {
    const out = parseSubtitles(SRT, "a.srt");

    expect(out.flavour).toBe("srt");
    expect(out.skipped).toBe(0);
    expect(out.cues).toEqual([
      { startMs: 1000, endMs: 2500, text: "First line." },
      { startMs: 3000, endMs: 4000, text: "Second line,\nover two rows." },
    ]);
  });

  it("reads a WebVTT file, dropping its header, comment and style blocks", () => {
    const out = parseSubtitles(VTT, "a.vtt");

    expect(out.flavour).toBe("vtt");
    // The four non-cue blocks are skipped, not counted as unreadable.
    expect(out.skipped).toBe(0);
    expect(out.cues).toEqual([
      { startMs: 1000, endMs: 2500, text: "First line." },
      { startMs: 3000, endMs: 4000, text: "Second line." },
    ]);
  });

  it("drops WebVTT cue settings from the timing line", () => {
    // The first cue above carries `align:start line:90%`. Reading the end time
    // as the whole remainder of the line would have failed it outright.
    expect(parseSubtitles(VTT).cues[0].endMs).toBe(2500);
  });

  it("drops a WebVTT cue identifier and a SubRip index alike", () => {
    // `intro` above, and `1`/`2` in the SRT. Neither reaches the text.
    expect(parseSubtitles(VTT).cues[0].text).toBe("First line.");
    expect(parseSubtitles(SRT).cues[0].text).toBe("First line.");
  });
});

describe("parseSubtitles on the files that actually turn up", () => {
  it("strips a BOM rather than putting it in the first cue", () => {
    expect(parseSubtitles(`﻿${SRT}`).cues[0].text).toBe("First line.");
  });

  it("reads CRLF", () => {
    expect(parseSubtitles(SRT.replace(/\n/g, "\r\n")).cues).toHaveLength(2);
  });

  it("reads a lone CR", () => {
    expect(parseSubtitles(SRT.replace(/\n/g, "\r")).cues).toHaveLength(2);
  });

  it("reads a file with no trailing blank line", () => {
    expect(parseSubtitles(SRT.trimEnd()).cues).toHaveLength(2);
  });

  it("survives a separator line holding spaces", () => {
    const padded = SRT.replace(/\n\n/g, "\n   \n");
    expect(parseSubtitles(padded).cues).toHaveLength(2);
  });

  it("ignores non-sequential indices, since it discards them", () => {
    const out = parseSubtitles(SRT.replace(/^2$/m, "47"));
    expect(out.cues).toHaveLength(2);
    expect(out.skipped).toBe(0);
  });

  it("sorts cues the file listed out of order", () => {
    const out = parseSubtitles(
      [
        "1",
        "00:00:09,000 --> 00:00:10,000",
        "later",
        "",
        "2",
        "00:00:01,000 --> 00:00:02,000",
        "earlier",
        "",
      ].join("\n"),
    );

    expect(out.cues.map((c) => c.text)).toEqual(["earlier", "later"]);
  });

  it("counts a block with no timing as skipped and keeps going", () => {
    const out = parseSubtitles(
      ["garbage with no arrow", "", "1", "00:00:01,000 --> 00:00:02,000", "kept", ""].join(
        "\n",
      ),
    );

    expect(out.skipped).toBe(1);
    expect(out.cues.map((c) => c.text)).toEqual(["kept"]);
  });

  it("counts a block whose timing will not parse as skipped", () => {
    const out = parseSubtitles(
      ["1", "nonsense --> rubbish", "text", "", "2", "00:00:01,000 --> 00:00:02,000", "kept", ""].join(
        "\n",
      ),
    );

    expect(out.skipped).toBe(1);
    expect(out.cues.map((c) => c.text)).toEqual(["kept"]);
  });

  it("drops a cue with valid timing and no words without calling it skipped", () => {
    const out = parseSubtitles(
      ["1", "00:00:01,000 --> 00:00:02,000", "", "2", "00:00:03,000 --> 00:00:04,000", "kept", ""].join(
        "\n",
      ),
    );

    expect(out.cues.map((c) => c.text)).toEqual(["kept"]);
    expect(out.skipped).toBe(0);
  });

  it("splits cues in a file whose blank-line separators went missing", () => {
    // Without the fallback in `cueChunks` the whole file reads as one cue whose
    // text is every remaining line.
    const out = parseSubtitles(
      [
        "1",
        "00:00:01,000 --> 00:00:02,000",
        "First line.",
        "2",
        "00:00:03,000 --> 00:00:04,000",
        "Second line.",
      ].join("\n"),
    );

    expect(out.cues).toEqual([
      { startMs: 1000, endMs: 2000, text: "First line." },
      { startMs: 3000, endMs: 4000, text: "Second line." },
    ]);
  });

  it("reads a timestamp with no leading zero on the hour", () => {
    const out = parseSubtitles(["1", "0:00:01,000 --> 0:00:02,000", "x", ""].join("\n"));
    expect(out.cues[0]).toEqual({ startMs: 1000, endMs: 2000, text: "x" });
  });

  it("reads a timing line with no spaces around the arrow", () => {
    const out = parseSubtitles(["1", "00:00:01,000-->00:00:02,000", "x", ""].join("\n"));
    expect(out.cues[0]).toEqual({ startMs: 1000, endMs: 2000, text: "x" });
  });
});

/** One cue's text, read back out of a file of the given flavour. */
const textOf = (line: string, flavour: "srt" | "vtt") =>
  parseSubtitles(
    flavour === "vtt"
      ? ["WEBVTT", "", "00:00:01.000 --> 00:00:02.000", line, ""].join("\n")
      : ["1", "00:00:01,000 --> 00:00:02,000", line, ""].join("\n"),
  ).cues[0].text;

describe("parseSubtitles reads WebVTT cue text as the markup it is", () => {
  it("removes inline tags", () => {
    expect(textOf("<i>slanted</i> and <b>bold</b>", "vtt")).toBe("slanted and bold");
  });

  it("removes a class tag, a voice span and a karaoke timestamp", () => {
    expect(textOf("<c.yellow>a</c><v Bob>b</v><00:00:01.500>c", "vtt")).toBe("abc");
  });

  it("decodes the entities a WebVTT writer emits", () => {
    expect(textOf("Tom &amp; Jerry", "vtt")).toBe("Tom & Jerry");
  });

  it("keeps an escaped tag as literal text", () => {
    // Decoding entities before stripping tags turns `&lt;i&gt;` into `<i>` and
    // then deletes it, losing a literal the file escaped on purpose.
    expect(textOf("&lt;i&gt; is a tag", "vtt")).toBe("<i> is a tag");
  });

  it("does not decode an escaped ampersand twice", () => {
    // `&amp;lt;` must come out as the four characters `&lt;`, not as `<`.
    expect(textOf("&amp;lt;", "vtt")).toBe("&lt;");
  });
});

describe("parseSubtitles reads SubRip cue text as mostly not markup", () => {
  it("removes the formatting tags SubRip inherited from its players", () => {
    expect(textOf("<i>slanted</i> and <b>bold</b>", "srt")).toBe("slanted and bold");
    expect(textOf('<font color="#ff0000">red</font>', "srt")).toBe("red");
  });

  it("leaves a tag SubRip never defined alone", () => {
    // WebVTT's `<[^>]*>` would eat this. SubRip has no tag syntax to appeal to,
    // so anything off the list is a `<` the user typed.
    expect(textOf("a <x> b <00:00:01.500> c", "srt")).toBe("a <x> b <00:00:01.500> c");
  });

  it("decodes no entities at all", () => {
    // SubRip has no entity syntax, so these are characters somebody typed.
    expect(textOf("Tom &amp; Jerry &lt;", "srt")).toBe("Tom &amp; Jerry &lt;");
  });
});

describe("parseSubtitles on nothing", () => {
  it("answers with no cues and nothing skipped for an empty file", () => {
    expect(parseSubtitles("")).toEqual({ flavour: "srt", cues: [], skipped: 0 });
  });

  it("answers with no cues for a WebVTT header on its own", () => {
    expect(parseSubtitles("WEBVTT\n")).toEqual({
      flavour: "vtt",
      cues: [],
      skipped: 0,
    });
  });
});
