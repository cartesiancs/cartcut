import { describe, expect, it } from "vitest";
import {
  displayDurationSec,
  formatPlayhead,
  playbackFraction,
  playheadLabel,
} from "./playback";

describe("formatPlayhead", () => {
  it("pads the seconds so the readout does not change width", () => {
    // The defect `utils/time.ts#formatRemaining` documents: an unpadded readout
    // gains and loses a character every ten seconds, and text that jitters
    // reads as broken.
    expect(formatPlayhead(0)).toBe("0:00");
    expect(formatPlayhead(6)).toBe("0:06");
    expect(formatPlayhead(9)).toBe("0:09");
    expect(formatPlayhead(10)).toBe("0:10");
    expect(formatPlayhead(0).length).toBe(formatPlayhead(59).length);
  });

  it("rolls over into minutes", () => {
    expect(formatPlayhead(59)).toBe("0:59");
    expect(formatPlayhead(60)).toBe("1:00");
    expect(formatPlayhead(125)).toBe("2:05");
    expect(formatPlayhead(3599)).toBe("59:59");
  });

  it("grows an hours bucket only when there is an hour", () => {
    expect(formatPlayhead(3600)).toBe("1:00:00");
    expect(formatPlayhead(3723)).toBe("1:02:03");
    // A ten-second clip must not carry "0:" for an hour nobody has.
    expect(formatPlayhead(10)).not.toContain("0:00:");
  });

  it("floors rather than rounds, so it never shows a time not yet reached", () => {
    // Rounding would display "0:01" at 0.5s, which is ahead of the media.
    expect(formatPlayhead(0.9)).toBe("0:00");
    expect(formatPlayhead(1.99)).toBe("0:01");
  });

  it("treats an unusable value as zero rather than printing NaN", () => {
    expect(formatPlayhead(Number.NaN)).toBe("0:00");
    expect(formatPlayhead(Number.POSITIVE_INFINITY)).toBe("0:00");
    expect(formatPlayhead(-5)).toBe("0:00");
    expect(formatPlayhead(undefined as unknown as number)).toBe("0:00");
  });
});

describe("playbackFraction", () => {
  it("is the position over the duration", () => {
    expect(playbackFraction(0, 10)).toBe(0);
    expect(playbackFraction(5, 10)).toBe(0.5);
    expect(playbackFraction(10, 10)).toBe(1);
  });

  it("clamps past the end", () => {
    expect(playbackFraction(99, 10)).toBe(1);
  });

  it("answers 0 for a duration that is not known yet", () => {
    // A media element reports NaN before metadata and Infinity for a stream.
    // Either would reach the progress bar as a width the browser drops, so the
    // bar would vanish rather than sit at zero.
    expect(playbackFraction(3, Number.NaN)).toBe(0);
    expect(playbackFraction(3, Number.POSITIVE_INFINITY)).toBe(0);
    expect(playbackFraction(3, 0)).toBe(0);
  });

  it("never returns NaN for any input", () => {
    const odd = [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 5];
    for (const a of odd) {
      for (const b of odd) {
        expect(Number.isFinite(playbackFraction(a, b))).toBe(true);
      }
    }
  });
});

describe("playheadLabel", () => {
  it("reads position over total", () => {
    expect(playheadLabel(6, 12)).toBe("0:06 / 0:12");
    expect(playheadLabel(3723, 7200)).toBe("1:02:03 / 2:00:00");
  });

  it("shows the position alone while the duration is unknown", () => {
    // Better than "0:06 / 0:00", which reads as a finished clip.
    expect(playheadLabel(6, Number.NaN)).toBe("0:06");
    expect(playheadLabel(6, 0)).toBe("0:06");
  });
});

describe("displayDurationSec", () => {
  it("prefers the media element's own duration", () => {
    // The clip's span is 5s of a 12.6s file — the trimmed-clip case, where
    // using the clip made the bar reach 100% a third of the way through.
    expect(displayDurationSec(12.667, 5000)).toBeCloseTo(12.667, 3);
  });

  it("falls back to the clip's span, converting from ms", () => {
    expect(displayDurationSec(undefined, 5000)).toBe(5);
    expect(displayDurationSec(Number.NaN, 5000)).toBe(5);
    // Infinity is what a live stream reports.
    expect(displayDurationSec(Number.POSITIVE_INFINITY, 5000)).toBe(5);
  });

  it("answers 0 when neither is usable, rather than NaN", () => {
    expect(displayDurationSec(undefined, undefined)).toBe(0);
    expect(displayDurationSec(Number.NaN, Number.NaN)).toBe(0);
    expect(displayDurationSec(0, 0)).toBe(0);
  });
});
