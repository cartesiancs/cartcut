import { describe, expect, it } from "vitest";
import { cssTimeMs, shiftedDelays, shiftSmilBegin, smilClockMs, smilOffsetMs } from "./snapshotTime";

describe("shiftedDelays", () => {
  it("moves every entry of a computed list t earlier", () => {
    expect(shiftedDelays("0s", 1500)).toBe("-1500ms");
    expect(shiftedDelays("0.3s, 0s, -1.2s", 500)).toBe("-200ms, -500ms, -1700ms");
    expect(shiftedDelays("250ms", 100)).toBe("150ms");
  });

  it("keeps fractions a seek at a frame boundary makes", () => {
    expect(shiftedDelays("0s", 1000 / 3)).toBe("-333.333ms");
  });

  it("leaves a list alone rather than shift part of it", () => {
    expect(shiftedDelays("0s, var(--d)", 100)).toBeNull();
  });

  it("reads the forms computed style writes", () => {
    expect(cssTimeMs("1e-3s")).toBe(1);
    expect(cssTimeMs(".5s")).toBe(500);
    expect(cssTimeMs("auto")).toBeNull();
  });
});

describe("SMIL clock values", () => {
  it("reads timecounts and clocks", () => {
    expect(smilClockMs("2.5s")).toBe(2500);
    expect(smilClockMs("2")).toBe(2000);
    expect(smilClockMs("500ms")).toBe(500);
    expect(smilClockMs("1min")).toBe(60_000);
    expect(smilClockMs("0:01.5")).toBe(1500);
    expect(smilClockMs("01:00:02")).toBe(3_602_000);
    expect(smilClockMs("indefinite")).toBeNull();
  });

  it("reads signed offsets", () => {
    expect(smilOffsetMs("-0.5s")).toBe(-500);
    expect(smilOffsetMs(" + 2s ")).toBe(2000);
    expect(smilOffsetMs("a.end")).toBeNull();
  });
});

describe("shiftSmilBegin", () => {
  it("starts an animation with no begin t earlier", () => {
    expect(shiftSmilBegin(null, 500)).toBe("-500ms");
    expect(shiftSmilBegin("", 500)).toBe("-500ms");
  });

  it("shifts each offset in a list and leaves the rest as written", () => {
    expect(shiftSmilBegin("0s; 2s", 500)).toBe("-500ms;1500ms");
    expect(shiftSmilBegin("a.end+1s; click; indefinite", 500)).toBe("a.end+1s;click;indefinite");
  });
});
