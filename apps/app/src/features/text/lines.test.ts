import { describe, it, expect } from "vitest";
import { splitParagraphs } from "./lines";

/**
 * The whole contract of explicit line breaking, stated as strings.
 *
 * Everything downstream — the wrap, the background band, the block height that
 * sizes a rasterised PNG — is measured against a font the host chose, so it can
 * only be asserted relatively. This is the one part that is exact, which is why
 * it lives in its own DOM-free module.
 */
describe("splitParagraphs", () => {
  it("never returns an empty list", () => {
    // Callers read `lines[lines.length - 1]` for the block's last descent.
    expect(splitParagraphs("")).toEqual([""]);
  });

  it("leaves text with no break alone", () => {
    expect(splitParagraphs("A")).toEqual(["A"]);
    expect(splitParagraphs("one two three")).toEqual(["one two three"]);
  });

  it("splits on a newline", () => {
    expect(splitParagraphs("A\nB")).toEqual(["A", "B"]);
  });

  it("reads CRLF and a lone CR as the same break", () => {
    // A textarea normalises its value to `\n`, but MCP `add_text` takes
    // `z.string()` and will pass through whatever a caller pasted.
    expect(splitParagraphs("A\r\nB")).toEqual(["A", "B"]);
    expect(splitParagraphs("A\rB")).toEqual(["A", "B"]);
  });

  it("keeps a blank paragraph between two breaks", () => {
    // The blank line is the point — it has to survive as its own entry so the
    // renderer advances past it.
    expect(splitParagraphs("A\n\nB")).toEqual(["A", "", "B"]);
    expect(splitParagraphs("A\n\n\nB")).toEqual(["A", "", "", "B"]);
  });

  it("keeps a leading and a trailing break", () => {
    expect(splitParagraphs("A\n")).toEqual(["A", ""]);
    expect(splitParagraphs("\nA")).toEqual(["", "A"]);
  });

  it("does not trim the paragraphs it hands back", () => {
    // The greedy wrap downstream is the only thing that gets to decide what a
    // run of spaces means.
    expect(splitParagraphs("  A  \n  B  ")).toEqual(["  A  ", "  B  "]);
  });

  it("treats a missing string as one empty line", () => {
    expect(splitParagraphs(undefined as unknown as string)).toEqual([""]);
  });
});
