import { describe, expect, it } from "vitest";
import {
  formatPlayhead,
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

