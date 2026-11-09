import { describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { escapeText, HTML_NS, serializeNode, SVG_NS, wellFormed, XLINK_NS, type NodeLike } from "./snapshotMarkup";

/** A node-shaped tree, built by hand: what the live DOM hands the serialiser. */
function el(
  localName: string,
  attrs: Record<string, string> = {},
  children: NodeLike[] = [],
  namespaceURI: string = HTML_NS,
): NodeLike {
  const list = Object.entries(attrs).map(([name, value]) => ({ name, value }));
  return {
    nodeType: 1,
    nodeValue: null,
    namespaceURI,
    localName,
    attributes: Object.assign(list, { length: list.length }),
    childNodes: Object.assign([...children], { length: children.length }),
  };
}
function text(value: string): NodeLike {
  return { nodeType: 3, nodeValue: value, namespaceURI: null, localName: null, childNodes: { length: 0 } };
}

/** The oracle: an XML parser that shares no code with the serialiser. */
function parse(xml: string) {
  const errors: string[] = [];
  const doc = new DOMParser({
    errorHandler: { warning: () => undefined, error: (m: string) => errors.push(m), fatalError: (m: string) => errors.push(m) },
  }).parseFromString(`<root xmlns="${HTML_NS}">${xml}</root>`, "application/xml");
  return { doc, errors };
}

describe("serializeNode against an XML parser", () => {
  it("round-trips attribute values with newlines, tabs and carriage returns", () => {
    const value = "line one\nline two\ttab\rcr & <amp> \"quoted\"";
    const { doc, errors } = parse(serializeNode(el("span", { "data-x": value })));
    expect(errors).toEqual([]);
    const span = doc.documentElement.firstChild as any;
    expect(span.getAttribute("data-x")).toBe(value);
  });

  it("proves the harness: a naive escape loses the newline", () => {
    const naive = `<span data-x="a\nb"/>`;
    const span = parse(naive).doc.documentElement.firstChild as any;
    expect(span.getAttribute("data-x")).not.toBe("a\nb");
  });

  it("keeps a carriage return in text", () => {
    const { doc } = parse(serializeNode(el("p", {}, [text("a\r\nb")])));
    expect(doc.documentElement.firstChild!.textContent).toBe("a\r\nb");
  });

  it("writes a lone surrogate as U+FFFD and drops forbidden controls, so the document still parses", () => {
    const broken = "ok \ud83d end\u000b \u0001x";
    const { doc, errors } = parse(serializeNode(el("p", { title: broken }, [text(broken)])));
    expect(errors).toEqual([]);
    expect(doc.documentElement.firstChild!.textContent).toBe("ok � end x");
    expect((doc.documentElement.firstChild as any).getAttribute("title")).toBe("ok � end x");
  });

  it("declares the SVG namespace where it starts, and xlink where it is used", () => {
    const tree = el("div", { class: "graphic-root" }, [
      el("svg", { viewBox: "0 0 10 10" }, [
        el("use", { "xlink:href": "#a", "xml:space": "preserve" }, [], SVG_NS),
        el("linearGradient", { id: "g" }, [], SVG_NS),
      ], SVG_NS),
    ]);
    const { doc, errors } = parse(serializeNode(tree));
    expect(errors).toEqual([]);
    const svg = doc.getElementsByTagName("svg")[0] as any;
    expect(svg.namespaceURI).toBe(SVG_NS);
    const use = doc.getElementsByTagName("use")[0] as any;
    expect(use.namespaceURI).toBe(SVG_NS);
    expect(use.getAttributeNS(XLINK_NS, "href")).toBe("#a");
    // camelCase survives: XML is case-sensitive and the SVG engine needs the case.
    expect(doc.getElementsByTagName("linearGradient").length).toBe(1);
  });

  it("writes empty elements self-closed, which an XML document reads as empty", () => {
    expect(serializeNode(el("br"))).toBe("<br/>");
    expect(serializeNode(el("div", {}, [el("span")]))).toBe("<div><span/></div>");
  });

  it("drops an element whose name XML cannot hold, and an attribute likewise", () => {
    expect(serializeNode(el("div", { "bad name": "x", ok: "y" }, [el("1bad")]))).toBe('<div ok="y"/>');
  });

  it("lets the edit rewrite attributes or drop an element", () => {
    const tree = el("div", { style: "color:red" }, [el("animate", { begin: "0s" }, [], SVG_NS), el("b")]);
    const out = serializeNode(tree, (node, attrs) => {
      if (node.localName === "animate") return null;
      return node.localName === "div" ? [...attrs, ["data-cc-i", "0"]] : attrs;
    });
    expect(out).toBe('<div style="color:red" data-cc-i="0"><b/></div>');
  });
});

describe("escaping", () => {
  it("leaves well-formed text alone", () => {
    expect(wellFormed("😀 한글")).toBe("😀 한글");
    expect(escapeText("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });
});
