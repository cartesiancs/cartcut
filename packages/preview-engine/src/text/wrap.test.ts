import { describe, it, expect } from "vitest";
import { wrapTextLines } from "./wrap";

// Fake metrics: each character is 10px wide. Deterministic, no canvas needed.
const measure = (s: string) => s.length * 10;

describe("wrapTextLines", () => {
  it("keeps everything on one line when it fits", () => {
    // "hi " = 3 chars = 30px < 1000
    expect(wrapTextLines(measure, "hi there", 1000)).toEqual(["hi there "]);
  });

  it("breaks when the accumulated line would exceed maxWidth", () => {
    // maxWidth 60px => "aa " (30) fits, "aa bb " (60) not < 60 -> break
    const lines = wrapTextLines(measure, "aa bb cc", 60);
    expect(lines).toEqual(["aa ", "bb ", "cc "]);
  });

  it("always emits a trailing line", () => {
    const lines = wrapTextLines(measure, "word", 1000);
    expect(lines).toEqual(["word "]);
  });

  it("handles single very long word by keeping it on its own line", () => {
    const lines = wrapTextLines(measure, "aaaaaaaaaa bb", 50);
    // first word alone exceeds width; greedy algorithm still places it, then bb
    expect(lines[lines.length - 1]).toBe("bb ");
  });
});
