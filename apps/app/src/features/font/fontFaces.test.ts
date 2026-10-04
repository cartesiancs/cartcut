import postcss from "postcss";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_FONT,
  loadedFontFamilies,
  parseFontPath,
  registerDocumentFonts,
} from "./fontFaces";

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

describe("registerDocumentFonts", () => {
  /**
   * The narrowest `document` `ensureFontFace` touches.
   *
   * It bails out entirely without one, so in the node environment the real
   * function is a no-op and the thing under test here would report nothing
   * whatever it did. Four members is the whole surface, which is small enough
   * to fake honestly rather than to mock.
   */
  function withFakeDocument<T>(run: () => T, rules: string[] = []): T {
    const style = {
      id: "",
      appendChild: (node: { text: string }) => rules.push(node.text),
    };
    const fake = {
      querySelector: () => style,
      createElement: () => style,
      createTextNode: (text: string) => ({ text }),
      head: { appendChild: () => undefined },
    };
    const had = "document" in globalThis;
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = fake;
    try {
      return run();
    } finally {
      if (had) {
        (globalThis as { document?: unknown }).document = previous;
      } else {
        delete (globalThis as { document?: unknown }).document;
      }
    }
  }

  it("registers a face only a run names", () => {
    // Without this the styled stretch alone draws in the fallback the next time
    // the project is opened, which is the silent failure this function exists
    // to end - here one level further down.
    const added = withFakeDocument(() =>
      registerDocumentFonts({
        a: {
          filetype: "text",
          fontpath: "/fonts/RunTestOwn.ttf",
          runs: [
            { from: 0, to: 2, style: { fontpath: "/fonts/RunTestInner.otf" } },
          ],
        },
      }),
    );

    expect(added).toBe(2);
    expect(loadedFontFamilies()).toContain("RunTestOwn");
    expect(loadedFontFamilies()).toContain("RunTestInner");
  });

  it("is unbothered by a hand-edited runs field", () => {
    expect(() =>
      withFakeDocument(() =>
        registerDocumentFonts({
          a: { filetype: "text", fontpath: "/fonts/RunJunkA.ttf", runs: "nope" },
          b: {
            filetype: "text",
            fontpath: "/fonts/RunJunkB.ttf",
            runs: [null, 7, {}, { style: { fontpath: 4 } }],
          },
        }),
      ),
    ).not.toThrow();
  });

  it("cannot be made to write outside its own rule", () => {
    // A font parameter can arrive from an agent or a downloaded preset. A quote
    // in the name or the path must stay inside its CSS string, or whatever
    // followed it would land in the editor's global stylesheet.
    const rules: string[] = [];
    withFakeDocument(
      () =>
        registerDocumentFonts({
          a: { filetype: "text", fontpath: '/fonts/Evil"} body{display:none} x{".ttf' },
        }),
      rules,
    );
    expect(rules).toHaveLength(1);
    // Parsed the way a browser would: one @font-face and nothing after it,
    // with the braces and the selector still inside the family string.
    const root = postcss.parse(rules[0]);
    expect(root.nodes).toHaveLength(1);
    const face = root.nodes[0] as postcss.AtRule;
    expect(face.name).toBe("font-face");
    const family = face.nodes?.find(
      (node) => node.type === "decl" && node.prop === "font-family",
    ) as postcss.Declaration;
    expect(family.value.startsWith('"Evil\\"} body{display:none} x{\\""')).toBe(true);
  });

  it("still registers a clip that carries no runs at all", () => {
    const added = withFakeDocument(() =>
      registerDocumentFonts({
        a: { filetype: "text", fontpath: "/fonts/RunTestPlain.ttf" },
        b: { filetype: "image", fontpath: "/fonts/NotAFont.ttf" },
      }),
    );
    expect(added).toBe(1);
  });
});
