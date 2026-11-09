import { describe, expect, it } from "vitest";
import { selectAll } from "css-select";
import { parseDocument } from "htmlparser2";
import type { Element } from "domhandler";
import {
  appendStyle,
  clearBox,
  cornerOf,
  degrees,
  integerProperties,
  localUrls,
  maskRules,
  roundedInteger,
} from "./snapshotStyle";

describe("appendStyle", () => {
  it("adds a separator only where one is missing", () => {
    expect(appendStyle("", "a:1;")).toBe("a:1;");
    expect(appendStyle("b:2", "a:1;")).toBe("b:2;a:1;");
    expect(appendStyle("b:2;", "a:1;")).toBe("b:2;a:1;");
    expect(appendStyle("b:2", "")).toBe("b:2");
  });
});

describe("clearBox", () => {
  it("is true only when no background colour or image is drawn", () => {
    expect(clearBox({ backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none" })).toBe(true);
    expect(clearBox({ backgroundColor: "transparent", backgroundImage: "none" })).toBe(true);
    expect(clearBox({ backgroundColor: "color(srgb 1 0 0 / 0)", backgroundImage: "none" })).toBe(true);
    expect(clearBox({ backgroundColor: "rgb(0, 0, 255)", backgroundImage: "none" })).toBe(false);
    expect(clearBox({ backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "linear-gradient(red, blue)" })).toBe(false);
  });
});

describe("cornerOf", () => {
  it("reads px, elliptical and percentage radii against the box", () => {
    expect(cornerOf("8px", 40, 20)).toEqual([8, 8]);
    expect(cornerOf("8px 4px", 40, 20)).toEqual([8, 4]);
    expect(cornerOf("50%", 40, 20)).toEqual([20, 10]);
    expect(cornerOf("0px", 40, 20)).toEqual([0, 0]);
  });
});

describe("localUrls", () => {
  it("turns a computed absolute reference into this document back into a fragment", () => {
    expect(localUrls('url("https://site/app/#f") blur(2px)')).toBe("url(#f) blur(2px)");
    expect(localUrls("url(#f)")).toBe("url(#f)");
    expect(localUrls("blur(2px)")).toBe("blur(2px)");
  });
});

describe("degrees", () => {
  it("reads the angle units computed style can write", () => {
    expect(degrees("180deg")).toBe(180);
    expect(degrees("0.5turn")).toBe(180);
    expect(degrees(`${Math.PI}rad`)).toBeCloseTo(180);
    expect(degrees("200grad")).toBe(180);
  });
});

describe("maskRules against an independent matcher", () => {
  const doc = parseDocument(
    '<cc-host><div id="root"><h1 id="e" data-cc-m="0"><span id="c">G</span></h1><p id="other">x</p></div></cc-host>',
    { xmlMode: true },
  );
  const rules = maskRules("0");
  // Every rule's selector, with its declarations.
  const blocks = [...rules.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selector: m[1], body: m[2] }));
  const matched = (id: string) =>
    blocks.filter((b) => (selectAll(b.selector, doc) as unknown as Element[]).some((el) => el.attribs.id === id));

  it("hides everything but the marked element and its text", () => {
    const visibility = (id: string) =>
      matched(id)
        .map((b) => /visibility:(\w+)/.exec(b.body)?.[1])
        .filter(Boolean)
        .pop();
    expect(visibility("other")).toBe("hidden");
    expect(visibility("root")).toBe("hidden");
    expect(visibility("e")).toBe("visible");
    expect(visibility("c")).toBe("visible");
  });

  it("settles the marked element's own transform, so the mask lands in its own box", () => {
    expect(matched("e").some((b) => b.body.includes("transform:none"))).toBe(true);
    expect(matched("c").some((b) => b.body.includes("transform:none"))).toBe(false);
  });
});

describe("integer properties", () => {
  it("finds the registered <integer> properties, renamed or not", () => {
    const rules =
      '@property --gab12cd34-n { syntax: "<integer>"; inherits: false; initial-value: 0; }' +
      "@property --grow { syntax: '<number>'; inherits: false; initial-value: 0; }" +
      "@property --k {syntax:'<integer>';inherits:true;initial-value:1}";
    expect(integerProperties(rules)).toEqual(["--gab12cd34-n", "--k"]);
  });

  it("rounds only a value that is not already whole", () => {
    expect(roundedInteger(" 1359.4")).toBe("1359");
    expect(roundedInteger("1359.6")).toBe("1360");
    expect(roundedInteger("1359")).toBeNull();
    expect(roundedInteger("calc(1)")).toBeNull();
  });
});
