import { describe, it, expect } from "vitest";
import { displayFactorOf, fromDisplay, toDisplay } from "./propertyUnits";
import { ALL_ANIMATABLE_PROPERTIES } from "../../@types/timeline";

describe("displayFactorOf", () => {
  it("is ten for scale", () => {
    expect(displayFactorOf("scale")).toBe(10);
  });

  // The exception has to stay an exception. A second property gaining a factor
  // by accident would silently move the numbers in the panel and on the ruler
  // without moving anything in the document.
  it("is one for every other animatable property", () => {
    for (const property of ALL_ANIMATABLE_PROPERTIES) {
      if (property === "scale") {
        continue;
      }
      expect(displayFactorOf(property), property).toBe(1);
    }
  });

  it("is one for a property it has never heard of", () => {
    expect(displayFactorOf("fx:amount")).toBe(1);
    expect(displayFactorOf("")).toBe(1);
  });
});

describe("toDisplay / fromDisplay", () => {
  it("reads unscaled as 100 percent", () => {
    expect(toDisplay("scale", 10)).toBe(100);
    expect(fromDisplay("scale", 100)).toBe(10);
  });

  it("reads 120 percent as the twelve the track stores", () => {
    expect(toDisplay("scale", 12)).toBe(120);
    expect(fromDisplay("scale", 120)).toBe(12);
  });

  it("is the identity for a property with no factor", () => {
    expect(toDisplay("opacity", 45.3)).toBe(45.3);
    expect(fromDisplay("rotation", -90)).toBe(-90);
  });

  // The panel round-trips through both on every spinner event, so a value that
  // does not survive the pair would drift a little on each mousemove.
  it.each([0, 1, 10, 12.5, 99.9, 1000])("round-trips %d", (value) => {
    expect(fromDisplay("scale", toDisplay("scale", value))).toBeCloseTo(
      value,
      10,
    );
  });
});
