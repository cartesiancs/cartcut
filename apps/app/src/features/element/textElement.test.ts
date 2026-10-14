import { describe, it, expect } from "vitest";
import { createTextElement } from "./textElement";

describe("createTextElement", () => {
  it("writes none of the optional style keys when none are given", () => {
    const element = createTextElement({});
    expect(element.options).toEqual({
      isBold: false,
      isItalic: false,
      align: "left",
      outline: { enable: false, size: 1, color: "#000000" },
    });
    expect(element.background).toEqual({ enable: false, color: "#000000" });
  });

  it("writes nothing for a value equal to its default", () => {
    const element = createTextElement({
      backgroundOpacity: 100,
      backgroundPadding: 12,
      backgroundRadius: 0,
      textTransform: "none",
      outline: { enable: true, size: 4, color: "#ff0000", opacity: 100 },
    });
    expect(element.background).toEqual({ enable: false, color: "#000000" });
    expect("textTransform" in element.options).toBe(false);
    expect("opacity" in element.options.outline).toBe(false);
  });

  it("writes each one that differs", () => {
    const element = createTextElement({
      backgroundEnable: true,
      backgroundOpacity: 40,
      backgroundPadding: 20,
      backgroundRadius: 8,
      textTransform: "uppercase",
      outline: { enable: true, size: 4, color: "#ff0000", opacity: 50 },
    });
    expect(element.background).toEqual({
      enable: true,
      color: "#000000",
      opacity: 40,
      padding: 20,
      radius: 8,
    });
    expect(element.options.textTransform).toBe("uppercase");
    expect(element.options.outline.opacity).toBe(50);
  });
});
