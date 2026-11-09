import { describe, expect, it } from "vitest";
import { selectAll } from "css-select";
import { parseDocument } from "htmlparser2";
import type { Element } from "domhandler";
import {
  cssUrls,
  HOST_TAG,
  negateShadowsInStyle,
  negateShadowsInStylesheet,
  negateShadowY,
  rewriteCssUrls,
  scopeSelector,
  scopeStylesheet,
  splitTopLevel,
} from "./snapshotCss";

// A graphic's tree, every element named by its `id` so match sets compare.
const FRAGMENT =
  '<div id="root" class="graphic-root">' +
  '<h1 id="h" class="title" data-split="chars"><span id="w" class="word"><span id="c1" class="char">H</span><span id="c2" class="char">i</span></span></h1>' +
  '<p id="p" class="sub">sub <em id="em">line</em></p>' +
  '<svg id="s" viewBox="0 0 10 10"><defs id="d"><linearGradient id="lg"></linearGradient></defs><rect id="r"></rect></svg>' +
  "</div>";

/** What the live shadow root's sheet sees: the fragment and nothing above it. */
const live = parseDocument(FRAGMENT, { xmlMode: false });
/** What the snapshot's sheet sees: the scaffold, in an XML document, around it. */
const snapshot = parseDocument(
  `<svg id="scaffold-svg"><foreignObject id="scaffold-fo"><${HOST_TAG} id="scaffold-host">` +
    FRAGMENT +
    `</${HOST_TAG}></foreignObject></svg>`,
  { xmlMode: true },
);

const ids = (selector: string, doc: ReturnType<typeof parseDocument>, xmlMode: boolean) =>
  (selectAll(selector, doc, { xmlMode }) as unknown as Element[]).map((el) => el.attribs.id).sort();

describe("scopeSelector against an independent matcher", () => {
  const selectors = [
    "*",
    "div",
    ".title",
    "h1 .char",
    ".word > .char",
    "span:nth-child(2)",
    ":not(.char)",
    "p em, .sub",
    "svg rect",
    "linearGradient",
    "[data-split]",
    ".graphic-root > *",
    ".char + .char",
    "h1 ~ p",
  ];
  for (const selector of selectors) {
    it(`matches what ${JSON.stringify(selector)} matched in the shadow root`, () => {
      const scoped = scopeSelector(selector);
      expect(scoped).not.toBeNull();
      const want = ids(selector, live, false);
      const got = ids(scoped!, snapshot, true);
      expect(got).toEqual(want);
      expect(got.some((id) => id.startsWith("scaffold"))).toBe(false);
    });
  }

  it("proves the harness: an unscoped * reaches the scaffold", () => {
    expect(ids("*", snapshot, true)).toContain("scaffold-svg");
  });

  it("lowercases an HTML type selector, which XML matches case-sensitively", () => {
    expect(ids("H1", snapshot, true)).toEqual([]);
    expect(ids(scopeSelector("H1")!, snapshot, true)).toEqual(["h"]);
    // SVG names keep their case.
    expect(scopeSelector("linearGradient")).toBe(`${HOST_TAG} linearGradient`);
  });
});

describe("scopeSelector by hand", () => {
  it("turns :host into the host element", () => {
    expect(scopeSelector(":host")).toBe(HOST_TAG);
    expect(scopeSelector(":host .x")).toBe(`${HOST_TAG} .x`);
    expect(scopeSelector(":host::before")).toBe(`${HOST_TAG}::before`);
    expect(scopeSelector(":host(.dark) .x")).toBe(`${HOST_TAG}:is(.dark) .x`);
  });

  it("drops what a shadow root's own sheet can never match", () => {
    expect(scopeSelector(":root")).toBeNull();
    expect(scopeSelector(":root .x, .y")).toBe(`${HOST_TAG} .y`);
    expect(scopeSelector("::slotted(p)")).toBeNull();
    expect(scopeSelector(".a :host")).toBeNull();
  });
});

describe("scopeStylesheet", () => {
  it("scopes rules inside grouping at-rules and leaves keyframes and descriptors alone", () => {
    const css =
      "@keyframes k { from { opacity: 0 } 50% { opacity: .5 } }" +
      "@media (min-aspect-ratio: 1) { .a { color: red } }" +
      "@supports (display: grid) { @layer base { b { color: blue } } }" +
      "@counter-style drum { system: cyclic; symbols: A B; }" +
      ".x { color: green; .y { color: red } }";
    const out = scopeStylesheet(css);
    expect(out).toContain("@keyframes k { from { opacity: 0 } 50% { opacity: .5 } }");
    expect(out).toContain(`@media (min-aspect-ratio: 1) { ${HOST_TAG} .a { color: red } }`);
    expect(out).toContain(`@layer base { ${HOST_TAG} b { color: blue } }`);
    expect(out).toContain("@counter-style drum { system: cyclic; symbols: A B; }");
    // The nested rule is relative to its already scoped parent.
    expect(out).toContain(`${HOST_TAG} .x { color: green; .y { color: red } }`);
  });

  it("scopes an @scope root and not its rules", () => {
    expect(scopeStylesheet("@scope (.card) to (.body) { p { color: red } }")).toBe(
      `@scope (${HOST_TAG} .card) to (.body) { p { color: red } }`,
    );
  });

  it("removes a rule none of whose selectors can match", () => {
    expect(scopeStylesheet(":root { --x: 1 } .a { color: red }")).toBe(`${HOST_TAG} .a { color: red }`);
  });
});

describe("negateShadowY", () => {
  const cases: Array<[string, string]> = [
    ["2px 4px 6px red", "2px -4px 6px red"],
    ["red 2px 4px", "red 2px -4px"],
    ["inset 0 -3px 0 #000", "inset 0 3px 0 #000"],
    ["0 var(--y) 8px var(--c)", "0 calc(-1 * var(--y)) 8px var(--c)"],
    ["0 0 12px var(--glow)", "0 0 12px var(--glow)"],
    ["1px 2px red, 0 calc(2px + 1px) blue", "1px -2px red, 0 calc(-1 * calc(2px + 1px)) blue"],
    ["0 2px color-mix(in srgb, red 50%, blue)", "0 -2px color-mix(in srgb, red 50%, blue)"],
    ["rgba(0, 0, 0, .5) 0 .5em 1em", "rgba(0, 0, 0, .5) 0 -.5em 1em"],
    ["+3px +4px", "+3px -4px"],
    ["none", "none"],
  ];
  for (const [input, output] of cases) {
    it(`${input} -> ${output}`, () => {
      expect(negateShadowY(input)).toBe(output);
    });
  }

  it("reaches keyframes, and leaves drop-shadow alone (WebKit draws that one right)", () => {
    const css =
      "@keyframes glow { to { text-shadow: 0 4px 8px red } }" +
      ".a { box-shadow: 0 2px 0 blue; filter: drop-shadow(0 2px 0 red) }";
    const out = negateShadowsInStylesheet(css);
    expect(out).toContain("text-shadow: 0 -4px 8px red");
    expect(out).toContain("box-shadow: 0 -2px 0 blue");
    expect(out).toContain("drop-shadow(0 2px 0 red)");
  });

  it("rewrites a style attribute", () => {
    expect(negateShadowsInStyle("color: red; text-shadow: 1px 2px 3px #000")).toBe(
      "color: red;text-shadow: 1px -2px 3px #000",
    );
    expect(negateShadowsInStyle("--x: 1")).toBe("--x: 1");
  });
});

describe("splitTopLevel", () => {
  it("keeps brackets and strings whole", () => {
    expect(splitTopLevel('a(b, c), "d, e", f', ",")).toEqual(["a(b, c)", '"d, e"', "f"]);
    expect(splitTopLevel("0  calc(1px + 2px)\t red", " ")).toEqual(["0", "calc(1px + 2px)", "red"]);
  });
});

describe("cssUrls and rewriteCssUrls", () => {
  const css = `.a { background: url("/sample/a.png") } .b { mask: url('/m.svg') } .c { filter: url(#f) } .d { background: url(data:image/png;base64,AA) } .e { background: url(/x.png) }`;

  it("lists what must be fetched, not fragments or data", () => {
    expect(cssUrls(css)).toEqual(["/sample/a.png", "/m.svg", "/x.png"]);
  });

  it("swaps the ones it has answers for", () => {
    const out = rewriteCssUrls(css, (raw) => (raw === "/m.svg" ? "data:image/svg+xml,M" : null));
    expect(out).toContain(`url("data:image/svg+xml,M")`);
    expect(out).toContain(`url("/sample/a.png")`);
    expect(out).toContain("url(#f)");
  });
});
