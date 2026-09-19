import { describe, expect, it } from "vitest";
import { MIN_CUE_MS, normalizeCues, type SubtitleCue } from "./cues";

const cue = (over: Partial<SubtitleCue> = {}): SubtitleCue => ({
  startMs: 0,
  endMs: 1000,
  text: "hello",
  ...over,
});

describe("normalizeCues", () => {
  it("sorts by start, then by end", () => {
    const out = normalizeCues([
      cue({ startMs: 2000, endMs: 3000, text: "third" }),
      cue({ startMs: 1000, endMs: 5000, text: "second" }),
      cue({ startMs: 1000, endMs: 1500, text: "first" }),
    ]);

    expect(out.map((c) => c.text)).toEqual(["first", "second", "third"]);
  });

  it("drops a cue whose text is only whitespace", () => {
    const out = normalizeCues([cue({ text: "  \n\t " }), cue({ text: "kept" })]);

    expect(out.map((c) => c.text)).toEqual(["kept"]);
  });

  it("trims the outside of a cue and keeps the inside", () => {
    const out = normalizeCues([cue({ text: "  two\nlines  " })]);

    expect(out[0].text).toBe("two\nlines");
  });

  it("widens a zero-length cue rather than dropping it", () => {
    // The words were said. A caption nobody can see is a worse answer than one
    // that flashes.
    const out = normalizeCues([cue({ startMs: 500, endMs: 500 })]);

    expect(out[0]).toMatchObject({ startMs: 500, endMs: 500 + MIN_CUE_MS });
  });

  it("widens a cue that ends before it starts", () => {
    const out = normalizeCues([cue({ startMs: 900, endMs: 400 })]);

    expect(out[0].endMs).toBeGreaterThan(out[0].startMs);
  });

  it("clamps a negative start to zero, carrying the end with it", () => {
    const out = normalizeCues([cue({ startMs: -200, endMs: 300 })]);

    expect(out[0]).toMatchObject({ startMs: 0, endMs: 300 });
  });

  it("rounds fractional milliseconds", () => {
    const out = normalizeCues([cue({ startMs: 10.4, endMs: 1000.6 })]);

    expect(out[0]).toMatchObject({ startMs: 10, endMs: 1001 });
  });

  it("is idempotent, so both ends of the format layer can run it", () => {
    const once = normalizeCues([
      cue({ startMs: 2000, endMs: 2000, text: " b " }),
      cue({ startMs: 0, endMs: 900, text: "a" }),
    ]);

    expect(normalizeCues(once)).toEqual(once);
  });

  it("leaves the input alone", () => {
    const input = [cue({ startMs: 5, endMs: 5, text: " x " })];
    const before = JSON.stringify(input);

    normalizeCues(input);

    expect(JSON.stringify(input)).toBe(before);
  });
});
