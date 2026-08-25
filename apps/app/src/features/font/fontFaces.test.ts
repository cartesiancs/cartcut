import { describe, it, expect } from "vitest";
import { parseFontPath, DEFAULT_FONT } from "./fontFaces";

describe("parseFontPath", () => {
  it("splits a path into the three fields a text element stores", () => {
    expect(parseFontPath("/Library/Fonts/Helvetica.ttf")).toEqual({
      path: "/Library/Fonts/Helvetica.ttf",
      name: "Helvetica",
      type: "ttf",
    });
  });

  it("handles Windows separators", () => {
    expect(parseFontPath("C:\\Windows\\Fonts\\Arial.otf")).toMatchObject({
      name: "Arial",
      type: "otf",
    });
  });

  it("takes the extension from the filename, not from a dotted directory", () => {
    // The naive `path.split(".")` this replaces would report "d/Arial" here.
    expect(parseFontPath("/fonts/v1.2.3/Arial.ttf")).toMatchObject({
      name: "Arial",
      type: "ttf",
    });
  });

  it("keeps dots inside a font's own name", () => {
    expect(parseFontPath("/fonts/Noto.Sans.KR.otf")).toMatchObject({
      name: "Noto.Sans.KR",
      type: "otf",
    });
  });

  it('maps "default" to the built-in face', () => {
    expect(parseFontPath("default")).toEqual(DEFAULT_FONT);
  });

  it("falls back to the built-in face rather than producing a nameless font", () => {
    expect(parseFontPath("")).toEqual(DEFAULT_FONT);
    expect(parseFontPath(undefined as any)).toEqual(DEFAULT_FONT);
    expect(parseFontPath("/fonts/")).toEqual(DEFAULT_FONT);
  });

  it("copes with a file that has no extension", () => {
    expect(parseFontPath("/fonts/Mystery")).toMatchObject({
      name: "Mystery",
      type: "",
    });
  });
});
