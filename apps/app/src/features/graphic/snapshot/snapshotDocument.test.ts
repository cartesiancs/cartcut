import { describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { cdata, snapshotSvg, svgDataUrl } from "./snapshotDocument";
import { HOST_TAG } from "./snapshotCss";

const parts = {
  rasterWidth: 1920,
  rasterHeight: 1080,
  outerWidth: 960,
  outerHeight: 540,
  lang: "ko",
  dir: "ltr",
  css: `${HOST_TAG} .a { content: "]]>"; } ${HOST_TAG} .b { &:hover { color: red } } /* < */`,
  body: '<div class="graphic-root"><p class="a">hi</p></div>',
};

function parse(xml: string) {
  const errors: string[] = [];
  const doc = new DOMParser({
    errorHandler: { warning: () => undefined, error: (m: string) => errors.push(m), fatalError: (m: string) => errors.push(m) },
  }).parseFromString(xml, "image/svg+xml");
  return { doc, errors };
}

describe("snapshotSvg", () => {
  it("is a well-formed SVG at the raster size, the graphic scaled up inside it", () => {
    const { doc, errors } = parse(snapshotSvg(parts));
    expect(errors).toEqual([]);
    const svg = doc.documentElement as any;
    expect(svg.getAttribute("width")).toBe("1920");
    expect(svg.getAttribute("height")).toBe("1080");
    expect(svg.getAttribute("viewBox")).toBeFalsy();
    const host = doc.getElementsByTagName(HOST_TAG)[0] as any;
    expect(host.getAttribute("style")).toContain("width:960px;height:540px;transform:scale(2,2)");
    expect(host.getAttribute("lang")).toBe("ko");
  });

  it("carries CSS that holds ]]>, & and < through the parser unchanged", () => {
    const { doc } = parse(snapshotSvg(parts));
    expect(doc.getElementsByTagName("style")[0].textContent).toBe(parts.css);
  });

  it("splits ]]> inside CDATA", () => {
    expect(cdata("a]]>b")).toBe("<![CDATA[a]]]]><![CDATA[>b]]>");
  });

  it("is a data: URL, never blob:", () => {
    const url = svgDataUrl("<svg/>");
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe("<svg/>");
  });
});
