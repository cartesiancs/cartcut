import { describe, expect, it } from "vitest";
import { expandInsetInStyle, expandInsetInStylesheet, insetSides } from "./cssCompat";

describe("insetSides", () => {
  it("follows the margin rule for one to four values", () => {
    expect(insetSides("0")).toEqual(["0", "0", "0", "0"]);
    expect(insetSides("1px 2px")).toEqual(["1px", "2px", "1px", "2px"]);
    expect(insetSides("1px 2px 3px")).toEqual(["1px", "2px", "3px", "2px"]);
    expect(insetSides("1px 2px 3px 4px")).toEqual(["1px", "2px", "3px", "4px"]);
    expect(insetSides("calc(var(--a) * 1px) auto")).toEqual(["calc(var(--a) * 1px)", "auto", "calc(var(--a) * 1px)", "auto"]);
    expect(insetSides("1px 2px 3px 4px 5px")).toBeNull();
  });
});

describe("expandInsetInStylesheet", () => {
  it("writes the longhands in place, keyframes and !important included", () => {
    const out = expandInsetInStylesheet(
      ".stage { position: absolute; inset: 0; display: flex } @keyframes k { to { inset: 10% 0 } } .x { inset: 4px !important }",
    );
    expect(out).toContain("position: absolute; top: 0; right: 0; bottom: 0; left: 0; display: flex");
    expect(out).toContain("to { top: 10%; right: 0; bottom: 10%; left: 0 }");
    expect(out).toContain("top: 4px !important; right: 4px !important; bottom: 4px !important; left: 4px !important");
    expect(out).not.toMatch(/inset\s*:/);
  });

  it("leaves CSS without inset untouched, byte for byte", () => {
    const css = ".a{box-shadow:inset 0 0 2px red}";
    expect(expandInsetInStylesheet(css)).toBe(css);
  });
});

describe("expandInsetInStyle", () => {
  it("rewrites a style attribute", () => {
    expect(expandInsetInStyle("position:absolute;inset:0;color:red")).toBe(
      "position:absolute;top:0;right:0;bottom:0;left:0;color:red",
    );
  });
});
