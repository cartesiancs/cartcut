import { describe, it, expect } from "vitest";
import {
  DEFAULT_BACKGROUND_PADDING,
  displayTextOf,
  resolveTextStyle,
  styleBleed,
  withAlpha,
} from "./style";
import type { TextElementType } from "../../@types/timeline";

/**
 * A text element exactly as `createTextElement` wrote them *before* text
 * effects existed — no `shadow`, no `glow`, no `fill`, no `textOpacity`, and a
 * `background`/`outline` with only the two fields they used to have.
 *
 * This is what comes out of every `.ngt` saved to date, and load applies no
 * migration, so it is the compatibility case that matters.
 */
function legacyText(over: Partial<TextElementType> = {}): TextElementType {
  return {
    filetype: "text",
    text: "Title",
    textcolor: "#ffffff",
    fontsize: 52,
    fontpath: "default",
    fontname: "notosanskr",
    fontweight: "medium",
    fonttype: "otf",
    letterSpacing: 0,
    options: {
      isBold: false,
      isItalic: false,
      align: "left",
      outline: { enable: false, size: 1, color: "#000000" },
    },
    background: { enable: false, color: "#000000" },
    widthInner: 200,
    ...over,
  } as TextElementType;
}

describe("resolveTextStyle on a pre-effects element", () => {
  it("turns every effect off", () => {
    const style = resolveTextStyle(legacyText());

    expect(style.shadow.enable).toBe(false);
    expect(style.glow.enable).toBe(false);
    expect(style.outline.enable).toBe(false);
    expect(style.background.enable).toBe(false);
    expect(style.fill).toEqual({ type: "solid" });
    expect(style.textOpacity).toBe(100);
    expect(style.textTransform).toBe("none");
  });

  it("keeps the padding the renderer used to hard-code", () => {
    // A different default here would silently reflow every existing caption's
    // background box.
    expect(resolveTextStyle(legacyText()).background.padding).toBe(
      DEFAULT_BACKGROUND_PADDING,
    );
    expect(DEFAULT_BACKGROUND_PADDING).toBe(12);
  });

  it("treats a missing outline opacity as fully opaque", () => {
    expect(resolveTextStyle(legacyText()).outline.opacity).toBe(100);
  });

  it("survives an element whose options block is missing entirely", () => {
    const broken = { filetype: "text", text: "x" } as unknown as TextElementType;
    expect(() => resolveTextStyle(broken)).not.toThrow();
    expect(resolveTextStyle(broken).shadow.enable).toBe(false);
  });
});

describe("resolveTextStyle sanitising", () => {
  it("replaces a NaN blur rather than passing it to canvas", () => {
    // An emptied number input writes "" -> NaN. Canvas silently drops the whole
    // shadow on a NaN blur, which reads as "shadows randomly stop working".
    const style = resolveTextStyle(
      legacyText({
        options: {
          ...legacyText().options,
          shadow: {
            enable: true,
            offsetX: 4,
            offsetY: 4,
            blur: Number.NaN,
            color: "#000000",
            opacity: 60,
          },
        },
      } as Partial<TextElementType>),
    );

    expect(Number.isFinite(style.shadow.blur)).toBe(true);
  });

  it("clamps a negative blur, which canvas would throw on", () => {
    const style = resolveTextStyle(
      legacyText({
        options: {
          ...legacyText().options,
          glow: { enable: true, size: -40, color: "#fff", opacity: 80 },
        },
      } as Partial<TextElementType>),
    );

    expect(style.glow.size).toBe(0);
  });

  it("clamps opacity into 0-100", () => {
    const style = resolveTextStyle(
      legacyText({ textOpacity: 480 } as Partial<TextElementType>),
    );
    expect(style.textOpacity).toBe(100);
  });

  it("wraps a gradient angle instead of clamping it", () => {
    const style = resolveTextStyle(
      legacyText({
        fill: { type: "gradient", from: "#fff", to: "#000", angle: 370 },
      } as Partial<TextElementType>),
    );

    expect(style.fill).toMatchObject({ angle: 10 });
  });

  it("falls back to a solid fill when the gradient is half-written", () => {
    const style = resolveTextStyle(
      legacyText({ fill: { type: "solid" } } as Partial<TextElementType>),
    );
    expect(style.fill).toEqual({ type: "solid" });
  });
});

describe("displayTextOf", () => {
  it("passes text through untransformed by default", () => {
    expect(displayTextOf(legacyText({ text: "Hello" }))).toBe("Hello");
  });

  it("applies uppercase", () => {
    const element = legacyText({ text: "Hello" });
    element.options.textTransform = "uppercase";
    expect(displayTextOf(element)).toBe("HELLO");
  });

  it("applies lowercase", () => {
    const element = legacyText({ text: "Hello" });
    element.options.textTransform = "lowercase";
    expect(displayTextOf(element)).toBe("hello");
  });

  it("leaves Hangul alone, which has no case", () => {
    const element = legacyText({ text: "제목 Title" });
    element.options.textTransform = "uppercase";
    expect(displayTextOf(element)).toBe("제목 TITLE");
  });
});

describe("styleBleed", () => {
  it("is a small constant when nothing spills", () => {
    expect(styleBleed(resolveTextStyle(legacyText()))).toBe(2);
  });

  it("covers a shadow's offset plus its blur", () => {
    const element = legacyText();
    element.options.shadow = {
      enable: true,
      offsetX: 10,
      offsetY: 4,
      blur: 20,
      color: "#000000",
      opacity: 60,
    };

    // 10 + 20 = 30, plus the antialiasing slack.
    expect(styleBleed(resolveTextStyle(element))).toBe(32);
  });

  it("counts a negative offset by its magnitude", () => {
    const element = legacyText();
    element.options.shadow = {
      enable: true,
      offsetX: -30,
      offsetY: 0,
      blur: 0,
      color: "#000000",
      opacity: 60,
    };

    expect(styleBleed(resolveTextStyle(element))).toBe(32);
  });

  it("takes only half an outline, since the stroke straddles the glyph", () => {
    const element = legacyText();
    element.options.outline = { enable: true, size: 20, color: "#000000" };

    expect(styleBleed(resolveTextStyle(element))).toBe(12);
  });

  it("ignores an effect that is configured but disabled", () => {
    const element = legacyText();
    element.options.shadow = {
      enable: false,
      offsetX: 100,
      offsetY: 100,
      blur: 100,
      color: "#000000",
      opacity: 60,
    };

    expect(styleBleed(resolveTextStyle(element))).toBe(2);
  });

  it("takes the largest contributor when several are on", () => {
    const element = legacyText();
    element.options.outline = { enable: true, size: 8, color: "#000000" };
    element.options.glow = {
      enable: true,
      size: 40,
      color: "#00e5ff",
      opacity: 80,
    };
    element.options.shadow = {
      enable: true,
      offsetX: 2,
      offsetY: 2,
      blur: 6,
      color: "#000000",
      opacity: 60,
    };

    expect(styleBleed(resolveTextStyle(element))).toBe(42);
  });
});

describe("withAlpha", () => {
  it("returns the colour untouched at full opacity", () => {
    expect(withAlpha("#ff0000", 100)).toBe("#ff0000");
  });

  it("converts six-digit hex to rgba", () => {
    expect(withAlpha("#ff8000", 50)).toBe("rgba(255, 128, 0, 0.5)");
  });

  it("expands three-digit hex", () => {
    expect(withAlpha("#f00", 25)).toBe("rgba(255, 0, 0, 0.25)");
  });

  it("is fully transparent at zero", () => {
    expect(withAlpha("#ffffff", 0)).toBe("rgba(255, 255, 255, 0)");
  });

  it("passes a colour it cannot parse through at full strength", () => {
    // Losing the paint entirely would be worse than losing the opacity.
    expect(withAlpha("rgb(1, 2, 3)", 50)).toBe("rgb(1, 2, 3)");
  });
});
