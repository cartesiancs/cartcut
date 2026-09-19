import { describe, expect, it } from "vitest";
import { formatTimecode, parseTimecode } from "./timecode";

describe("parseTimecode", () => {
  it("reads the two shapes the formats actually write", () => {
    expect(parseTimecode("00:00:01,500")).toBe(1500);
    expect(parseTimecode("00:00:01.500")).toBe(1500);
  });

  it("adds up hours, minutes, seconds and milliseconds", () => {
    expect(parseTimecode("01:02:03,004")).toBe(
      3_600_000 + 2 * 60_000 + 3000 + 4,
    );
  });

  it("accepts WebVTT's omitted hour field", () => {
    expect(parseTimecode("01:02.500")).toBe(62_500);
  });

  it("accepts an hour field past 99", () => {
    expect(parseTimecode("100:00:00,000")).toBe(100 * 3_600_000);
  });

  it("accepts hand-edited single digits and surrounding space", () => {
    expect(parseTimecode("  0:1:2,000  ")).toBe(62_000);
  });

  it("accepts a timestamp with no fraction at all", () => {
    expect(parseTimecode("00:00:02")).toBe(2000);
  });

  // The defect this suite exists for. A parser reading the fraction as an
  // integer makes `,05` five milliseconds instead of fifty: wrong by a factor
  // of ten, and entirely plausible in a diff.
  it("reads the fraction as a position, not as a number", () => {
    expect(parseTimecode("00:00:01,5")).toBe(1500);
    expect(parseTimecode("00:00:01,50")).toBe(1500);
    expect(parseTimecode("00:00:01,500")).toBe(1500);
    expect(parseTimecode("00:00:01,05")).toBe(1050);
    expect(parseTimecode("00:00:01,005")).toBe(1005);
  });

  it("truncates a fraction finer than milliseconds", () => {
    expect(parseTimecode("00:00:01,5009")).toBe(1500);
  });

  // Proves the three cases above are measuring something: a parser that read
  // every fraction as zero, or as its integer value, would fail here.
  it("tells a tenth from a hundredth", () => {
    expect(parseTimecode("00:00:01,500")).not.toBe(parseTimecode("00:00:01,050"));
    expect(parseTimecode("00:00:01,050")).not.toBe(parseTimecode("00:00:01,005"));
  });

  it("refuses what is not a timestamp", () => {
    expect(parseTimecode("")).toBeNull();
    expect(parseTimecode("1")).toBeNull();
    expect(parseTimecode("Hello there")).toBeNull();
    expect(parseTimecode("align:start")).toBeNull();
    expect(parseTimecode("00:00:01,500 --> 00:00:02,000")).toBeNull();
  });

  it("is anchored, so a timestamp inside other text is not a timestamp", () => {
    // Unanchored, this would read the time out of a cue-settings line and call
    // it a cue.
    expect(parseTimecode("line:90% 00:00:01,000")).toBeNull();
  });
});

describe("formatTimecode", () => {
  it("writes a comma for SubRip and a dot for WebVTT", () => {
    expect(formatTimecode(1500, "srt")).toBe("00:00:01,500");
    expect(formatTimecode(1500, "vtt")).toBe("00:00:01.500");
  });

  it("keeps the hour field in WebVTT even though dropping it is legal", () => {
    expect(formatTimecode(0, "vtt")).toBe("00:00:00.000");
  });

  it("pads every field", () => {
    expect(formatTimecode(3_600_000 + 2 * 60_000 + 3000 + 4, "srt")).toBe(
      "01:02:03,004",
    );
  });

  it("widens past 99 hours rather than wrapping", () => {
    expect(formatTimecode(100 * 3_600_000, "srt")).toBe("100:00:00,000");
  });

  it("clamps a negative time instead of throwing, so one bad cue cannot fail an export", () => {
    expect(formatTimecode(-1, "srt")).toBe("00:00:00,000");
  });

  it("rounds a fractional millisecond", () => {
    expect(formatTimecode(1500.6, "srt")).toBe("00:00:01,501");
  });
});

describe("the two directions agree", () => {
  const TABLE = [
    "00:00:00,000",
    "00:00:01,500",
    "00:00:59,999",
    "00:01:00,000",
    "01:02:03,004",
    "23:59:59,999",
    "100:00:00,000",
  ];

  it("round trips every SubRip shape it writes", () => {
    for (const text of TABLE) {
      const ms = parseTimecode(text);
      expect(ms).not.toBeNull();
      expect(formatTimecode(ms as number, "srt")).toBe(text);
    }
  });

  it("round trips every WebVTT shape it writes", () => {
    for (const text of TABLE) {
      const vtt = text.replace(",", ".");
      const ms = parseTimecode(vtt);
      expect(ms).not.toBeNull();
      expect(formatTimecode(ms as number, "vtt")).toBe(vtt);
    }
  });
});
