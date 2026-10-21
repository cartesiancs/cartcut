import postcss from "postcss";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_FONT,
  documentFontEntries,
  ensureFontFaces,
  fontFaceRule,
  installFontUrlResolver,
  isLocalFontPath,
  loadedFontFamilies,
  localFontPath,
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

describe("registerDocumentFonts", () => {
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

describe("local faces", () => {
  it("parse to the postscript name as the family, with the path kept whole", () => {
    expect(parseFontPath("local:NotoSansKR-Bold")).toEqual({
      path: "local:NotoSansKR-Bold",
      name: "NotoSansKR-Bold",
      type: "local",
    });
    expect(localFontPath("NotoSansKR-Bold")).toBe("local:NotoSansKR-Bold");
    expect(isLocalFontPath("local:X")).toBe(true);
    expect(isLocalFontPath("/fonts/local:X.ttf")).toBe(false);
    expect(isLocalFontPath(undefined)).toBe(false);
  });

  it("with no name after the prefix are the built-in face", () => {
    expect(parseFontPath("local:")).toEqual(DEFAULT_FONT);
  });

  it("register as local(), with the name inside its string", () => {
    const rule = fontFaceRule(parseFontPath("local:Inter-Bold"));
    const root = postcss.parse(rule);
    expect(root.nodes).toHaveLength(1);
    const face = root.nodes[0] as postcss.AtRule;
    expect(face.name).toBe("font-face");
    const decls = Object.fromEntries(
      (face.nodes ?? [])
        .filter((node): node is postcss.Declaration => node.type === "decl")
        .map((decl) => [decl.prop, decl.value]),
    );
    expect(decls["font-family"]).toBe('"Inter-Bold"');
    expect(decls.src).toBe('local("Inter-Bold")');
  });

  it("and a file face do not produce the same rule", () => {
    // The harness check: a rule builder that ignored the scheme would pass the
    // test above on its own and still point every local face at file://.
    const local = fontFaceRule({ path: "local:Inter-Bold", name: "Inter-Bold", type: "local" });
    const file = fontFaceRule({ path: "/fonts/Inter-Bold.ttf", name: "Inter-Bold", type: "ttf" });
    expect(local).not.toBe(file);
    expect(file).toContain('url("file:///fonts/Inter-Bold.ttf")');
  });

  it("are decided by the path, whatever `type` says", () => {
    // `textTilePainter.faceOf` builds entries straight from element fields.
    expect(fontFaceRule({ path: "local:A-Bold", name: "A-Bold", type: "otf" })).toContain(
      'local("A-Bold")',
    );
  });

  it("cannot end their string with a quote in the name", () => {
    const rule = fontFaceRule(parseFontPath('local:Evil"} body{display:none} x{"'));
    const root = postcss.parse(rule);
    expect(root.nodes).toHaveLength(1);
  });
});

describe("ensureFontFaces", () => {
  it("writes every new face in one text node", () => {
    const rules: string[] = [];
    const added = withFakeDocument(
      () =>
        ensureFontFaces([
          parseFontPath("local:BatchA-Regular"),
          parseFontPath("local:BatchB-Regular"),
          parseFontPath("/fonts/BatchC.ttf"),
        ]),
      rules,
    );
    expect(added).toBe(3);
    expect(rules).toHaveLength(1);
    expect(postcss.parse(rules[0]).nodes).toHaveLength(3);
  });

  it("skips faces already registered, the built-in one and repeats", () => {
    const rules: string[] = [];
    withFakeDocument(() => ensureFontFaces([parseFontPath("local:BatchD-Regular")]), rules);
    const added = withFakeDocument(
      () =>
        ensureFontFaces([
          parseFontPath("local:BatchD-Regular"),
          DEFAULT_FONT,
          parseFontPath("local:BatchE-Regular"),
          parseFontPath("local:BatchE-Regular"),
        ]),
      rules,
    );
    expect(added).toBe(1);
    expect(rules).toHaveLength(2);
    expect(postcss.parse(rules[1]).nodes).toHaveLength(1);
  });

  it("writes nothing at all when nothing is new", () => {
    const rules: string[] = [];
    const added = withFakeDocument(() => ensureFontFaces([DEFAULT_FONT]), rules);
    expect(added).toBe(0);
    expect(rules).toHaveLength(0);
  });
});

describe("documentFontEntries", () => {
  it("lists a clip's face and its runs', once each, without the built-in face", () => {
    const entries = documentFontEntries({
      a: {
        filetype: "text",
        fontpath: "local:DocA-Bold",
        runs: [
          { from: 0, to: 1, style: { fontpath: "local:DocB-Regular" } },
          { from: 1, to: 2, style: { fontpath: "local:DocA-Bold" } },
        ],
      },
      b: { filetype: "text", fontpath: "default" },
      c: { filetype: "text", fontpath: "/fonts/DocC.ttf" },
      d: { filetype: "image", fontpath: "local:NotText-Regular" },
    });
    expect(entries.map((entry) => entry.name)).toEqual([
      "DocA-Bold",
      "DocB-Regular",
      "DocC",
    ]);
  });

  it("registers a local face on load, for the clip and for a run", () => {
    const rules: string[] = [];
    const added = withFakeDocument(
      () =>
        registerDocumentFonts({
          a: {
            filetype: "text",
            fontpath: "local:LoadA-Bold",
            runs: [{ from: 0, to: 1, style: { fontpath: "local:LoadB-Italic" } }],
          },
        }),
      rules,
    );
    expect(added).toBe(2);
    expect(loadedFontFamilies()).toEqual(
      expect.arrayContaining(["LoadA-Bold", "LoadB-Italic"]),
    );
    expect(rules.join("\n")).toContain('local("LoadB-Italic")');
  });
});

describe("installFontUrlResolver", () => {
  it("points a face at whatever URL the build serves its files from", () => {
    const entry = { path: "/examples/templates/t/fonts/A-Bold.ttf", name: "A-Bold", type: "ttf" };
    expect(fontFaceRule(entry)).toContain('url("file:///examples/templates/t/fonts/A-Bold.ttf")');
    installFontUrlResolver((path) => `/api/file?path=${path}`);
    try {
      expect(fontFaceRule(entry)).toContain(
        'url("/api/file?path=/examples/templates/t/fonts/A-Bold.ttf")',
      );
      // a local face never goes through it
      expect(fontFaceRule(parseFontPath("local:A-Bold"))).toContain('local("A-Bold")');
    } finally {
      installFontUrlResolver((path) => "file://" + path);
    }
  });
});
