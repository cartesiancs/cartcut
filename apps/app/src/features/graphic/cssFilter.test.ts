import { describe, expect, it } from "vitest";
import {
  RESERVED_CUSTOM_PROPERTIES,
  filterInlineStyle,
  filterStylesheet,
  renameCustomProperties,
  urlArguments,
} from "./cssFilter";

const OPTIONS = { assetNames: new Set(["photo.png", "brand.woff2"]), file: "style.css" };

function filter(css: string) {
  return filterStylesheet(css, OPTIONS);
}

/** The surviving CSS with whitespace squeezed, so assertions read the meaning. */
function squeezed(css: string): string {
  return css.replace(/\s+/g, " ").trim();
}

describe("an allowed stylesheet", () => {
  it("comes back unchanged and reports nothing", () => {
    const css = [
      ".card { display: flex; color: #fff; background: linear-gradient(90deg, red, blue); }",
      ".label { animation: rise 400ms ease-out both; font-family: var(--font); }",
      "@keyframes rise { from { transform: translateY(24px); opacity: 0 } to { transform: none; opacity: 1 } }",
      ".q::before { content: \"\\201C\"; }",
      ".g { content: attr(data-text); filter: url(#wobble); mask-image: url(\"asset:photo.png\"); }",
      "@supports (display: grid) { .a { display: grid } }",
      "@container (min-width: 400px) { .a { font-size: 4cqw } }",
      "@media screen { .a { color: red } }",
      "@layer base { .a { color: red } }",
    ].join("\n");
    const result = filter(css);
    expect(result.removed).toEqual([]);
    expect(result.css).toBe(css);
    expect(result.propertyNames).toEqual([]);
  });
});

describe("removal", () => {
  it.each([
    ["@import url(x.css);", /@import/],
    ["@font-face { font-family: X; src: url(x.woff2) }", /@font-face/],
    ["@namespace svg url(http://www.w3.org/2000/svg);", /@namespace/],
    ["@page { margin: 0 }", /@page/],
    ["@charset \"utf-8\";", /@charset/],
    ["@-moz-document url-prefix() { a { color: red } }", /@-moz-document/],
    ["@unknown-thing { a { color: red } }", /@unknown-thing/],
  ])("drops the at-rule %s", (css, message) => {
    const result = filter(css);
    expect(squeezed(result.css)).toBe("");
    expect(result.removed[0].message).toMatch(message);
  });

  it.each([
    ["transition: opacity 1s", /wall clock/],
    ["transition-duration: 1s", /wall clock/],
    ["animation-timeline: scroll()", /scroll/],
    ["animation-play-state: running", /pauses every animation/],
    ["behavior: url(#x)", /script hook/],
    ["-moz-binding: url(#x)", /script hook/],
    ["background: url(https://evil.example/x.png)", /neither a #fragment nor a declared asset/],
    ["background: url( 'file:///etc/passwd' )", /neither/],
    ["background: url(asset:missing.png)", /neither/],
    ["background: url(data:image/png;base64,AAAA)", /neither/],
    ["background: image-set('a.png' 1x)", /image-set\(\)/],
    ["background: -webkit-image-set('a.png' 1x)", /-webkit-image-set\(\)/],
    ["background: element(#x)", /element\(\)/],
    ["background: -moz-element(#x)", /-moz-element\(\)/],
    ["width: expression(alert(1))", /expression\(\)/],
    ["rotate: random(0deg, 90deg)", /random\(\)/],
    ["background: paint(worklet)", /paint\(\)/],
    ["width: 50vw", /viewport units/],
    ["height: 1.5DVH", /viewport units/],
    ["font-size: calc(2vmin + 1px)", /viewport units/],
    ["color: CanvasText", /system colour/],
    ["border-color: highlight", /system colour/],
    ["background: u\\72l(https://evil)", /escape outside a string/],
    ["tr\\61nsition: opacity 1s", /escaped property name/],
  ])("drops the declaration %s", (decl, message) => {
    const result = filter(".a { " + decl + " }");
    expect(squeezed(result.css)).toBe(".a { }");
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].message).toMatch(message);
    expect(result.removed[0].file).toBe("style.css");
    expect(result.removed[0].line).toBe(1);
  });

  it("keeps a name that only looks like a system colour or a unit", () => {
    const result = filter(
      ".a { font-family: Mark Pro, Field Gothic; animation-name: highlight; width: 10vwx; content: \"50vw\"; }",
    );
    expect(result.removed).toEqual([]);
  });

  it("keeps an escape inside a string, which is how a typographer writes a quote mark", () => {
    expect(filter('.q::after { content: "\\201D"; }').removed).toEqual([]);
  });

  it("drops a rule with a :visited selector", () => {
    const result = filter("a:visited { color: red } .b { color: blue }");
    expect(squeezed(result.css)).toBe(".b { color: blue }");
    expect(result.removed[0].message).toMatch(/:visited/);
  });

  it("drops a @media rule that asks about the window or the machine, whole", () => {
    for (const query of [
      "(prefers-color-scheme: dark)",
      "(min-width: 600px)",
      "(orientation: landscape)",
      "(min-resolution: 2dppx)",
      "(hover: hover)",
      "(any-pointer: fine)",
    ]) {
      const result = filter("@media " + query + " { .a { color: red } } .b { color: blue }");
      expect(squeezed(result.css)).toBe(".b { color: blue }");
      expect(result.removed[0].message).toMatch(/editor's window or the machine/);
    }
  });

  it("drops an escaped @media prelude", () => {
    const result = filter("@media (pr\\65 fers-color-scheme: dark) { .a { color: red } }");
    expect(squeezed(result.css)).toBe("");
    expect(result.removed[0].message).toMatch(/escaped prelude/);
  });

  it("filters inside kept at-rules and keyframes", () => {
    const result = filter(
      "@supports (display: grid) { .a { transition: all 1s; color: red } }\n" +
        "@keyframes k { from { background: url(https://x) } to { opacity: 1 } }",
    );
    expect(squeezed(result.css)).toBe(
      "@supports (display: grid) { .a { color: red } } @keyframes k { from { } to { opacity: 1 } }",
    );
    expect(result.removed).toHaveLength(2);
    expect(result.removed[1].line).toBe(2);
  });

  it("strips !important from the animation shorthand", () => {
    const result = filter(".a { animation: k 1s !important }");
    expect(squeezed(result.css)).toBe(".a { animation: k 1s }");
    expect(result.removed[0].message).toMatch(/!important dropped/);
  });
});

describe("@property", () => {
  it("is taken out and returned for hoisting", () => {
    const css =
      '@property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }\n' +
      ".a { --angle: 10deg; background: conic-gradient(from var(--angle), red, blue); }";
    const result = filter(css);
    expect(result.propertyNames).toEqual(["--angle"]);
    expect(result.propertyRules).toContain("@property --angle");
    expect(result.css).not.toContain("@property");
    expect(result.css).toContain("var(--angle)");
    expect(result.removed).toEqual([]);
  });

  it("refuses a host-owned name", () => {
    for (const name of ["--t", "--progress", "--char-index", "--fit"]) {
      expect(RESERVED_CUSTOM_PROPERTIES).toContain(name);
      const result = filter("@property " + name + " { syntax: '<number>'; inherits: false; initial-value: 0; }");
      expect(result.propertyNames).toEqual([]);
      expect(result.propertyRules).toBe("");
      expect(result.removed[0].message).toMatch(/the host sets this one/);
    }
  });

  it("refuses a malformed name, a nested one, and one whose initial value loads", () => {
    expect(filter("@property angle { syntax: '*'; inherits: false }").removed[0].message).toMatch(
      /not a custom property name/,
    );
    expect(
      filter("@supports (color: red) { @property --x { syntax: '*'; inherits: false } }").removed[0]
        .message,
    ).toMatch(/top level/);
    expect(
      filter("@property --img { syntax: '<image>'; inherits: false; initial-value: url(https://x); }")
        .removed[0].message,
    ).toMatch(/@property --img: .*neither/);
  });

  it("keeps the first registration of a name once", () => {
    const result = filter(
      "@property --a { syntax: '<number>'; inherits: false; initial-value: 0; }\n" +
        "@property --a { syntax: '<number>'; inherits: false; initial-value: 1; }",
    );
    expect(result.propertyNames).toEqual(["--a"]);
    expect(result.propertyRules.match(/@property/g)).toHaveLength(1);
  });
});

describe("renameCustomProperties", () => {
  it("renames declarations, var() references, keyframes and the @property prelude", () => {
    const css =
      "@property --angle { syntax: '<angle>'; inherits: false; initial-value: 0deg }\n" +
      ".a { --angle: 10deg; transform: rotate(var(--angle)); }\n" +
      "@keyframes spin { to { --angle: 360deg } }";
    const renamed = renameCustomProperties(css, ["--angle"], "--g1a2b3c4d-");
    expect(renamed).toBe(
      "@property --g1a2b3c4d-angle { syntax: '<angle>'; inherits: false; initial-value: 0deg }\n" +
        ".a { --g1a2b3c4d-angle: 10deg; transform: rotate(var(--g1a2b3c4d-angle)); }\n" +
        "@keyframes spin { to { --g1a2b3c4d-angle: 360deg } }",
    );
  });

  it("leaves longer names, already prefixed names and other properties alone", () => {
    const css = ".a { --anglexyz: 1; --x--angle: 2; --g1a2b3c4d-angle: 3; --angle-b: 4; color: var(--angle) }";
    expect(renameCustomProperties(css, ["--angle"], "--g1a2b3c4d-")).toBe(
      ".a { --anglexyz: 1; --x--angle: 2; --g1a2b3c4d-angle: 3; --angle-b: 4; color: var(--g1a2b3c4d-angle) }",
    );
  });

  it("renames the longer of two overlapping names correctly", () => {
    expect(renameCustomProperties("a { --a: 1; --a-b: 2 }", ["--a", "--a-b"], "--p-")).toBe(
      "a { --p-a: 1; --p-a-b: 2 }",
    );
  });

  it("returns the input for no usable names", () => {
    expect(renameCustomProperties("a { b: c }", [], "--p-")).toBe("a { b: c }");
    expect(renameCustomProperties("a { b: c }", ["angle"], "--p-")).toBe("a { b: c }");
  });
});

describe("bad input", () => {
  it("reports a parse error with its line and never throws", () => {
    const result = filter(".a { color: red }\n.b { color: blue");
    expect(result.css).toBe("");
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].message).toMatch(/not valid CSS/);
    expect(result.removed[0].line).toBe(2);
  });

  it("refuses an unclosed url() as unreadable rather than guessing where it ends", () => {
    const result = filter(".a { background: url(#x }");
    expect(result.css).toBe("");
    expect(result.removed[0].message).toMatch(/not valid CSS/);
  });

  it("refuses more than the size cap", () => {
    const result = filter(".a { content: \"" + "x".repeat(512 * 1024) + "\" }");
    expect(result.css).toBe("");
    expect(result.removed[0].message).toMatch(/more than/);
  });
});

describe("filterInlineStyle", () => {
  it("keeps allowed declarations", () => {
    expect(filterInlineStyle("color: red; --x: 1;  opacity: .5", OPTIONS)).toEqual({
      css: "color: red; --x: 1; opacity: .5",
      removed: [],
    });
  });

  it("drops a remote url and keeps the rest", () => {
    const result = filterInlineStyle("background:url(https://evil); color: red", OPTIONS);
    expect(result.css).toBe("color: red");
    expect(result.removed).toHaveLength(1);
  });

  it("refuses anything that is not a declaration, and a brace breaking out", () => {
    expect(filterInlineStyle("@import url(x.css); color: red", OPTIONS).css).toBe("color: red");
    expect(filterInlineStyle("color: red } a { color: blue", OPTIONS).css).toBe("");
  });
});

describe("urlArguments", () => {
  it("reads quoted and bare arguments, and refuses an unclosed one", () => {
    expect(urlArguments("url(#a), url( 'asset:b.png' ), URL(\"c\")")).toEqual([
      "#a",
      "asset:b.png",
      "c",
    ]);
    expect(urlArguments("url('a)")).toBeNull();
  });
});
