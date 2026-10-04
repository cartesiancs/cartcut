import { describe, expect, it } from "vitest";
import {
  MAX_DEPTH,
  sanitizeHtml,
  serializeSafeNodes,
  type SafeNode,
} from "./sanitizeHtml";

const OPTIONS = { assetNames: new Set(["photo.png"]), file: "index.html" };

function clean(html: string) {
  return sanitizeHtml(html, OPTIONS);
}

function markup(html: string): string {
  return serializeSafeNodes(clean(html).nodes);
}

/** Every element in a tree, depth first. */
function elements(nodes: SafeNode[]): Extract<SafeNode, { kind: "element" }>[] {
  const out: Extract<SafeNode, { kind: "element" }>[] = [];
  for (const node of nodes) {
    if (node.kind === "element") {
      out.push(node, ...elements(node.children));
    }
  }
  return out;
}

const FORBIDDEN_TAGS = new Set(["script", "style", "iframe", "foreignobject", "template", "noscript", "math"]);

/**
 * What every XSS case must come out as: no element that runs or loads, no event
 * handler, and no attribute a URL parser would read as a script.
 */
function expectInert(html: string): void {
  const { nodes } = clean(html);
  for (const element of elements(nodes)) {
    expect(FORBIDDEN_TAGS.has(element.tag.toLowerCase())).toBe(false);
    expect(element.tag.includes("-")).toBe(false);
    for (const [name, value] of element.attrs) {
      expect(name.toLowerCase().startsWith("on")).toBe(false);
      const squeezed = value.replace(/[\u0000- ]/g, "").toLowerCase();
      expect(squeezed.startsWith("javascript:")).toBe(false);
      expect(squeezed.startsWith("data:")).toBe(false);
    }
  }
  const text = serializeSafeNodes(nodes);
  expect(text).not.toMatch(/<(script|style|iframe|foreignObject)\b/i);
  expect(text).not.toMatch(/\son[a-z]+="/i);
}

describe("an XSS corpus", () => {
  it.each([
    "<img src=x onerror=alert(1)>",
    "<svg onload=alert(1)><rect width=10 height=10 /></svg>",
    '<a href="javascript:alert(1)">click</a>',
    '<svg><animate attributeName="href" to="javascript:alert(1)"/></svg>',
    '<svg><set attributeName="onmouseover" to="alert(1)"/></svg>',
    '<svg><animate attributeName="xlink:href" values="javascript:alert(1)"/></svg>',
    "<math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>",
    "<!--<img src=x onerror=alert(1)>-->",
    "<![CDATA[<script>alert(1)</script>]]>",
    "<ScRiPt>alert(1)</sCrIpT>",
    '<img src="jav&#x09;ascript:alert(1)">',
    '<img src="  JAVASCRIPT:alert(1)">',
    "<template><img src=x onerror=alert(1)></template>",
    '<noscript><p title="</noscript><img src onerror=alert(1)>"></noscript>',
    "<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>",
    "<svg><style>@import url(https://evil);</style></svg>",
    "<svg><script>alert(1)</script></svg>",
    "<option-text></option-text>",
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<object data="x.swf"></object><embed src="x.swf">',
    '<form action="https://evil"><input autofocus onfocus=alert(1)></form>',
    '<div style="background:url(https://evil)">x</div>',
    '<svg><use href="https://evil/#x"/></svg>',
    '<svg><use xlink:href="data:image/svg+xml,<svg onload=alert(1)>"/></svg>',
    '<div tabindex="1" contenteditable popover onclick="alert(1)">x</div>',
    '<svg><rect fill="url(https://evil#x)" width="1" height="1"/></svg>',
    '<svg><feImage href="https://evil.png"/></svg>',
    '<base href="https://evil/"><link rel=stylesheet href=x.css><meta http-equiv=refresh content="0;url=x">',
    '<video src=x onerror=alert(1)></video><audio src=x></audio><canvas></canvas>',
  ])("leaves %s inert", (html) => {
    expectInert(html);
  });

  it("keeps the harmless remainder rather than dropping everything", () => {
    // The mXSS shape: on this first parse the `<style>` swallows `</math>` and
    // the image as raw text, so all of it is inside the MathML subtree, which
    // goes whole. Nothing is serialised to be parsed a second time, which is
    // the parse on which the attack would have surfaced.
    expect(markup("<math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>")).toBe(
      "",
    );
    // `noscript` reads as raw text with scripting on, so the title's quote does
    // not protect the image behind it; the image is real, and inert.
    expect(markup('<noscript><p title="</noscript><img src onerror=alert(1)>"></noscript>')).toBe(
      '<img>"&gt;',
    );
    expect(markup('<div style="background:url(https://evil)">x</div>')).toBe("<div>x</div>");
    expect(markup("<svg><![CDATA[<script>]]></svg>")).toBe("<svg>&lt;script&gt;</svg>");
  });

  it("reports what it removed", () => {
    const { removed } = clean("<img src=x onerror=alert(1)>");
    expect(removed.map((d) => d.message)).toEqual([
      "<img> src: an image must be a declared asset:<name>",
      "<img> onerror: event handlers never run in a graphic",
    ]);
    expect(removed[0].file).toBe("index.html");
    expect(removed[0].line).toBe(1);
  });
});

describe("custom elements", () => {
  it("drops a hyphenated element whole, rather than unwrapping it", () => {
    expect(markup("<x-y>hi</x-y><p>kept</p>")).toBe("<p>kept</p>");
    expect(clean("<option-text></option-text>").removed[0].message).toMatch(/custom element/);
  });

  it("unwraps an unknown element and keeps its text", () => {
    expect(markup('<a href="https://x">Title</a>')).toBe("Title");
    expect(markup("<marquee>news</marquee>")).toBe("news");
  });
});

describe("what a graphic needs survives", () => {
  it("keeps data-param and data-split", () => {
    expect(markup('<h1 data-param="title" data-split="words chars">Hello</h1>')).toBe(
      '<h1 data-param="title" data-split="words chars">Hello</h1>',
    );
  });

  it("keeps a filter's colour space", () => {
    expect(markup('<svg><filter id="f" color-interpolation-filters="sRGB"></filter></svg>')).toContain(
      'color-interpolation-filters="sRGB"',
    );
  });

  it("keeps ruby", () => {
    expect(markup("<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>")).toBe(
      "<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>",
    );
  });

  it("keeps SVG names in their camelCase", () => {
    const html =
      '<svg viewBox="0 0 100 100"><defs><path id="p" d="M0,50 Q50,0 100,50"/>' +
      '<filter id="w"><feTurbulence baseFrequency="0.02" numOctaves="2"/>' +
      '<feDisplacementMap in="SourceGraphic" scale="8" xChannelSelector="R"/></filter></defs>' +
      '<text filter="url(#w)"><textPath href="#p" startOffset="10%">along</textPath></text></svg>';
    const out = markup(html);
    expect(out).toContain('viewBox="0 0 100 100"');
    expect(out).toContain('<feTurbulence baseFrequency="0.02" numOctaves="2">');
    expect(out).toContain('xChannelSelector="R"');
    expect(out).toContain('<textPath href="#p" startOffset="10%">along</textPath>');
    expect(out).toContain('filter="url(#w)"');
    expect(clean(html).removed).toEqual([]);
  });

  it("keeps xlink:href to a fragment, written with its prefix", () => {
    expect(markup('<svg><use xlink:href="#a"/></svg>')).toBe('<svg><use xlink:href="#a"></use></svg>');
  });

  it("keeps SMIL that animates something harmless", () => {
    expect(
      markup('<svg><rect width="10" height="10"><animate attributeName="x" from="0" to="10" dur="1s"/></rect></svg>'),
    ).toBe(
      '<svg><rect width="10" height="10"><animate attributeName="x" from="0" to="10" dur="1s"></animate></rect></svg>',
    );
  });

  it("keeps an image only when it is a declared asset", () => {
    expect(markup('<img src="asset:photo.png" alt="a">')).toBe('<img src="asset:photo.png" alt="a">');
    expect(markup('<img src="asset:other.png" alt="a">')).toBe('<img alt="a">');
    expect(markup('<svg><feImage href="asset:photo.png"/></svg>')).toBe(
      '<svg><feImage href="asset:photo.png"></feImage></svg>',
    );
  });

  it("filters a style attribute and drops it when nothing survives", () => {
    expect(markup('<p style="color: red; background: url(https://x)">a</p>')).toBe(
      '<p style="color: red">a</p>',
    );
    expect(markup('<p style="transition: all 1s">a</p>')).toBe("<p>a</p>");
  });

  it("keeps text verbatim and escapes it only on the way out", () => {
    const { nodes } = clean("<p>a &lt; b &amp; &quot;c&quot;</p>");
    expect(nodes).toEqual([
      {
        kind: "element",
        tag: "p",
        ns: "html",
        attrs: [],
        children: [{ kind: "text", text: 'a < b & "c"' }],
      },
    ]);
  });
});

describe("bounds", () => {
  it("stops past the depth limit and keeps what came before", () => {
    const deep = "<div>".repeat(MAX_DEPTH + 10) + "x" + "</div>".repeat(MAX_DEPTH + 10);
    const { nodes, removed } = clean("<p>first</p>" + deep);
    expect(serializeSafeNodes(nodes).startsWith("<p>first</p>")).toBe(true);
    expect(removed.some((d) => /nested deeper/.test(d.message))).toBe(true);
  });

  it("stops past the node limit", () => {
    const many = "<span>x</span>".repeat(10_001);
    const { removed } = clean(many);
    expect(removed.some((d) => /more than 20000 nodes/.test(d.message))).toBe(true);
  });

  it("refuses more than the size cap, and never throws", () => {
    expect(clean("x".repeat(512 * 1024 + 1)).nodes).toEqual([]);
    expect(() => sanitizeHtml(undefined as unknown as string, OPTIONS)).not.toThrow();
  });
});
